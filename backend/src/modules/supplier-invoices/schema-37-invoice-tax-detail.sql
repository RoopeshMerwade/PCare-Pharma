-- ============================================================
-- MODULE 23 (cont.) — INVOICE TAX DETAIL, DOCUMENT HEADER, PARTY SNAPSHOTS
--
-- Run AFTER schema-36-notification-dismissals.sql (it is the new last step;
-- see docs/MIGRATION-ORDER.md). Depends only on schema-23/24/25 for the two
-- tables it alters.
--
-- Purely additive. No column is dropped, no existing value is rewritten, and
-- every new column is nullable except `invoice_type`, which takes a DEFAULT
-- that is exactly what every pre-migration row already was. An IMPORTED
-- invoice from before this file keeps NULLs here and stays a valid permanent
-- record of what became stock.
--
-- WHY THIS EXISTS
--
-- Module 23 modelled a distributor invoice as a COSTING document: what did one
-- saleable unit cost, net of discount. That is all the ledger needs, and it is
-- deliberately all this module captured — a GST-registered pharmacy reclaims
-- input tax, so tax is not a cost and never enters `unit_cost`.
--
-- Real vendor invoices carry a second document inside the first: a TAX
-- document, with a per-line CGST/SGST/IGST/CESS breakdown, an HSN-wise summary
-- grouped by rate, and a payable that is not the taxable total. None of that
-- could be represented. Three columns existed and were transcription-only:
--
--   taxable_total   read by two advisory reconciliations
--   gst_total       a single lump — "CGST + SGST + IGST + cess"
--   gst_pct         read by NOTHING at all
--
-- This migration adds the representation. It does NOT add a second costing
-- model: `unit_cost` still means what it meant, is still derived the same way,
-- and is still the only figure copied into `inventory_batches`.
--
-- THE RULE THIS FILE MOST NEEDS TO GET RIGHT — printed beats derived.
--
-- Every money column below holds what the VENDOR PRINTED. Nothing here is
-- computed at write time. The API derives its own slab rollup from the lines
-- and reconciles the two as WARNINGS, exactly as `printed_rate` and
-- `unit_cost` are already kept apart one level down. Overwriting a printed
-- total with a computed one is how a ₹0.04 disagreement with the vendor's own
-- filing becomes invisible — and the printed figure is the one the pharmacy
-- pays against and the one a GST officer compares.
--
-- TWO COLUMNS ARE DELIBERATELY SIGNED
--
-- `round_off` and `adjustment_amount` carry no `>= 0` CHECK. MEDICO M002948's
-- round-off is −0.21: taxable 10327.05 + GST 1263.16 = 11590.21, printed net
-- 11590.00. A non-negative constraint would make the commonest real value
-- unstorable. Every other money column keeps the `>= 0` discipline the rest of
-- this schema uses.
-- ============================================================

-- ── 37.1  Document header ────────────────────────────────────────────────
--
-- invoice_type and payment_type are SEPARATE AXES and must stay that way.
-- "CREDIT" in a payment-terms column means the pharmacy has not paid yet. It
-- does not mean the document is a credit note. Collapsing the two would make
-- every unpaid delivery look like a return, which is a stock movement in the
-- opposite direction.

