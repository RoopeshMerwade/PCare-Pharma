-- ============================================================
-- MODULE 23 (cont.) — INVOICE LINE DETAIL
--
-- Run AFTER schema-23-supplier-invoices.sql. Purely additive: no column is
-- dropped, no existing value is rewritten, every new column is nullable. An
-- IMPORTED invoice from before this migration keeps NULLs here and stays a
-- valid permanent record of what became stock.
--
-- WHY THIS EXISTS
--
-- Module 23 shipped assuming `unit_cost` and `mrp` were quoted per STOCK unit.
-- The first real distributor invoice (MEDICO DISTRIBUTORS M002948, MARG ERP
-- format — see backend/tests/fixtures/medico-M002948.json) quotes both per
-- INVOICE unit, and says so on the page: the column is headed "MRP on Pack".
--
--   Printed:  Pack 10'S · Qty 11 · Rate 107.14 · Total 1178.54
--   11 x 107.14 = 1178.54  ✓   the rate is per strip of ten
--   Module 23 computed 11 x 10 x 107.14 = 11785.40  ✗   ten times over
--
-- Worse, it was undetectable by the guard meant to catch it: COST_EXCEEDS_MRP
-- compares cost against MRP, and on this invoice BOTH are per pack, so the
-- ratio looks correct while both numbers are ten times too large.
--
-- THE FIX, AND WHY IT IS SHAPED THIS WAY
--
-- The unit basis is no longer assumed. It is DERIVED from arithmetic already
-- printed on the invoice — qty, rate and line total are all on the page, and
-- only one basis makes them agree — then stored in `rate_basis` where a human
-- can see it and correct it. The module's existing rule holds: nothing here
-- guesses, and what cannot be derived becomes NULL and reaches a reviewer.
--
-- `unit_cost` and `mrp` keep their names and their meaning (per STOCK unit,
-- and unit_cost is now net of the line discount). What changes is that they
-- are now DERIVED rather than transcribed, and the transcribed values live
-- alongside in printed_rate / printed_mrp. Three things are then separable
-- when a batch's cost is disputed:
--
--   raw_extraction  what the model read
--   printed_*       what the paper says          <- new
--   unit_cost/mrp   what was computed from it
--
-- That is the same separation raw_extraction already exists to provide, one
-- level further down. Deleting the middle term is what makes a misread
-- indistinguishable from a miscalculation.
--
-- commit_supplier_invoice() is deliberately NOT changed. It copies unit_cost
-- and mrp straight into inventory_batches, and those columns now hold values
-- that are already correct per stock unit, so the RPC needs no knowledge of
-- any of this.
-- ============================================================

-- ── 24.1  Line detail ────────────────────────────────────────────────────

alter table public.supplier_invoice_items
  -- The rate and MRP exactly as printed, on whatever basis the distributor
  -- used. Never converted, never discounted — this is the tie-back to paper.
  add column if not exists printed_rate  numeric(10,2) check (printed_rate >= 0),
  add column if not exists printed_mrp   numeric(10,2) check (printed_mrp >= 0),

  -- Which basis the printed figures use, proved by arithmetic rather than
  -- assumed or asked of the model. NULL means the sums did not resolve it, and
  -- RATE_BASIS_UNRESOLVED blocks the import until a human decides.
  add column if not exists rate_basis    text check (rate_basis in ('pack', 'unit')),

  -- The Pack column verbatim: "10'S", "1x200ML", "2ML", "500ML". Needed for
  -- two reasons. It is what tells 2ML (one ampoule) apart from 10'S (ten
  -- tablets) — parseInt reads both as counts and inflates the second line by
  -- 500x. And it is what a reviewer compares against the carton in their hand;
  -- an integer alone cannot be checked against anything.
  add column if not exists pack_raw      text,

  -- The Dis.% column. On M002948 it is a flat 3.00% and worth Rs 319.39 across
  -- the invoice — money that was silently absent from every cost before this.
  add column if not exists discount_pct  numeric(5,2) check (discount_pct >= 0 and discount_pct <= 100),

  -- Per-line GST%. Not used in costing (a registered pharmacy reclaims input
  -- GST, so it is not a cost) but captured for GSTR-2 reconciliation, and
  -- because a line's tax class is a fact about the line, not about the total.
  add column if not exists gst_pct       numeric(5,2) check (gst_pct >= 0 and gst_pct <= 100),

  -- The M.Fg. column: MAN, MIC, BLU, LUPI, ZYD, SYS. A distributor's private
  -- abbreviation, NOT a company name — three distributors will use three
  -- different codes for the same manufacturer. Stored as printed and used to
  -- narrow catalogue matching; never written into medicines.manufacturer.
  add column if not exists mfg_code_raw  text;

