-- ============================================================
-- MODULE 23 — SUPPLIER INVOICE INGESTION (AI-assisted goods inward)
--
-- Run AFTER schema-22-atomic-workflows.sql — this is the new LAST migration
-- (see docs/MIGRATION-ORDER.md). It references medicines, suppliers,
-- purchases, purchase_items, inventory_batches and inventory_ledger, and its
-- commit function is the module's own atomic workflow, so it belongs on the
-- same side of the line as Module 22.
--
-- What this module is: a STAGING AREA in front of goods receipt. A distributor
-- invoice is uploaded, read once by Gemini, and parked in
-- supplier_invoices / supplier_invoice_items where a human corrects it. Nothing
-- it holds is stock. Stock only exists after commit_supplier_invoice() runs,
-- and that function is the only writer of inventory rows in this module.
--
-- The staging tables are therefore deliberately permissive (every extracted
-- column is nullable — the model is instructed to emit null rather than guess)
-- while the commit function is deliberately strict. That split is the design:
-- an unreadable field must be able to reach a human, and must not be able to
-- reach the ledger.
-- ============================================================

-- ── Trigram matching, used to suggest a catalogue medicine for each printed
-- line description. Distributor invoices print "PARACETAMOL 500MG TAB 10X10"
-- where the catalogue holds "Paracetamol 500mg"; exact matching finds nothing.
create extension if not exists pg_trgm;

create index if not exists idx_medicines_name_trgm
  on public.medicines using gin (name gin_trgm_ops);
create index if not exists idx_medicines_generic_trgm
  on public.medicines using gin (generic_name gin_trgm_ops);
create index if not exists idx_suppliers_name_trgm
  on public.suppliers using gin (name gin_trgm_ops);

-- ── Private bucket for the original documents. Nothing is ever served from
-- here directly — the API hands out short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('supplier-invoices', 'supplier-invoices', false)
on conflict (id) do nothing;

-- ============================================================
-- 23.1  supplier_invoices — one row per uploaded document
-- ============================================================

