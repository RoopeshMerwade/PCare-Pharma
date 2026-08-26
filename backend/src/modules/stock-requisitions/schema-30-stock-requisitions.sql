-- ============================================================
-- MODULE 30: STOCK REQUISITIONS — STAFF ASK, OWNER APPROVES, OWNER ORDERS
--
-- Prerequisites:
--   · Module 01 (auth.sql)          — public.users, public.handle_updated_at()
--   · Module 04 (medicines.sql)     — public.medicines
--   · Module 05 (inventory.sql)     — public.inventory_batches
--   · Module 06-10 (schema-06-10)   — public.suppliers, purchases, purchase_items
--   · Module 16 (schema-15-20.sql)  — public.notifications
--   · schema-26-staff-attendance    — last rewrote notifications_type_check;
--                                     this file rewrites it AGAIN, so it must
--                                     run after that one or STAFF_CHECK_IN and
--                                     STAFF_CHECK_OUT drop back out of the list.
--   · schema-28-security-hardening  — public.is_owner()
--
-- Purely additive: two new tables, two new views, one sequence, one function,
-- one index on an existing table, and three new values on an existing CHECK.
-- Nothing existing is dropped or rewritten.
--
-- This module writes NO STOCK. It creates no batch, no ledger row and no
-- purchase order. It records what somebody asked for and what the owner
-- approved, and it renders that as a document. Every quantity in here is a
-- REQUEST, and the only thing that ever turns a request into stock is a human
-- placing an order and Module 05/08/23 receiving the goods.
-- ============================================================


-- ══════════════════════════════════════════
-- medicine_vendor_prices — what we last paid, per medicine, per distributor.
--
-- This view is the ONE thing about vendors a staff member may read, and it is
-- deliberately shaped so it cannot quietly become more. It is not a curated
-- price list: nobody maintains it, nothing writes to it, and it holds exactly
-- six facts per pair. A price nobody has to remember to update is a price that
-- cannot go stale in a way the screen hides — `last_purchased_on` travels on
-- the row so the AGE of the number arrives with the number.
--
-- TWO SOURCES, and the second is not belt-and-braces.
--
--   A. purchase_items ⋈ purchases where status = 'received'. The canonical
--      record, covering both manual PO receipt and Module 23's invoice import
--      (commit_supplier_invoice writes a 'received' purchase). The status
--      filter is not a policy choice: purchase_items.mrp is NULL until receipt
--      fills it, and MRP is a column this module has to print. An unreceived
--      line physically cannot supply one.
--
--   B. inventory_batches that record their own supplier. Batches entered by
--      hand through Module 05 never pass through a purchase order at all, and
--      on a database where PO receipt has never worked (the receive_purchase_
--      atomic arity defect noted in CLAUDE.md) source A is EMPTY and source B
--      is the whole view. Leaving B out ships a feature whose dropdown is
--      blank for every medicine in the shop.
--
-- The two overlap: commit_supplier_invoice writes a batch AND a purchase_item
-- for the same event, carrying identical unit_cost and mrp. The DISTINCT ON
-- collapses them, so the overlap costs one row in a sort and nothing else.
--
-- security_invoker so the base tables' RLS applies to whoever queries the view
-- rather than to its owner. The API reads it on the service_role client, which
-- bypasses RLS either way; this matters only if anything ever queries it
-- directly, and after schema-29 nothing can.
-- ══════════════════════════════════════════
create or replace view public.medicine_vendor_prices
with (security_invoker = on) as
with priced as (
  select
    pi.medicine_id,
    p.supplier_id,
    pi.unit_cost,
    pi.mrp,
    coalesce(p.received_at, p.created_at) as priced_at,
    pi.id                                 as source_id
  from public.purchase_items pi
  join public.purchases p on p.id = pi.purchase_id
  where p.status = 'received'
    and pi.unit_cost is not null

  union all

  select
    b.medicine_id,
    b.supplier_id,
    b.unit_cost,
    b.mrp,
    b.created_at as priced_at,
    b.id         as source_id
  from public.inventory_batches b
  where b.supplier_id is not null
)
select distinct on (pr.medicine_id, pr.supplier_id)
  pr.medicine_id,
  pr.supplier_id,
  s.name             as supplier_name,
  pr.unit_cost       as last_unit_cost,
  pr.mrp             as last_mrp,
  pr.priced_at::date as last_purchased_on
from priced pr
join public.suppliers s on s.id = pr.supplier_id
where s.is_active = true
-- DISTINCT ON needs a TOTAL order or "latest" is whichever row the planner
-- happened to emit first — usually the newest, and silently not the newest
-- once the table grows enough to change the plan. source_id is never null and
-- never duplicated, so the third key makes the answer deterministic rather
-- than merely usual.
order by pr.medicine_id, pr.supplier_id, pr.priced_at desc, pr.source_id desc;