alter table public.supplier_invoices
  add column if not exists invoice_type text not null default 'TAX_INVOICE'
    check (invoice_type in ('TAX_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  add column if not exists payment_type text
    check (payment_type is null or payment_type in ('CASH', 'CREDIT')),

  -- Time is its own column rather than folded into invoice_date: the date is
  -- what the purchase record is dated by and what FEFO reporting groups on,
  -- and a timestamptz here would drag every existing date through a timezone
  -- conversion it has never needed.
  add column if not exists invoice_time      time,
  add column if not exists due_date          date,
  add column if not exists transaction_date  date,
  add column if not exists order_number      text,
  add column if not exists order_date        date,
  add column if not exists lr_number         text,
  add column if not exists lr_date           date,
  add column if not exists page_number       int check (page_number is null or page_number > 0),
  add column if not exists total_pages       int check (total_pages is null or total_pages > 0),
  add column if not exists sales_executive   text,

  -- ── Vendor snapshot. `supplier_*` is this table's existing prefix
  -- (supplier_name_raw, supplier_gstin, supplier_dl_no, supplier_phone), so
  -- the new party fields join it rather than introducing a second `vendor_*`
  -- vocabulary for the same party.
  --
  -- These are a SNAPSHOT of the letterhead, not a mirror of `suppliers`. A
  -- distributor that moves premises must not retroactively change the address
  -- printed on an invoice already received — the same reason bill_items
  -- snapshots unit_price.
  add column if not exists supplier_address    text,
  add column if not exists supplier_pan        text,
  add column if not exists supplier_email      text,
  add column if not exists supplier_state      text,
  add column if not exists supplier_state_code text,

  -- ── Buyer snapshot: this pharmacy, as the vendor printed it. Worth keeping
  -- separately from pharmacy_settings for the same reason — and because a
  -- mismatch between the two is itself a finding (goods billed to the wrong
  -- branch or the wrong GSTIN).
  add column if not exists buyer_name       text,
  add column if not exists buyer_address    text,
  add column if not exists buyer_gstin      text,
  add column if not exists buyer_pan        text,
  add column if not exists buyer_dl_no      text,
  add column if not exists buyer_phone      text,
  add column if not exists buyer_state      text,
  add column if not exists buyer_state_code text,

  -- ── Printed money. All transcribed; none derived here.
  --
  -- Note what is NOT added: there is no `net_payable`, because `net_total`
  -- already means exactly that ("Final net payable amount" in the extraction
  -- schema); no `taxable_amount`, because `taxable_total` is it; and no
  -- `total_tax`, because `gst_total` is it. Adding synonyms would give the
  -- reconciliation two columns to disagree about.
  add column if not exists subtotal          numeric(12,2) check (subtotal is null or subtotal >= 0),
  add column if not exists total_discount    numeric(12,2) check (total_discount is null or total_discount >= 0),
  add column if not exists total_cgst        numeric(12,2) check (total_cgst is null or total_cgst >= 0),
  add column if not exists total_sgst        numeric(12,2) check (total_sgst is null or total_sgst >= 0),
  add column if not exists total_igst        numeric(12,2) check (total_igst is null or total_igst >= 0),
  add column if not exists total_cess        numeric(12,2) check (total_cess is null or total_cess >= 0),
  add column if not exists invoice_total     numeric(12,2) check (invoice_total is null or invoice_total >= 0),
  add column if not exists additional_amount numeric(12,2) check (additional_amount is null or additional_amount >= 0),
  add column if not exists deduction_amount  numeric(12,2) check (deduction_amount is null or deduction_amount >= 0),

  -- Signed. See the header note.
  add column if not exists adjustment_amount numeric(12,2),
  add column if not exists round_off         numeric(12,2);

comment on column public.supplier_invoices.invoice_type is
  'TAX_INVOICE | CREDIT_NOTE | DEBIT_NOTE. Independent of payment_type. Only a TAX_INVOICE may be committed to stock — commit_supplier_invoice() refuses the others.';
comment on column public.supplier_invoices.payment_type is
  'CASH | CREDIT — the vendor''s payment terms. "CREDIT" here NEVER means credit note.';
comment on column public.supplier_invoices.net_total is
  'Final net payable exactly as printed. Not derived; the API computes its own and reconciles the two as a warning.';
comment on column public.supplier_invoices.gst_total is
  'Total tax as printed (CGST + SGST + IGST + cess). The components live in total_cgst/sgst/igst/cess and per line.';
comment on column public.supplier_invoices.round_off is
  'Signed. Negative is normal: taxable + tax is rounded DOWN to the payable more often than up.';

-- ── 37.2  Line detail ────────────────────────────────────────────────────
--
-- `_pct` not `_percent`, matching the discount_pct / gst_pct already on this
-- table. `gst_pct` is kept and keeps its meaning — the line's total tax rate —
-- and is what the slab rollup groups on; the components below decompose it.
--
-- trade_price is a genuinely THIRD figure, not a synonym. On an Indian
-- distributor invoice PTR/Trade Price is the printed list price for the trade;
-- `printed_rate` is what THIS pharmacy was actually charged on THIS line, and
-- `printed_mrp` is what the patient pays. All three legitimately differ, and
-- collapsing any two loses the vendor's own pricing evidence.

alter table public.supplier_invoice_items
  add column if not exists hsn_code        text,
  add column if not exists trade_price     numeric(10,2) check (trade_price is null or trade_price >= 0),

  -- The Dis.Amt column, where a vendor prints an amount instead of (or beside)
  -- a percentage. Before this existed such a line silently produced a cost at
  -- the FULL printed rate, with no warning — LINE_TOTAL_MISMATCH compares
  -- gross against gross, so it agreed. See supplier-invoices.normalize.js.
  add column if not exists discount_amount numeric(12,2) check (discount_amount is null or discount_amount >= 0),
  add column if not exists taxable_amount  numeric(12,2) check (taxable_amount is null or taxable_amount >= 0),

  add column if not exists cgst_pct    numeric(5,2)  check (cgst_pct is null or (cgst_pct >= 0 and cgst_pct <= 100)),
  add column if not exists cgst_amount numeric(12,2) check (cgst_amount is null or cgst_amount >= 0),
  add column if not exists sgst_pct    numeric(5,2)  check (sgst_pct is null or (sgst_pct >= 0 and sgst_pct <= 100)),
  add column if not exists sgst_amount numeric(12,2) check (sgst_amount is null or sgst_amount >= 0),
  add column if not exists igst_pct    numeric(5,2)  check (igst_pct is null or (igst_pct >= 0 and igst_pct <= 100)),
  add column if not exists igst_amount numeric(12,2) check (igst_amount is null or igst_amount >= 0),
  add column if not exists cess_pct    numeric(5,2)  check (cess_pct is null or (cess_pct >= 0 and cess_pct <= 100)),
  add column if not exists cess_amount numeric(12,2) check (cess_amount is null or cess_amount >= 0),

  add column if not exists net_amount  numeric(12,2) check (net_amount is null or net_amount >= 0);

comment on column public.supplier_invoice_items.trade_price is
  'Printed trade price / PTR. A THIRD figure — not printed_rate (what this pharmacy was charged) and not printed_mrp (what the patient pays).';
comment on column public.supplier_invoice_items.line_total is
  'Gross amount as printed, before discount and before tax. The other name for this concept on a vendor invoice is "Gross Amount".';
comment on column public.supplier_invoice_items.discount_amount is
  'Printed discount amount. Where discount_pct is absent, the API derives an effective percentage from this and the gross so the cost is not silently overstated.';
comment on column public.supplier_invoice_items.gst_pct is
  'The line''s TOTAL tax rate, and the key the tax summary groups on. cgst_pct + sgst_pct, or igst_pct, should equal it.';
comment on column public.supplier_invoice_items.unit_cost is
  'UNCHANGED by this migration. Cost of ONE SALEABLE UNIT, net of discount, EXCLUDING GST. Still the only figure copied into inventory_batches.';

-- ── 37.3  Tax summary, grouped by rate ───────────────────────────────────
--
-- A separate table rather than columns, because the cardinality is the whole
-- point: one invoice carries as many rows as it has distinct tax rates.
-- MEDICO M002948 has two (12% on nineteen lines, 18% on one). Modelling this
-- as `gst_5_taxable, gst_12_taxable, gst_18_taxable…` would fix the rate list
-- in DDL, and GST rates change by notification.
--
-- These rows are TRANSCRIBED from the invoice's own HSN/tax summary block.
-- They are not the API's rollup of the lines — that is computed on read and
-- compared against these. Storing the printed block is not a violation of
-- "nothing stored that can be computed": it cannot be computed. It is a
-- past-tense fact about what the vendor filed, the same kind of fact
-- bill_items.unit_price snapshots.

create table if not exists public.supplier_invoice_tax_summary (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.supplier_invoices(id) on delete cascade,

  -- The slab: 0, 5, 12, 18, 28. Zero is meaningful and must be storable — an
  -- exempt line belongs in the summary as a taxable amount with no tax.
  tax_rate   numeric(5,2) not null check (tax_rate >= 0 and tax_rate <= 100),

  basic_amount    numeric(12,2) check (basic_amount is null or basic_amount >= 0),
  discount_amount numeric(12,2) check (discount_amount is null or discount_amount >= 0),
  taxable_amount  numeric(12,2) check (taxable_amount is null or taxable_amount >= 0),
  cgst_amount     numeric(12,2) check (cgst_amount is null or cgst_amount >= 0),
  sgst_amount     numeric(12,2) check (sgst_amount is null or sgst_amount >= 0),
  igst_amount     numeric(12,2) check (igst_amount is null or igst_amount >= 0),
  cess_amount     numeric(12,2) check (cess_amount is null or cess_amount >= 0),
  total_tax       numeric(12,2) check (total_tax is null or total_tax >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per rate per invoice. An invoice is either intra-state (CGST+SGST)
-- or inter-state (IGST) throughout, never both at the same rate, so the rate
-- alone identifies the slab.
--
-- This unique index also serves every read of the table — the leading column
-- is invoice_id, which is the only way these rows are ever fetched. A separate
-- index on invoice_id would be redundant with it.
create unique index if not exists idx_supplier_invoice_tax_summary_rate
  on public.supplier_invoice_tax_summary(invoice_id, tax_rate);

drop trigger if exists supplier_invoice_tax_summary_updated_at on public.supplier_invoice_tax_summary;
create trigger supplier_invoice_tax_summary_updated_at
  before update on public.supplier_invoice_tax_summary
  for each row execute procedure public.handle_updated_at();

-- ── 37.4  RLS ────────────────────────────────────────────────────────────
-- Mirrors supplier_invoice_items exactly: both roles read and edit drafts,
-- because staff do the goods inward and nothing here is stock.

alter table public.supplier_invoice_tax_summary enable row level security;

drop policy if exists "authenticated_read_supplier_invoice_tax_summary" on public.supplier_invoice_tax_summary;
create policy "authenticated_read_supplier_invoice_tax_summary" on public.supplier_invoice_tax_summary
  for select using (auth.uid() is not null);

drop policy if exists "authenticated_write_supplier_invoice_tax_summary" on public.supplier_invoice_tax_summary;
create policy "authenticated_write_supplier_invoice_tax_summary" on public.supplier_invoice_tax_summary
  for all using (auth.uid() is not null);

-- schema-29 revoked the blanket anon/authenticated grants across the schema.
-- A table created afterwards would otherwise re-acquire them from Supabase's
-- defaults, so it is revoked here on creation — the same line every
-- post-lockdown migration carries.
revoke all on public.supplier_invoice_tax_summary from anon, authenticated;

-- ── 37.5  Indexes ────────────────────────────────────────────────────────
--
-- Deliberately only two. Already covered elsewhere and NOT duplicated here:
--   supplier_id            idx_supplier_invoices_supplier      (schema-23)
--   invoice number         idx_supplier_invoice_no_unique      (schema-23)
--   invoice_id on lines    idx_supplier_invoice_items_invoice  (schema-23)
--   medicine/product id    idx_supplier_invoice_items_medicine (schema-23)
--   batch + expiry         idx_batch_medicine_batchno,
--                          idx_batch_exp_date                  (inventory.sql)
--   invoice_id on summary  the unique index above leads with it

-- Invoice date is now a filterable, sortable field in its own right (a GST
-- return is filed for a PERIOD, and the period is keyed on the vendor's
-- invoice date, not on when the document was uploaded).
create index if not exists idx_supplier_invoices_invoice_date
  on public.supplier_invoices(invoice_date desc nulls last);

-- Partial, and partial is the point: after this migration essentially every
-- row is 'TAX_INVOICE', so a full index on the column would be a scan of the
-- table wearing an index's clothes. Credit and debit notes are the rare rows,
-- and finding them is the actual query.
create index if not exists idx_supplier_invoices_non_tax_type
  on public.supplier_invoices(invoice_type, created_at desc)
  where invoice_type <> 'TAX_INVOICE';

-- ── 37.6  commit_supplier_invoice — one new guard, nothing else ──────────
--
-- Replaced in full, exactly as schema-25 replaced schema-23's copy, so this
-- file is the whole current definition. THE ONLY CHANGE is the invoice_type
-- guard below. Every other line — including `v_units = qty_billed + qty_free`
-- and the unit_cost/mrp passthrough — is byte-identical to schema-25 §25.5.
-- No costing behaviour changes.
--
-- WHY A CREDIT NOTE IS REFUSED RATHER THAN POSTED
--
-- This function only ever inserts POSITIVE ledger rows. A credit note is a
-- movement in the opposite direction, and PCare already has the module that
-- owns outward movement against a supplier: supplier_returns, committed by
-- send_supplier_return_atomic, which writes 'return_outward' rows and computes
-- a debit note amount. Teaching a receipts function to decrement stock would
-- put a returns path inside it and give two functions authority over the same
-- ledger sign.
--
-- So the type is REPRESENTED here in full and is refused at the ledger. That
-- is a smaller and more honest change than a negative-quantity branch nobody
-- has specified.

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

  -- THE NEW GUARD. `is distinct from` rather than `<>` so a NULL — which the
  -- NOT NULL DEFAULT should make impossible, but which a direct DB edit could
  -- still produce — is refused rather than silently passing the test.
  if v_inv.invoice_type is distinct from 'TAX_INVOICE' then
    raise exception 'NOT_A_TAX_INVOICE: a % cannot be taken into stock; record it as a supplier return', v_inv.invoice_type;
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

    -- UNCHANGED. Saleable units, the denomination inventory_ledger is counted
    -- in. Paid quantity and free quantity are stored separately and are only
    -- ever added HERE, to produce the physical quantity received.
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

-- ── 37.7  View refresh ───────────────────────────────────────────────────
--
-- DROP then CREATE, NOT `create or replace`. This is the same 42P16 trap
-- schema-24 §24.5 documents, and it bites harder here: `si.*` expands at
-- creation time, so 37.1's thirty new columns land where supplier_name,
-- uploaded_by_name and approved_by_name currently sit. CREATE OR REPLACE may
-- only APPEND columns to a view, never rename one, so it would fail with
-- "cannot change name of view column supplier_name to invoice_type" and take
-- the whole migration down with it.
--
-- Nothing depends on this view — the API reads it directly and no other view
-- or function references it — so dropping it costs nothing.
--
-- Body is otherwise identical to schema-25 §25.6. Two columns are added at the
-- end: tax_summary_count, so the list page can show which documents carry a
-- transcribed tax block, and physical_units, which is the sum the requirement
-- "received = paid + free" names. Both are computed, never stored.

drop view if exists public.supplier_invoices_with_counts;

create view public.supplier_invoices_with_counts as
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
  coalesce(i.physical_units, 0) as physical_units,
  coalesce(t.tax_summary_count, 0) as tax_summary_count,
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
    ) filter (where not sii.is_excluded), 0)::numeric(12,2) as lines_total,
    -- Paid + free. The only place the two are ever added, and it produces the
    -- PHYSICAL quantity — the same figure commit_supplier_invoice posts to the
    -- ledger. Named so nothing mistakes it for the billed quantity.
    coalesce(sum(
      coalesce(sii.qty_billed, 0) + coalesce(sii.qty_free, 0)
    ) filter (where not sii.is_excluded), 0)::int          as physical_units
  from public.supplier_invoice_items sii
  where sii.invoice_id = si.id
) i on true
left join lateral (
  select count(*)::int as tax_summary_count
  from public.supplier_invoice_tax_summary sits
  where sits.invoice_id = si.id
) t on true;

-- ── 37.8  Backfill ───────────────────────────────────────────────────────
--
-- There is deliberately none, beyond the DEFAULT on invoice_type that every
-- existing row silently takes.
--
-- Every legacy invoice predates tax capture, so its tax columns are unknown —
-- not zero. Writing 0 into total_cgst would assert that a delivery carried no
-- tax, which is almost certainly false and is indistinguishable afterwards
-- from a genuinely exempt invoice. NULL says "never recorded", which is the
-- true statement, and every reconciliation below skips a NULL rather than
-- treating it as a figure.
--
-- The single value that IS safe to assert is invoice_type: every row that
-- exists was ingested by a pipeline that could only ever produce a tax
-- invoice, and every one of them was importable under the old rules. The
-- DEFAULT keeps them importable under the new ones.
