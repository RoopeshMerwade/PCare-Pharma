-- ============================================================
-- MODULE 22 — ATOMIC WORKFLOW FUNCTIONS
-- Run AFTER all other migrations (see docs/MIGRATION-ORDER.md).
--
-- Why: supabase-js talks to PostgREST over HTTP — there is no client-side
-- transaction. Every multi-write workflow (bill create, purchase receive,
-- return approve/send) previously did sequential inserts from Node with
-- manual "rollback" deletes; a mid-flow failure left partial state (e.g. a
-- bill with no ledger entries). These functions move each workflow into a
-- single Postgres transaction: all writes commit together or not at all.
--
-- Concurrency: each function locks the touched inventory_batches rows
-- (FOR UPDATE) before writing ledger entries, so the prevent_negative_stock
-- trigger's SUM() check is race-free — two concurrent sales of the last
-- strip serialize instead of both passing the check.
--
-- Existing triggers (prevent_negative_stock, block_ledger_mutation,
-- check constraints) still fire inside these functions — the DB remains
-- the final authority on every invariant.
-- ============================================================

-- ── 22.1 CREATE BILL (Modules 09+10)
-- p_bill:  {customer_name, customer_phone, customer_id, payment_mode,
--           payment_status, discount_amount, notes, created_by}
-- p_items: [{medicine_id, batch_id, qty, unit_price, mrp}]  (FEFO-resolved by API)
create or replace function public.create_bill_atomic(p_bill jsonb, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill_id uuid;
  v_bill_number text;
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'NO_ITEMS: a bill must have at least one item';
  end if;

  -- Lock every batch being sold (deterministic order to avoid deadlocks)
  perform 1 from public.inventory_batches b
   where b.id in (select (i->>'batch_id')::uuid from jsonb_array_elements(p_items) i)
   order by b.id
   for update;

  v_bill_number := public.next_bill_number();

  insert into public.bills
    (bill_number, customer_name, customer_phone, customer_id, payment_mode,
     payment_status, discount_amount, notes, created_by)
  values
    (v_bill_number,
     coalesce(nullif(trim(p_bill->>'customer_name'), ''), 'Walk-in Customer'),
     nullif(trim(coalesce(p_bill->>'customer_phone', '')), ''),
     nullif(p_bill->>'customer_id', '')::uuid,
     p_bill->>'payment_mode',
     coalesce(nullif(p_bill->>'payment_status', ''), 'paid'),
     coalesce((p_bill->>'discount_amount')::numeric, 0),
     nullif(trim(coalesce(p_bill->>'notes', '')), ''),
     (p_bill->>'created_by')::uuid)
  returning id into v_bill_id;

  insert into public.bill_items (bill_id, medicine_id, batch_id, qty, unit_price, mrp)
  select v_bill_id,
         (i->>'medicine_id')::uuid,
         (i->>'batch_id')::uuid,
         (i->>'qty')::int,
         (i->>'unit_price')::numeric,
         (i->>'mrp')::numeric
  from jsonb_array_elements(p_items) i;

  -- Negative ledger entries — prevent_negative_stock trigger fires per row;
  -- any shortfall aborts the whole transaction (bill + items included).
  insert into public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
  select (i->>'batch_id')::uuid,
         -(i->>'qty')::int,
         'sale',
         v_bill_id,
         'Bill: ' || v_bill_number,
         (p_bill->>'created_by')::uuid
  from jsonb_array_elements(p_items) i;

  return v_bill_id;
end; $$;

-- ── 22.2 APPROVE CUSTOMER RETURN (Module 12)
-- Claims the pending row first (conditional UPDATE), which makes concurrent
-- double-approval impossible: the second caller matches 0 rows and errors.
create or replace function public.approve_customer_return_atomic(p_return_id uuid, p_user_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed int;
  v_return_number text;
  v_refund numeric;
begin
  update public.customer_returns
     set status = 'approved', approved_by = p_user_id, approved_at = now()
   where id = p_return_id and status = 'pending';
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    raise exception 'INVALID_STATUS: only pending returns can be approved';
  end if;

  select return_number into v_return_number
    from public.customer_returns where id = p_return_id;

  -- Ensure cumulative returned quantity for any bill item does not exceed sold quantity
  if exists (
    select 1
    from public.customer_return_items cri
    join public.bill_items bi on bi.id = cri.bill_item_id
    where cri.return_id = p_return_id
      and (
        select coalesce(sum(other_cri.qty_returned), 0)
        from public.customer_return_items other_cri
        join public.customer_returns other_cr on other_cr.id = other_cri.return_id
        where other_cri.bill_item_id = bi.id
          and other_cr.status = 'approved'
      ) > bi.qty
  ) then
    raise exception 'QTY_EXCEEDS_SOLD: total returned quantity exceeds quantity sold on the bill';
  end if;

  perform 1 from public.inventory_batches b
   where b.id in (select batch_id from public.customer_return_items where return_id = p_return_id)
   order by b.id
   for update;

  insert into public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
  select batch_id, qty_returned, 'return_inward', p_return_id,
         'Customer return: ' || v_return_number, p_user_id
  from public.customer_return_items
  where return_id = p_return_id;

  select coalesce(sum(qty_returned * unit_price), 0) into v_refund
    from public.customer_return_items where return_id = p_return_id;

  update public.customer_returns set refund_amount = v_refund where id = p_return_id;

  return v_refund;
end; $$;

-- ── 22.3 SEND SUPPLIER RETURN (Module 13)
-- Claims draft → sent, posts outward ledger, and stores the debit note
-- amount on the return row itself. (The old code wrote the debit note to a
-- "billing_cycles" table that does not exist in any migration — the insert
-- failed silently on every send.)
create or replace function public.send_supplier_return_atomic(p_return_id uuid, p_user_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed int;
  v_return_number text;
  v_debit numeric;
begin
  update public.supplier_returns
     set status = 'sent'
   where id = p_return_id and status = 'draft';
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    raise exception 'INVALID_STATUS: only draft returns can be sent';
  end if;

  select return_number into v_return_number
    from public.supplier_returns where id = p_return_id;

  perform 1 from public.inventory_batches b
   where b.id in (select batch_id from public.supplier_return_items where return_id = p_return_id)
   order by b.id
   for update;

  insert into public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
  select batch_id, -qty_returned, 'return_outward', p_return_id,
         'Supplier return: ' || v_return_number, p_user_id
  from public.supplier_return_items
  where return_id = p_return_id;

  select coalesce(sum(qty_returned * unit_cost), 0) into v_debit
    from public.supplier_return_items where return_id = p_return_id;

  update public.supplier_returns set debit_note_amount = v_debit where id = p_return_id;

  return v_debit;
end; $$;

-- ── 22.4 RECEIVE PURCHASE (Modules 07+08)
-- p_items: [{purchase_item_id, batch_no, qty_received, exp_date,
--            mfg_date?, mrp?, selling_price?}]
create or replace function public.receive_purchase_atomic(p_purchase_id uuid, p_user_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchases%rowtype;
  v_item jsonb;
  v_po_item public.purchase_items%rowtype;
  v_batch_id uuid;
  v_mrp numeric;
  v_sp numeric;
begin
  select * into v_po from public.purchases where id = p_purchase_id for update;
  if not found then
    raise exception 'PURCHASE_NOT_FOUND';
  end if;
  if v_po.status <> 'sent' then
    raise exception 'INVALID_STATUS: only sent orders can be received';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'NO_ITEMS: receipt items are required';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_po_item from public.purchase_items
     where id = (v_item->>'purchase_item_id')::uuid and purchase_id = p_purchase_id;
    if not found then
      raise exception 'ITEM_NOT_FOUND: purchase item % not on this order', v_item->>'purchase_item_id';
    end if;

    v_sp  := coalesce(nullif(v_item->>'selling_price', '')::numeric, v_po_item.unit_cost);
    v_mrp := coalesce(nullif(v_item->>'mrp', '')::numeric, v_sp);
    if v_sp > v_mrp then
      raise exception 'PRICE_EXCEEDS_MRP: selling price cannot exceed MRP';
    end if;

    insert into public.inventory_batches
      (medicine_id, batch_no, exp_date, mfg_date, unit_cost, mrp, selling_price,
       supplier_id, po_id, created_by)
    values
      (v_po_item.medicine_id,
       upper(trim(v_item->>'batch_no')),
       (v_item->>'exp_date')::date,
       nullif(v_item->>'mfg_date', '')::date,
       v_po_item.unit_cost, v_mrp, v_sp,
       v_po.supplier_id, p_purchase_id, p_user_id)
    returning id into v_batch_id;
    -- duplicate (medicine_id, batch_no) raises unique_violation 23505,
    -- which the API maps to DUPLICATE_BATCH and the whole receipt rolls back.

    insert into public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
    values (v_batch_id, (v_item->>'qty_received')::int, 'purchase_receipt',
            p_purchase_id, 'PO: ' || v_po.purchase_number, p_user_id);

    update public.purchase_items
       set qty_received  = (v_item->>'qty_received')::int,
           batch_no      = upper(trim(v_item->>'batch_no')),
           batch_id      = v_batch_id,
           mrp           = v_mrp,
           selling_price = v_sp,
           exp_date      = (v_item->>'exp_date')::date,
           mfg_date      = nullif(v_item->>'mfg_date', '')::date
     where id = v_po_item.id;
  end loop;

  update public.purchases
     set status = 'received', received_at = now(), received_by = p_user_id
   where id = p_purchase_id;
end; $$;

-- These run with definer rights; API calls them via the service-role client.
revoke execute on function public.create_bill_atomic(jsonb, jsonb) from anon;
revoke execute on function public.approve_customer_return_atomic(uuid, uuid) from anon;
revoke execute on function public.send_supplier_return_atomic(uuid, uuid) from anon;
revoke execute on function public.receive_purchase_atomic(uuid, uuid, jsonb) from anon;