comment on view public.medicine_vendor_prices is
  'Last price paid per medicine per active supplier, from received purchases and from batches that record their supplier. The only vendor data Staff may read (criterion A9, second scoped exception — see docs/UI-GUIDELINES-IMPLEMENTATION.md).';

-- Source B's driving predicate. Partial, because batches without a supplier
-- are the majority today and are never in this view.
create index if not exists idx_batches_medicine_supplier
  on public.inventory_batches(medicine_id, supplier_id)
  where supplier_id is not null;


-- ══════════════════════════════════════════
-- Document number. Same shape as next_purchase_number() (schema-06-10), so
-- REQ-2026-0001 sits beside PO-2026-0001 and both come from a sequence rather
-- than from count(*)+1, which two concurrent inserts would both read as 7.
-- ══════════════════════════════════════════
create sequence if not exists public.stock_requisition_seq start 1;

create or replace function public.next_requisition_number()
returns text
language plpgsql
as $$
begin
  return 'REQ-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('public.stock_requisition_seq')::text, 4, '0');
end; $$;


-- ══════════════════════════════════════════
-- stock_requisitions — one request, raised by one person, decided once.
-- ══════════════════════════════════════════
create table if not exists public.stock_requisitions (
  id                 uuid primary key default gen_random_uuid(),
  requisition_number text unique not null,                      -- REQ-2026-0001
  status             text not null default 'pending'
                       check (status in ('pending','approved','rejected','cancelled')),
  urgency            text not null default 'normal'
                       check (urgency in ('normal','urgent')),
  note               text,
  rejection_note     text,
  reviewed_by        uuid references public.users(id),
  reviewed_at        timestamptz,
  created_by         uuid not null references public.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- A decision and its timestamp arrive together or not at all. Without this a
  -- row can read 'approved' with no record of who approved it or when, and the
  -- export's "Approved by X on Y" header prints blanks on a document somebody
  -- is about to spend money against.
  constraint stock_requisitions_review_recorded
    check ((status in ('approved','rejected')) = (reviewed_at is not null)),

  -- A rejection note on an approved record is a contradiction, not extra info.
  constraint stock_requisitions_note_matches_status
    check (rejection_note is null or status = 'rejected')
);

comment on table public.stock_requisitions is
  'Staff-raised request for stock to be procured. Approving unlocks an export; it creates no purchase order and moves no stock.';

comment on column public.stock_requisitions.status is
  'pending | approved | rejected | cancelled. Deliberately no "ordered": nothing here creates a purchase order, and a status promising one that nothing can verify is the defect purchases.status has with partially_received. "cancelled" is the RAISER withdrawing — distinct from the owner rejecting, which carries a reason.';