comment on column public.supplier_invoice_items.rate_basis is
  'Whether printed_rate/printed_mrp are per invoice unit (pack) or per stock unit. Derived from qty x rate vs line_total; NULL when unresolvable.';
comment on column public.supplier_invoice_items.unit_cost is
  'DERIVED per STOCK unit, net of discount_pct. Copied to inventory_batches on commit. printed_rate holds the untouched figure.';
comment on column public.supplier_invoice_items.mrp is
  'DERIVED per STOCK unit. printed_mrp holds the untouched figure.';

-- ── 24.2  Document detail ────────────────────────────────────────────────

alter table public.supplier_invoices
  -- Supplier's drug licence number, printed on every distributor invoice
  -- (M002948: KA-GD/1208-1/28965, 21B/128966). Rule 65 of the Drugs and
  -- Cosmetics Rules requires it on the purchase record a pharmacy retains.
  -- suppliers.drug_license_no already exists to reconcile against.
  add column if not exists supplier_dl_no      text,

  -- Seller's phone from the letterhead. Used only to pre-fill the quick-add
  -- supplier form at review time; never authoritative contact data.
  add column if not exists supplier_phone      text,

  -- The invoice's own line count, where the format prints one (MARG puts it in
  -- the footer as "Total Item"). A free checksum against a row lost to a fold
  -- or a shadow — the one extraction failure a reviewer cannot see, because a
  -- missing line leaves nothing on screen to notice.
  add column if not exists printed_item_count  int check (printed_item_count >= 0);

-- ── 24.3  Stock unit: tablets ────────────────────────────────────────────
--
-- PCare counts loose tablets, not strips: a 10'S strip is ten stock units.
-- medicines.unit had no value for that, so a per-tablet medicine could not be
-- catalogued at all. Additive — every existing unit stays legal.

alter table public.medicines
  drop constraint if exists medicines_unit_check;

alter table public.medicines
  add constraint medicines_unit_check
  check (unit in ('tablets', 'strips', 'vials', 'bottles', 'tubes', 'packs', 'pcs'));

-- ── 24.4  Backfill ───────────────────────────────────────────────────────
--
-- Only NEEDS_REVIEW drafts, and only the tie-back columns. Deliberately does
-- NOT set rate_basis: on a pre-migration row nobody knows which basis was
-- meant, and writing a plausible one would launder an assumption into a fact.
-- Those drafts surface RATE_BASIS_UNRESOLVED and get a human decision, which
-- is the correct outcome for a draft whose cost basis was never established.
--
-- IMPORTED and REJECTED rows are untouched. They are permanent records of a
-- decision already made, and re-deriving their figures would change history.

update public.supplier_invoice_items sii
   set printed_rate = coalesce(sii.printed_rate, sii.unit_cost),
       printed_mrp  = coalesce(sii.printed_mrp,  sii.mrp)
  from public.supplier_invoices si
 where si.id = sii.invoice_id
   and si.status = 'NEEDS_REVIEW'
   and (sii.printed_rate is null or sii.printed_mrp is null);

-- ── 24.5  View refresh ───────────────────────────────────────────────────
--
-- `select si.*` does not pick up columns added after the view was created, so
-- the list page would never see supplier_dl_no or printed_item_count. Replaced
-- verbatim apart from that; keep in step with schema-23 section 23.4.
--
-- DROP then CREATE, not CREATE OR REPLACE. `si.*` expands at creation time, so
-- 24.2's three new columns land at positions 27-29 — where supplier_name,
-- uploaded_by_name and approved_by_name currently sit. CREATE OR REPLACE may
-- only APPEND columns, never rename one, so it fails here with 42P16
-- ("cannot change name of view column supplier_name to supplier_dl_no") and
-- takes the whole migration down with it. Nothing depends on this view — the
-- API reads it directly and no other view or function references it — so
-- dropping it costs nothing. schema-25 section 25.6 can keep CREATE OR REPLACE:
-- by then si.* already holds these columns and the shape is unchanged.

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
