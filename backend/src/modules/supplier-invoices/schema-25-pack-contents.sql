-- ============================================================
-- MODULE 23 (cont.) — PACK CONTENTS, AND THE DENOMINATION FIX
--
-- Run AFTER schema-24-invoice-line-detail.sql.
--
-- WHY THIS EXISTS — the most important migration in this module
--
-- Modules 23/24 treated the Pack column as a MULTIPLIER on stock:
--
--     stock taken in = (qty_billed + qty_free) × pack_size
--
-- It is not a multiplier. It is a description of what is INSIDE one saleable
-- unit. Verified across every legible line of MEDICO M002948 and M002277 —
-- 18 lines, six pack shapes, one identity holding on all of them:
--
--     qty_billed × printed_rate = line_total
--
-- The rate applies to ONE invoice-Qty unit, and that unit is the thing on the
-- shelf. So:
--
--     "100'S" qty 5  → 5 STRIPS   at ₹103.12 each   NOT 500 tablets
--     "100ML" qty 6  → 6 BOTTLES  at ₹68.74  each   NOT 600 bottles
--     "30GM"  qty 5  → 5 TUBES    at ₹58.43  each   NOT 150 tubes
--     "120MD" qty 2  → 2 INHALERS at ₹285.11 each   NOT 240 inhalers
--     "7X2ML" qty 20 → 20 PACKS   at ₹45.01  each   NOT 140 packs
--
-- WHY IT MATTERED MORE THAN AN ARITHMETIC SLIP
--
-- `pack_size` exists nowhere outside this module. Billing, FEFO, returns and
-- adjustments all move inventory_ledger.change_qty in the denomination named by
-- medicines.unit — strips, bottles, tubes, vials. Multiplying at import posts a
-- quantity in a DIFFERENT denomination into that shared ledger: LIV 52 TAB
-- would land 500 where every other module means 5, and FEFO would then sell
-- strips that do not exist. Silent stock corruption, not a rounding error.
--
-- WHAT ALSO GOES AWAY
--
-- `rate_basis` was introduced in schema-24 to decide whether a rate was quoted
-- per pack or per unit. With the Pack column out of the money entirely there is
-- no such question — the rate is always per Qty unit, because that is what a
-- rate on an invoice is. The column is dropped along with the machinery that
-- filled it.
--
-- SAFETY
--
-- No Supabase project has been provisioned and this module has never been run
-- against one, so there are no imported rows to reconcile. Were there any, the
-- corrective step would be to re-derive NEEDS_REVIEW drafts and leave IMPORTED
-- records untouched as historical fact.
-- ============================================================

-- ── 25.1  Pack contents, replacing pack_size ─────────────────────────────

alter table public.supplier_invoice_items
  -- What ONE Qty unit physically is: STRIP, BOTTLE, TUBE, VIAL, INHALER, PACK.
  -- Derived from the product description first and the pack shape second; falls
  -- back to PACK rather than inventing a container.
  add column if not exists sale_unit          text,

  -- What is inside one saleable unit: 100 PIECE, 100 ML, 30 GM, 120 DOSE.
  -- Informational. Shown to the reviewer, carried for traceability, and never
  -- multiplied into stock or money.
  add column if not exists content_quantity   numeric(12,3) check (content_quantity >= 0),
  add column if not exists content_unit       text,

  -- Nested packaging, never flattened: "7X2ML" is 7 ampoules of 2ml inside one
  -- saleable pack. The rate belongs to the whole expression.
  add column if not exists sub_pack_quantity  numeric(12,3) check (sub_pack_quantity >= 0),
  add column if not exists sub_pack_unit      text,

  -- False when the Pack column could not be read as a quantity plus a unit.
  -- Drives the advisory PACK_UNPARSEABLE. Advisory and not blocking, because
  -- an unreadable pack description cannot make an import wrong any more — it
  -- only leaves the shelf label incomplete.
  add column if not exists pack_recognised    boolean;

comment on column public.supplier_invoice_items.sale_unit is
  'What one qty_billed unit is on the shelf. The denomination inventory_ledger is counted in.';
comment on column public.supplier_invoice_items.content_quantity is
  'What is inside one saleable unit. INFORMATIONAL — never multiplied into stock or money.';
comment on column public.supplier_invoice_items.unit_cost is
  'Cost of ONE SALEABLE UNIT, net of discount_pct. Copied to inventory_batches on commit.';
comment on column public.supplier_invoice_items.mrp is
  'MRP of ONE SALEABLE UNIT, exactly as printed. No conversion, no discount.';