-- ══════════════════════════════════════════
-- WHY supplier_name, unit_cost, mrp AND price_as_of ARE STORED HERE
--
-- At first reading this violates the rule the rest of this database is built
-- on: stock is SUM(inventory_ledger), margins are a view, supplier balances
-- are a view, adherence is a view, attendance status is a GENERATED column.
-- Every one of those is stored nowhere because every one of them answers
-- "what is true RIGHT NOW", and a second copy of a present-tense fact is a
-- copy that can disagree with the thing it was copied from.
--
-- These four are not that. They answer "what was on the screen when this
-- person chose this vendor, and what did the owner approve" — a past-tense
-- fact, whose only possible home is this row. The codebase already draws that
-- line twice and explicitly: bill_items.unit_price ("price snapshot …
-- snapshots protect historical accuracy") and customer_return_items.unit_price
-- ("snapshot from original bill").
--
-- Concretely, what deriving them at read time would do: the owner downloads
-- REQ-2026-0007 on Monday showing Laxmi at 92.50 and rings the order in. On
-- Tuesday an invoice lands at 104.00, medicine_vendor_prices moves, and the
-- same PDF re-downloaded under the same "Approved" stamp now prints 104.00.
-- The document would stop being evidence of anything, and the one number the
-- owner needs to check the delivery against would be the number that changed.
-- price_as_of is the honest half of the same point: it is what lets the owner
-- see that 92.50 is eight months old.
--
-- What is NOT snapshotted, deliberately: the medicine's name and unit. Those
-- are joined from public.medicines, exactly as purchase_items and
-- customer_return_items join them. A rename is rare, is not money, and nothing
-- downstream acts on it — so the snapshot set stays at the four fields that
-- would otherwise silently change the arithmetic on a document somebody spends
-- against.
-- ══════════════════════════════════════════
create table if not exists public.stock_requisition_items (
  id             uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references public.stock_requisitions(id) on delete cascade,
  medicine_id    uuid not null references public.medicines(id),
  qty            int  not null check (qty > 0),

  -- ── The vendor snapshot (see the block above) ──
  supplier_id    uuid          references public.suppliers(id),
  supplier_name  text,
  unit_cost      numeric(10,2) check (unit_cost >= 0),
  mrp            numeric(10,2) check (mrp >= 0),
  price_as_of    date,

  note           text,
  created_at     timestamptz not null default now(),

  -- One line per medicine. This is a request for a quantity with a suggested
  -- vendor, not a split order — if the owner wants 20 from one distributor and
  -- 10 from another they decide that when raising the actual PO, which this
  -- module deliberately does not do. It is also the race guard: two submits of
  -- the same draft collide here rather than both inserting.
  constraint stock_requisition_items_one_line_per_medicine
    unique (requisition_id, medicine_id),

  -- A vendor that was CHOSEN always has a name, whether or not we have ever
  -- bought this medicine from them. A vendor we have bought from always has a
  -- rate AND the date that rate is from — a price with no age is the one thing
  -- worse than no price, because it looks current.
  constraint stock_requisition_items_vendor_named
    check (supplier_id is null or supplier_name is not null),
  constraint stock_requisition_items_price_has_date
    check (unit_cost is null or price_as_of is not null)
);

comment on column public.stock_requisition_items.unit_cost is
  'Snapshot of medicine_vendor_prices.last_unit_cost at the moment the line was raised. Read from the database server-side, NEVER accepted from the client — see snapshotVendors() in the service.';

comment on column public.stock_requisition_items.supplier_id is
  'Null when the chosen distributor has no purchase history for this medicine (supplier_name is still set) or when no vendor was chosen at all.';


-- ══════════════════════════════════════════
-- Indexes and the updated_at trigger.
--
-- No updated_at on the items table: lines are written once with their parent
-- and are never edited. An edit is a new requisition — the old one is what the
-- owner already saw.
-- ══════════════════════════════════════════
create index if not exists idx_stock_req_status
  on public.stock_requisitions(status, created_at desc);
create index if not exists idx_stock_req_created_by
  on public.stock_requisitions(created_by, created_at desc);
create index if not exists idx_stock_req_items_req
  on public.stock_requisition_items(requisition_id);
create index if not exists idx_stock_req_items_med
  on public.stock_requisition_items(medicine_id);

drop trigger if exists stock_requisitions_updated_at on public.stock_requisitions;
create trigger stock_requisitions_updated_at
  before update on public.stock_requisitions
  for each row execute procedure public.handle_updated_at();


-- ══════════════════════════════════════════
-- stock_requisitions_with_totals — the list payload.
--
-- Derived columns go LAST and stay last. `create or replace view` can append a
-- column but cannot insert one mid-list or reorder — schema-27 had to DROP and
-- rebuild three views for exactly that reason. Nothing here selects `r.*`
-- either: a later column on stock_requisitions must be added to this list on
-- purpose, not arrive in every payload by accident.
--
-- unpriced_item_count is what lets the list say "3 lines have no rate" without
-- a second query. The owner needs to know that before opening the record, not
-- after.
-- ══════════════════════════════════════════
create or replace view public.stock_requisitions_with_totals
with (security_invoker = on) as
select
  r.id,
  r.requisition_number,
  r.status,
  r.urgency,
  r.note,
  r.rejection_note,
  r.reviewed_by,
  r.reviewed_at,
  r.created_by,
  r.created_at,
  r.updated_at,
  u.full_name                                        as created_by_name,
  a.full_name                                        as reviewed_by_name,
  count(i.id)                                        as item_count,
  coalesce(sum(i.qty), 0)                            as total_qty,
  coalesce(sum(i.qty * i.unit_cost), 0)              as estimated_total,
  count(i.id) filter (where i.unit_cost is null)     as unpriced_item_count,
  count(distinct i.supplier_id)                      as vendor_count
from public.stock_requisitions r
left join public.stock_requisition_items i on i.requisition_id = r.id
left join public.users u on u.id = r.created_by
left join public.users a on a.id = r.reviewed_by
group by r.id, u.full_name, a.full_name;


-- ══════════════════════════════════════════
-- Extend notifications.type.
--
-- The table is Module 16's; this CHECK has now been rewritten wholesale four
-- times (schema-15-20 → 21 → 26 → here) because a CHECK cannot be added to
-- incrementally. All nine existing values are restated below.
--
-- Dropping one of them here would not error. It would make every notification
-- of that type vanish SILENTLY, because notifications.service.js logs an
-- insert failure at WARN and returns undefined — the business operation
-- succeeds, the bell stays empty, and one warn line nobody reads is the only
-- evidence. If schema-21 or schema-26 is ever re-run after this file, re-run
-- this file too. docs/MIGRATION-ORDER.md carries the same warning.
--
-- Three new values, not one: the owner's queue notification and the staff
-- member's two outcome notifications have different audiences and different
-- destinations, and destinationFor(type, isOwner) on the client takes only the
-- type — it cannot read a discriminator out of metadata. Withdrawal raises no
-- notification at all: the dashboard card counts 'pending', so a withdrawn
-- request falls off the queue by itself, and a fourth value would be a fourth
-- chance to forget one in the next restatement.
-- ══════════════════════════════════════════
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('LOW_STOCK','NEAR_EXPIRY','CUSTOMER_RETURN_PENDING',
                  'SUPPLIER_RETURN_PENDING','SYSTEM','PURCHASE_OVERDUE','REFILL_OVERDUE',
                  'STAFF_CHECK_IN','STAFF_CHECK_OUT',
                  'STOCK_REQUISITION_RAISED','STOCK_REQUISITION_APPROVED',
                  'STOCK_REQUISITION_REJECTED'));


