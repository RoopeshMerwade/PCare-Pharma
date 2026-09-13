-- ════════════════════════════════════════════════════════════════════════════
-- SCHEMA 39: GO-LIVE HARDENING
--
-- Two independent changes, one file, one transaction:
--
--   39.1  create_bill_atomic() refuses a discount larger than the bill, and a
--         batch past its expiry date.
--   39.2  EXECUTE on every function in `public` belongs to service_role only.
--   39.3  The file refuses to commit if anything in `public` is still
--         executable by anon or authenticated.
--
-- Depends on schema-27 (the create_bill_atomic this replaces), schema-26
-- (pharmacy_today) and schema-38 (delete_bills_core, which stays ungranted).
-- Changes no table, view or row. Safe to re-run.
--
-- No API restart needed: nothing here is probed by config/capabilities.js. The
-- API makes both 39.1 checks itself before it calls the RPC; these are the
-- backstop for a check that was raced or bypassed.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 39.1  create_bill_atomic — discount floor and expiry guard ─────────────
--
-- schema-27's function, unchanged except for two refusals. Allocation, ledger
-- writes and the loose-unit path are exactly as they were.
--
-- DISCOUNT_EXCEEDS_TOTAL. bills.discount_amount was only checked for >= 0, and
-- bills_with_totals computes total = subtotal - discount_amount with no floor.
-- Any account that can bill could store a negative sale, and
-- daily_sales_summary and every report summed it like any other.
--
-- EXPIRED_STOCK. This function trusted the batch ids it was handed and never
-- looked at exp_date; the only expiry filter was a JavaScript one, which used
-- the UTC date. pharmacy_today(), not current_date: this database runs in UTC,
-- whose date is still yesterday until 05:30 IST. Checked under the batch lock.
--
-- Customer returns deliberately get no such guard. A customer handing back an
-- expired strip must still be recorded; its stock returns to a batch FEFO will
-- not sell, and refusing the return would only lose the record.
create or replace function public.create_bill_atomic(p_bill jsonb, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill_id uuid;
  v_bill_number text;
  v_item jsonb;
  v_opened int;
  v_subtotal numeric;
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'NO_ITEMS: a bill must have at least one item';
  end if;

  -- Lock every batch being sold (deterministic order to avoid deadlocks).
  -- This covers loose lines too: loose stock is keyed by batch_id, so the
  -- batch row is the one mutex both denominations queue behind.
  perform 1 from public.inventory_batches b
   where b.id in (select (i->>'batch_id')::uuid from jsonb_array_elements(p_items) i)
   order by b.id
   for update;

  -- schema-39: never dispense a batch past its expiry date (IST).
  if exists (
    select 1 from public.inventory_batches b
     where b.id in (select (i->>'batch_id')::uuid from jsonb_array_elements(p_items) i)
       and b.exp_date < public.pharmacy_today()
  ) then
    raise exception 'EXPIRED_STOCK: a batch in this bill is past its expiry date';
  end if;

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

  insert into public.bill_items
    (bill_id, medicine_id, batch_id, qty, unit_price, mrp, is_loose, pack_content_quantity)
  select v_bill_id,
         (i->>'medicine_id')::uuid,
         (i->>'batch_id')::uuid,
         (i->>'qty')::int,
         (i->>'unit_price')::numeric,
         (i->>'mrp')::numeric,
         coalesce((i->>'is_loose')::boolean, false),
         nullif(i->>'content_quantity', '')::int
  from jsonb_array_elements(p_items) i;

  -- schema-39: the discount may not exceed the bill. Same formula as
  -- bills_with_totals, over the lines just written, compared against the
  -- discount as the numeric(10,2) column stores it.
  select coalesce(sum(bi.qty * bi.unit_price), 0) into v_subtotal
    from public.bill_items bi
   where bi.bill_id = v_bill_id;

  if round(coalesce((p_bill->>'discount_amount')::numeric, 0), 2) > v_subtotal then
    raise exception 'DISCOUNT_EXCEEDS_TOTAL: discount % exceeds the bill subtotal %',
      round(coalesce((p_bill->>'discount_amount')::numeric, 0), 2), v_subtotal;
  end if;

  -- Sealed lines: unchanged. prevent_negative_stock fires per row; any
  -- shortfall aborts the whole transaction, bill and items included.
  insert into public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
  select (i->>'batch_id')::uuid,
         -(i->>'qty')::int,
         'sale',
         v_bill_id,
         'Bill: ' || v_bill_number,
         (p_bill->>'created_by')::uuid
  from jsonb_array_elements(p_items) i
  where not coalesce((i->>'is_loose')::boolean, false);

  -- Loose lines, in physical order: break the strips FIRST so the tablets
  -- exist before they are sold. Inverting these two would trip
  -- prevent_negative_loose_stock on a batch with no prior loose balance —
  -- correctly, since selling a tablet you have not yet freed is not a thing
  -- that can happen at a counter either.
  for v_item in
    select value from jsonb_array_elements(p_items)
    where coalesce((value->>'is_loose')::boolean, false)
  loop
    v_opened := coalesce((v_item->>'strips_to_open')::int, 0);

    if v_opened > 0 then
      insert into public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
      values ((v_item->>'batch_id')::uuid, -v_opened, 'strip_opened', v_bill_id,
              'Opened ' || v_opened || ' for loose dispensing · Bill: ' || v_bill_number,
              (p_bill->>'created_by')::uuid);

      insert into public.loose_unit_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
      values ((v_item->>'batch_id')::uuid,
              v_opened * (v_item->>'content_quantity')::int,
              'strip_opened', v_bill_id,
              'Opened ' || v_opened || ' × ' || (v_item->>'content_quantity') ||
                ' · Bill: ' || v_bill_number,
              (p_bill->>'created_by')::uuid);
    end if;

    insert into public.loose_unit_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
    values ((v_item->>'batch_id')::uuid, -(v_item->>'qty')::int, 'sale', v_bill_id,
            'Bill: ' || v_bill_number, (p_bill->>'created_by')::uuid);
  end loop;

  return v_bill_id;
end; $$;


-- ── 39.2  Function privileges: service_role only ───────────────────────────
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC, and anon and
-- authenticated belong to PUBLIC. schema-22, -23 and -27 revoked only from
-- anon, which takes away nothing anon still inherits; other functions were
-- never revoked at all. Checked against the live project on 2026-09-13 with
-- the anon key: match_medicines_trgm returned catalogue rows, and is_owner
-- answered. Nothing had revoked the next_*_number() functions either, the
-- ones that advance bill and purchase numbering.
--
-- So this is not another hand-kept list. It walks every function in `public`
-- that does not belong to an extension, revokes from PUBLIC, anon and
-- authenticated, and grants service_role, the only role the API uses.
-- service_role needs its OWN grant rather than PUBLIC's: functions used inside
-- views and column defaults (is_countable_content, pharmacy_today) are checked
-- against the role running the query.
--
-- Extension functions (pg_trgm's similarity() and friends) are skipped: they
-- read no data and are not this schema's to re-permission.
--
-- delete_bills_core is revoked and NOT granted back. schema-38 leaves it
-- callable by no role, service_role included, so the owner check in
-- delete_bill_atomic / delete_bills_in_range_atomic cannot be walked around.
--
-- A function added by a later file is not covered by this pass. Revoke from
-- PUBLIC in that file (not only from anon), or re-run this one; 39.3 names
-- anything left exposed.
do $$
declare
  f record;
begin
  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass
            and d.objid = p.oid
            and d.deptype = 'e'
       )
  loop
    execute format('revoke all on routine public.%I(%s) from public, anon, authenticated',
                   f.proname, f.args);
    if f.proname <> 'delete_bills_core' then
      execute format('grant execute on routine public.%I(%s) to service_role',
                     f.proname, f.args);
    end if;
  end loop;
end $$;


-- ── 39.3  Refuse to commit if anything is still reachable from outside ─────
do $$
declare
  v_exposed text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and not exists (
       select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
     )
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if v_exposed is not null then
    raise exception 'schema-39: still executable by anon or authenticated: %', v_exposed;
  end if;
end $$;

commit;