-- ── 25.2  Backfill the money columns ─────────────────────────────────────
--
-- schema-24 stored unit_cost divided by pack_size. Undo that division and apply
-- the discount to the printed rate directly. Drafts only; an IMPORTED invoice is
-- a permanent record of a decision already taken.

update public.supplier_invoice_items sii
   set unit_cost = round(sii.printed_rate * (1 - coalesce(sii.discount_pct, 0) / 100.0), 2),
       mrp       = sii.printed_mrp
  from public.supplier_invoices si
 where si.id = sii.invoice_id
   and si.status = 'NEEDS_REVIEW'
   and sii.printed_rate is not null;

-- ── 25.3  Drop the basis machinery ───────────────────────────────────────
--
-- Nothing reads these any more. Dropped rather than left in place: a stale
-- column that once meant something is how a later reader reintroduces the bug.

alter table public.supplier_invoice_items
  drop column if exists rate_basis,
  drop column if exists pack_size;

-- ── 25.4  Stock unit: revert 'tablets' ───────────────────────────────────
--
-- schema-24 added 'tablets' on the assumption that inventory counted loose
-- tablets. It counts saleable units, so the original list was right all along.
-- Guarded: only narrows the constraint if nothing is actually using 'tablets'.

do $$
begin
  if exists (select 1 from public.medicines where unit = 'tablets') then
    raise notice 'medicines.unit = ''tablets'' is in use; leaving the CHECK permissive. Re-catalogue those rows as ''strips'' and re-run this block.';
  else
    alter table public.medicines drop constraint if exists medicines_unit_check;
    alter table public.medicines add constraint medicines_unit_check
      check (unit in ('strips', 'vials', 'bottles', 'tubes', 'packs', 'pcs'));
  end if;
end $$;

-- ── 25.5  commit_supplier_invoice — the denomination fix ─────────────────
--
-- Replaced in full. The ONLY behavioural change is v_units:
--
--     was:  (qty_billed + qty_free) * pack_size
--     now:  (qty_billed + qty_free)
--
-- Every guard is otherwise identical to schema-23 §23.6. Kept in full rather
-- than patched so this file is the whole current definition of the function.