-- ══════════════════════════════════════════
-- RLS.
--
-- These are NOT what enforces the permission model — the API reaches these
-- tables on the service_role client, which bypasses RLS entirely, and
-- stock-requisitions.service.js is the control. They are the floor underneath
-- it, and they are written to be correct rather than merely present.
--
-- public.is_owner() rather than the inline `exists (select 1 from users …)`
-- every older policy in this database spells out. schema-29's header records
-- what that inline form actually does: reading public.users re-triggers users'
-- OWN policy, the cycle is caught at rewrite time, and the query dies with
-- 42P17. is_owner() is SECURITY DEFINER and does not re-enter RLS, so these
-- policies would actually work if a grant were ever restored.
--
-- drop-then-create because `create policy` has no IF NOT EXISTS form and
-- raises 42710 on a second run. (schema-26's own "safe to re-run" claim does
-- not hold for its policy block; this file's does.)
--
-- No DELETE policy anywhere. Nothing in this system is hard-deleted.
-- ══════════════════════════════════════════
alter table public.stock_requisitions      enable row level security;
alter table public.stock_requisition_items enable row level security;

drop policy if exists "self_read_requisitions"    on public.stock_requisitions;
drop policy if exists "owner_read_requisitions"   on public.stock_requisitions;
drop policy if exists "self_insert_requisitions"  on public.stock_requisitions;
drop policy if exists "self_update_requisitions"  on public.stock_requisitions;
drop policy if exists "owner_update_requisitions" on public.stock_requisitions;

create policy "self_read_requisitions" on public.stock_requisitions
  for select using (auth.uid() = created_by);
create policy "owner_read_requisitions" on public.stock_requisitions
  for select using (public.is_owner());
create policy "self_insert_requisitions" on public.stock_requisitions
  for insert with check (auth.uid() = created_by);
create policy "self_update_requisitions" on public.stock_requisitions
  for update using (auth.uid() = created_by);
create policy "owner_update_requisitions" on public.stock_requisitions
  for update using (public.is_owner());

drop policy if exists "self_read_requisition_items"   on public.stock_requisition_items;
drop policy if exists "owner_read_requisition_items"  on public.stock_requisition_items;
drop policy if exists "self_insert_requisition_items" on public.stock_requisition_items;

create policy "self_read_requisition_items" on public.stock_requisition_items
  for select using (exists (
    select 1 from public.stock_requisitions r
     where r.id = requisition_id and r.created_by = auth.uid()));
create policy "owner_read_requisition_items" on public.stock_requisition_items
  for select using (public.is_owner());
create policy "self_insert_requisition_items" on public.stock_requisition_items
  for insert with check (exists (
    select 1 from public.stock_requisitions r
     where r.id = requisition_id and r.created_by = auth.uid()));


-- ══════════════════════════════════════════
-- No GRANTs, by house rule. This explicit REVOKE makes the file correct
-- regardless of whether it runs before or after schema-29's blanket revoke and
-- ALTER DEFAULT PRIVILEGES — a table created by a role whose default
-- privileges were never rescinded would otherwise re-acquire exactly the grant
-- schema-29 exists to remove. Idempotent, and a no-op in the expected order.
-- ══════════════════════════════════════════
revoke all on public.stock_requisitions,
              public.stock_requisition_items,
              public.stock_requisitions_with_totals,
              public.medicine_vendor_prices
  from anon, authenticated;