create table if not exists public.supplier_invoices (
  id                  uuid primary key default gen_random_uuid(),

  -- Resolved supplier. Nullable while under review: the model reads a printed
  -- name, and matching that to a row in `suppliers` can fail legitimately.
  supplier_id         uuid references public.suppliers(id),
  supplier_name_raw   text,                 -- exactly as printed on the document
  supplier_gstin      text,

  invoice_no          text,
  -- Generated, not maintained by the API. Two jobs: it is the column the
  -- uniqueness index compares, and it is the column the duplicate PRE-check
  -- filters on — PostgREST cannot express `upper(trim(col)) = $1`, and doing
  -- the comparison with `ilike` instead would let a `%` inside an invoice
  -- number act as a wildcard.
  invoice_no_key      text generated always as (upper(trim(invoice_no))) stored,
  invoice_date        date,
  taxable_total       numeric(12,2),
  gst_total           numeric(12,2),
  net_total           numeric(12,2),

  status              text not null default 'NEEDS_REVIEW'
                        check (status in ('NEEDS_REVIEW', 'IMPORTED', 'REJECTED')),

  -- ── Original document (private bucket, signed URLs only)
  storage_path        text not null,
  file_name           text,
  file_mime           text,
  file_size           int,

  -- ── Audit of the machine's contribution. raw_extraction is the model's
  -- response byte-for-byte, before any normalisation: when a committed batch is
  -- later disputed, this is what separates "the model misread it" from "the
  -- reviewer mistyped it". Never overwritten by an edit.
  raw_extraction      jsonb,
  extraction_model    text,
  extraction_ms       int,

  -- Document-level validation findings, recomputed on every save.
  -- [{ code, severity, message, field? }]
  validation_warnings jsonb not null default '[]'::jsonb,

  purchase_id         uuid references public.purchases(id),

  uploaded_by         uuid references public.users(id),
  approved_by         uuid references public.users(id),
  approved_at         timestamptz,
  rejected_reason     text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ── Duplicate defence. The same invoice number from the same distributor is
-- the same delivery; importing it twice doubles stock that does not exist.
-- Partial, because:
--   · supplier_id / invoice_no are null while a document is still being read,
--     and a half-read draft must not collide with anything;
--   · a REJECTED document is a document that was decided against — it must not
--     stop the correct version of the same invoice from being imported.
create unique index if not exists idx_supplier_invoice_no_unique
  on public.supplier_invoices (supplier_id, invoice_no_key)
  where supplier_id is not null
    and invoice_no is not null
    and status <> 'REJECTED';

create index if not exists idx_supplier_invoices_status   on public.supplier_invoices(status);
create index if not exists idx_supplier_invoices_supplier on public.supplier_invoices(supplier_id);
create index if not exists idx_supplier_invoices_created  on public.supplier_invoices(created_at desc);

drop trigger if exists supplier_invoices_updated_at on public.supplier_invoices;
create trigger supplier_invoices_updated_at before update on public.supplier_invoices
  for each row execute procedure public.handle_updated_at();

-- ============================================================
-- 23.2  supplier_invoice_items — one row per printed line
-- ============================================================

create table if not exists public.supplier_invoice_items (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references public.supplier_invoices(id) on delete cascade,
  line_no         int  not null,

  raw_description text,                                  -- the printed line, kept verbatim
  medicine_id     uuid references public.medicines(id),  -- null until mapped

  -- How the mapping happened, and how sure the machine was. 'auto' means the
  -- trigram suggestion was accepted as-is and no human has confirmed it —
  -- which is why LOW_MATCH_CONFIDENCE is surfaced in review.
  match_source     text check (match_source in ('auto', 'manual', 'created')),
  match_confidence numeric(4,3),
  match_candidates jsonb not null default '[]'::jsonb,   -- top trigram hits, for the picker

  batch_no        text,
  mfg_date        date,
  exp_date        date,

  -- ⚠️ SUPERSEDED BY schema-25-pack-contents.sql. The comment block below and
  -- the pack_size column it describes are the ORIGINAL, INCORRECT model, kept
  -- here only because migrations are append-only and this file must still run
  -- first on a fresh database. schema-25 DROPS pack_size and replaces
  -- commit_supplier_invoice(). Read that file, not this comment, for the model
  -- actually in force: the Pack column describes what is INSIDE one saleable
  -- unit and never multiplies stock, so stock in = qty_billed + qty_free.
  --
  -- UNITS, stated once so nothing downstream has to guess:
  --   qty_billed / qty_free are counted in INVOICE units (packs, boxes,
  --   whatever the Qty column counts).
  --   pack_size is how many STOCK units (the medicine's own `unit` — strips,
  --   bottles) sit inside one invoice unit.
  --   unit_cost and mrp are per STOCK unit.
  -- Stock taken in  = (qty_billed + qty_free) * pack_size.
  -- Line value paid = qty_billed * pack_size * unit_cost  (free goods cost nil).
  -- The reviewer sees both computed figures beside the printed line total, so a
  -- rate quoted per pack instead of per strip shows up as a mismatch rather
  -- than as a silently wrong margin.
  qty_billed      int  check (qty_billed >= 0),
  qty_free        int  not null default 0 check (qty_free >= 0),
  pack_size       int  not null default 1 check (pack_size > 0),
  unit_cost       numeric(10,2) check (unit_cost >= 0),
  mrp             numeric(10,2) check (mrp >= 0),
  selling_price   numeric(10,2) check (selling_price >= 0),
  line_total      numeric(12,2),                         -- as printed; used only to cross-check

  warnings        jsonb not null default '[]'::jsonb,
  is_excluded     boolean not null default false,        -- reviewer dropped the line

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_supplier_invoice_items_invoice
  on public.supplier_invoice_items(invoice_id, line_no);
create index if not exists idx_supplier_invoice_items_medicine
  on public.supplier_invoice_items(medicine_id);

drop trigger if exists supplier_invoice_items_updated_at on public.supplier_invoice_items;
create trigger supplier_invoice_items_updated_at before update on public.supplier_invoice_items
  for each row execute procedure public.handle_updated_at();

-- ============================================================
-- 23.3  RLS
-- Both roles read and edit drafts (staff do the goods inward); only the
-- commit function — running as definer through the service-role client —
-- writes inventory. Nothing here is ever hard-deleted except by the
-- ON DELETE CASCADE from a document row, which only the owner can trigger.
-- ============================================================

alter table public.supplier_invoices      enable row level security;
alter table public.supplier_invoice_items enable row level security;

drop policy if exists "authenticated_read_supplier_invoices" on public.supplier_invoices;
create policy "authenticated_read_supplier_invoices" on public.supplier_invoices
  for select using (auth.uid() is not null);

drop policy if exists "authenticated_insert_supplier_invoices" on public.supplier_invoices;
create policy "authenticated_insert_supplier_invoices" on public.supplier_invoices
  for insert with check (auth.uid() is not null);

drop policy if exists "authenticated_update_supplier_invoices" on public.supplier_invoices;
create policy "authenticated_update_supplier_invoices" on public.supplier_invoices
  for update using (auth.uid() is not null);

drop policy if exists "authenticated_read_supplier_invoice_items" on public.supplier_invoice_items;
create policy "authenticated_read_supplier_invoice_items" on public.supplier_invoice_items
  for select using (auth.uid() is not null);

drop policy if exists "authenticated_write_supplier_invoice_items" on public.supplier_invoice_items;
create policy "authenticated_write_supplier_invoice_items" on public.supplier_invoice_items
  for all using (auth.uid() is not null);

-- ============================================================
-- 23.4  View: invoices with the counts the list page needs
-- Nothing stored that can be computed (CLAUDE.md) — line counts, unmapped
-- counts and the error tally are all derived here.
-- ============================================================

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

-- ============================================================
-- 23.5  Trigram lookups
--
-- PostgREST cannot express `order by similarity(name, $1)`, so the ranking
-- lives here. STABLE and read-only: safe to call per line during ingestion.
-- ============================================================

create or replace function public.match_medicines_trgm(p_query text, p_limit int default 5)
returns table (
  id uuid, name text, generic_name text, manufacturer text,
  unit text, default_selling_price numeric, score real
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.name, m.generic_name, m.manufacturer,
         m.unit, m.default_selling_price,
         greatest(
           similarity(m.name, p_query),
           similarity(coalesce(m.generic_name, ''), p_query)
         ) as score
  from public.medicines m
  where m.is_active
    -- `%` is the pg_trgm similarity operator, gated by
    -- pg_trgm.similarity_threshold (0.3 by default). It is also what lets the
    -- GIN indexes above be used, so this must stay an operator and not become
    -- `similarity(...) > 0.3` in the WHERE clause.
    and (m.name % p_query or coalesce(m.generic_name, '') % p_query)
  order by score desc, m.name asc
  limit greatest(coalesce(p_limit, 5), 1);
$$;

create or replace function public.match_suppliers_trgm(p_query text, p_limit int default 5)
returns table (id uuid, name text, gst_no text, score real)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, s.gst_no, similarity(s.name, p_query) as score
  from public.suppliers s
  where s.is_active
    and s.name % p_query
  order by score desc, s.name asc
  limit greatest(coalesce(p_limit, 5), 1);
$$;

-- ============================================================
-- 23.6  commit_supplier_invoice — the atomic import
--
-- One transaction. Either the purchase record, every batch, every ledger row
-- and the status flip all land, or none of them do. Same contract as the
-- Module 22 functions and for the same reason: PostgREST gives the API no
-- client-side transaction, so a multi-write workflow driven from Node leaves
-- partial state the moment anything fails halfway.
--
-- It reads the staged rows rather than taking them as a parameter. What gets
-- committed is therefore exactly what the reviewer saved and looked at — there
-- is no second payload that could disagree with the screen.
--
-- Every guard below duplicates one the API already applies. That is deliberate:
-- the API's copy exists to give the reviewer an inline message, this copy
-- exists because the database is the final authority on what may become stock.
-- ============================================================

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
  v_sp        numeric;
  v_line_count int := 0;
begin
  -- FOR UPDATE: two owners clicking Approve at the same moment serialise here,
  -- and the second one finds status = 'IMPORTED' and stops.
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
    v_sp := coalesce(v_item.selling_price, v_item.mrp);
    if v_sp <= 0 then
      raise exception 'MISSING_MRP: line % has no MRP', v_item.line_no;
    end if;
    if v_sp > v_item.mrp then
      raise exception 'PRICE_EXCEEDS_MRP: selling price cannot exceed MRP';
    end if;

    v_units := (coalesce(v_item.qty_billed, 0) + coalesce(v_item.qty_free, 0)) * v_item.pack_size;
    if v_units <= 0 then
      raise exception 'MISSING_QTY: line % has no quantity', v_item.line_no;
    end if;

    insert into public.inventory_batches
      (medicine_id, batch_no, exp_date, mfg_date, unit_cost, mrp, selling_price,
       supplier_id, po_id, created_by)
    values
      (v_item.medicine_id, upper(trim(v_item.batch_no)), v_item.exp_date, v_item.mfg_date,
       v_item.unit_cost, v_item.mrp, v_sp,
       v_inv.supplier_id, v_purchase_id, p_user_id)
    returning id into v_batch_id;
    -- A repeat of (medicine_id, batch_no) raises unique_violation 23505; the API
    -- maps it to DUPLICATE_BATCH and this whole import rolls back. The review
    -- screen flags it as BATCH_EXISTS beforehand so it rarely gets this far.

    -- Append-only: stock is this row, not a column somewhere.
    insert into public.inventory_ledger
      (batch_id, change_qty, reason, ref_id, note, created_by)
    values
      (v_batch_id, v_units, 'purchase_receipt', v_purchase_id,
       'Invoice ' || v_inv.invoice_no || ' · line ' || v_item.line_no, p_user_id);

    -- The purchase order is reconstructed from the invoice rather than the
    -- other way round: qty_ordered = qty_received, because nobody raised an
    -- order — the goods and the paperwork arrived together.
    insert into public.purchase_items
      (purchase_id, medicine_id, qty_ordered, unit_cost, qty_received,
       batch_no, batch_id, mrp, selling_price, exp_date, mfg_date)
    values
      (v_purchase_id, v_item.medicine_id, v_units, v_item.unit_cost, v_units,
       upper(trim(v_item.batch_no)), v_batch_id, v_item.mrp, v_sp,
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

-- Definer rights; the API calls these through the service-role client only.
revoke execute on function public.commit_supplier_invoice(uuid, uuid) from anon;
revoke execute on function public.match_medicines_trgm(text, int) from anon;
revoke execute on function public.match_suppliers_trgm(text, int) from anon;