create or replace function public.commit_supplier_invoice(p_invoice_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv       public.supplier_invoices%rowtype;
  v_item      public.supplier_invoice_items%rowtype;
  v_purchase_id uuid;
  v_purchase_number text;
  v_batch_id  uuid;
  v_units     int;
  v_line_count int := 0;
begin
  select * into v_inv from public.supplier_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND';
  end if;
  if v_inv.status <> 'NEEDS_REVIEW' then
    raise exception 'INVALID_STATUS: only invoices under review can be imported';
  end if;
  if v_inv.supplier_id is null then
    raise exception 'SUPPLIER_REQUIRED: link the invoice to a supplier before importing';
  end if;
  if v_inv.invoice_no is null or trim(v_inv.invoice_no) = '' then
    raise exception 'INVOICE_NO_REQUIRED: the invoice number is needed for the audit trail';
  end if;

  select count(*) into v_line_count
  from public.supplier_invoice_items
  where invoice_id = p_invoice_id and not is_excluded;
  if v_line_count = 0 then
    raise exception 'NO_ITEMS: every line is excluded — there is nothing to take into stock';
  end if;

  v_purchase_number := public.next_purchase_number();

  insert into public.purchases
    (purchase_number, supplier_id, status, notes, received_at, received_by, created_by)
  values
    (v_purchase_number, v_inv.supplier_id, 'received',
     'Imported from supplier invoice ' || v_inv.invoice_no ||
       coalesce(' dated ' || to_char(v_inv.invoice_date, 'DD Mon YYYY'), ''),
     now(), p_user_id, p_user_id)
  returning id into v_purchase_id;

  for v_item in
    select * from public.supplier_invoice_items
     where invoice_id = p_invoice_id and not is_excluded
     order by line_no
  loop
    if v_item.medicine_id is null then
      raise exception 'UNMAPPED_ITEM: line % is not linked to a catalogue medicine', v_item.line_no;
    end if;
    if v_item.batch_no is null or trim(v_item.batch_no) = '' then
      raise exception 'MISSING_BATCH: line % has no batch number', v_item.line_no;
    end if;
    if v_item.exp_date is null then
      raise exception 'MISSING_EXPIRY: line % has no expiry date', v_item.line_no;
    end if;
    if v_item.exp_date <= current_date then
      raise exception 'EXPIRED_ITEM: line % has already expired and cannot be taken into stock', v_item.line_no;
    end if;
    if v_item.mfg_date is not null and v_item.mfg_date >= v_item.exp_date then
      raise exception 'INVALID_DATES: line % is manufactured on or after its expiry', v_item.line_no;
    end if;
    if coalesce(v_item.mrp, 0) <= 0 then
      raise exception 'MISSING_MRP: line % has no MRP', v_item.line_no;
    end if;
    if v_item.unit_cost is null then
      raise exception 'MISSING_COST: line % has no purchase cost', v_item.line_no;
    end if;
    if v_item.unit_cost > v_item.mrp then
      raise exception 'COST_EXCEEDS_MRP: line % costs more than its MRP', v_item.line_no;
    end if;
    if coalesce(v_item.selling_price, 0) <= 0 then
      raise exception 'MISSING_SELLING_PRICE: line % has no selling price', v_item.line_no;
    end if;
    if v_item.selling_price > v_item.mrp then
      raise exception 'PRICE_EXCEEDS_MRP: selling price cannot exceed MRP';
    end if;

    -- THE FIX. Saleable units, the denomination inventory_ledger is counted in.
    -- The pack contents describe what is inside each unit and take no part here.
    v_units := coalesce(v_item.qty_billed, 0) + coalesce(v_item.qty_free, 0);
    if v_units <= 0 then
      raise exception 'MISSING_QTY: line % has no quantity', v_item.line_no;
    end if;

    insert into public.inventory_batches
      (medicine_id, batch_no, exp_date, mfg_date, unit_cost, mrp, selling_price,
       supplier_id, po_id, created_by)
    values
      (v_item.medicine_id, upper(trim(v_item.batch_no)), v_item.exp_date, v_item.mfg_date,
       v_item.unit_cost, v_item.mrp, v_item.selling_price,
       v_inv.supplier_id, v_purchase_id, p_user_id)
    returning id into v_batch_id;

    insert into public.inventory_ledger
      (batch_id, change_qty, reason, ref_id, note, created_by)
    values
      (v_batch_id, v_units, 'purchase_receipt', v_purchase_id,
       'Invoice ' || v_inv.invoice_no || ' · line ' || v_item.line_no ||
         coalesce(' · ' || v_item.pack_raw, ''), p_user_id);

    insert into public.purchase_items
      (purchase_id, medicine_id, qty_ordered, unit_cost, qty_received,
       batch_no, batch_id, mrp, selling_price, exp_date, mfg_date)
    values
      (v_purchase_id, v_item.medicine_id, v_units, v_item.unit_cost, v_units,
       upper(trim(v_item.batch_no)), v_batch_id, v_item.mrp, v_item.selling_price,
       v_item.exp_date, v_item.mfg_date);
  end loop;

  update public.supplier_invoices
     set status      = 'IMPORTED',
         purchase_id = v_purchase_id,
         approved_by = p_user_id,
         approved_at = now()
   where id = p_invoice_id;

  return v_purchase_id;
end; $$;

revoke execute on function public.commit_supplier_invoice(uuid, uuid) from anon;

-- ── 25.6  View refresh ───────────────────────────────────────────────────
-- `select si.*` does not pick up columns added after the view was created, and
-- the view must also stop referencing anything dropped above.

create or replace view public.supplier_invoices_with_counts as
select
  si.*,
  s.name as supplier_name,
  u.full_name as uploaded_by_name,
  a.full_name as approved_by_name,
  p.purchase_number,
  coalesce(i.line_count, 0)     as line_count,
  coalesce(i.unmapped_count, 0) as unmapped_count,
  coalesce(i.excluded_count, 0) as excluded_count,
  coalesce(i.item_error_count, 0) as item_error_count,
  coalesce(i.lines_total, 0)    as lines_total,
  (
    select count(*) from jsonb_array_elements(si.validation_warnings) w
    where w->>'severity' = 'error'
  )::int + coalesce(i.item_error_count, 0) as blocking_error_count
from public.supplier_invoices si
left join public.suppliers s on s.id = si.supplier_id
left join public.users     u on u.id = si.uploaded_by
left join public.users     a on a.id = si.approved_by
left join public.purchases p on p.id = si.purchase_id
left join lateral (
  select
    count(*)::int                                          as line_count,
    count(*) filter (
      where sii.medicine_id is null and not sii.is_excluded
    )::int                                                 as unmapped_count,
    count(*) filter (where sii.is_excluded)::int           as excluded_count,
    coalesce(sum((
      select count(*) from jsonb_array_elements(sii.warnings) w
      where w->>'severity' = 'error'
    )) filter (where not sii.is_excluded), 0)::int         as item_error_count,
    coalesce(sum(
      coalesce(sii.qty_billed, 0) * coalesce(sii.unit_cost, 0)
    ) filter (where not sii.is_excluded), 0)::numeric(12,2) as lines_total
  from public.supplier_invoice_items sii
  where sii.invoice_id = si.id
) i on true;
