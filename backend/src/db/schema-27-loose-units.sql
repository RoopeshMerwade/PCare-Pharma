-- ============================================================
-- MODULE 27 — LOOSE UNITS (selling tablets out of an opened strip)
-- Run AFTER schema-26-staff-attendance.sql (see docs/MIGRATION-ORDER.md).
--
-- THE ONE THING THIS MIGRATION DOES NOT DO: change the denomination of
-- inventory_ledger. That table still counts SEALED SALEABLE UNITS — strips,
-- bottles, tubes, vials — exactly as medicines.unit names them, and exactly as
-- schema-25 restored after schema-24 got it wrong. Billing, FEFO, purchases,
-- returns and adjustments all keep moving whole units through it.
--
-- What is added is a SECOND, parallel ledger counted in CONTENT units
-- (tablets/capsules/pieces), and one new transition that connects the two:
--
--     open a strip  →  inventory_ledger  -1  'strip_opened'
--                      loose_unit_ledger +10 'strip_opened'
--     sell 2        →  loose_unit_ledger  -2 'sale'
--
-- An auditor reading the two ledgers side by side sees: 100 strips received,
-- one opened, two tablets sold, eight loose remaining. Nothing is a counter
-- that someone incremented — every number is a SUM over immutable rows, which
-- is the same rule the sealed ledger has always followed.
--
-- WHY A SECOND LEDGER RATHER THAN A `remaining_loose_quantity` COLUMN:
-- a mutable counter on the batch would be the only stock figure in this
-- database that is stored rather than computed, and the only one with no
-- history explaining how it got there. `prevent_negative_stock` and
-- `block_ledger_mutation` have exact mirrors here, so loose stock inherits the
-- same guarantees as sealed stock instead of a weaker set.
--
-- WHY ONE AGGREGATE ROW PER BATCH RATHER THAN ONE PER OPENED STRIP:
-- nothing in this domain identifies an individual strip. inventory_batches is
-- the finest-grained physical thing the system knows about, and expiry — the
-- only reason loose stock must stay tied to its origin — lives on the batch.
-- Two half-strips of the same batch are indistinguishable on the shelf and in
-- law, so eight loose tablets against batch A is the whole truth.
-- ============================================================


-- ── 27.0  Prerequisite check ────────────────────────────────────────────────
--
-- 27.12 replaces commit_supplier_invoice() with a version that reads
-- pack_recognised / content_quantity / content_unit from supplier_invoice_items
-- — columns schema-25 creates. PL/pgSQL does not resolve column references at
-- CREATE FUNCTION time, so on a database still at schema-23 this file would
-- install cleanly and then fail at the moment someone imports an invoice, with
-- an error naming a record field rather than a missing migration.
--
-- Failing here instead costs nothing and says what to do. Run steps 12 and 13
-- from docs/MIGRATION-ORDER.md first.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'supplier_invoice_items'
       and column_name  = 'pack_recognised'
  ) then
    raise exception using
      errcode = 'undefined_column',
      message = 'MIGRATION_OUT_OF_ORDER: schema-25-pack-contents.sql has not been applied',
      hint    = 'Run schema-24-invoice-line-detail.sql then schema-25-pack-contents.sql first (steps 12 and 13 in docs/MIGRATION-ORDER.md), then re-run this file. Nothing has been changed.';
  end if;
end $$;


-- ── 27.1  Pack contents on the catalogue ────────────────────────────────────
--
-- Until now "10 tablets per strip" existed in exactly one place in this
-- database: supplier_invoice_items, populated by Module 23's parsePack(). It
-- was deliberately kept there and deliberately kept out of stock arithmetic.
-- Splitting a strip is the first operation that genuinely needs the number, so
-- it now has a home on the catalogue row and on the batch.
--
-- Mirrors the medicine/batch pair that default_selling_price and
-- inventory_batches.selling_price already form: the medicine states the
-- standard pack, a batch may state what actually arrived.

alter table public.medicines
  add column if not exists pack_content_quantity int,
  add column if not exists pack_content_unit     text;

-- The vocabulary is parsePack()'s, not a second one invented here. Keeping the
-- two lists identical is what stops "100'S" meaning one thing on an invoice
-- review screen and another at the counter.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'medicines_pack_content_unit_check'
  ) then
    alter table public.medicines
      add constraint medicines_pack_content_unit_check
      check (pack_content_unit is null or pack_content_unit in
        ('TABLET','CAPSULE','PIECE','MCG','MG','KG','GM','ML','L','DOSE','IU'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'medicines_pack_content_quantity_check'
  ) then
    alter table public.medicines
      add constraint medicines_pack_content_quantity_check
      check (pack_content_quantity is null or pack_content_quantity > 0);
  end if;
end $$;

comment on column public.medicines.pack_content_quantity is
  'What is inside ONE saleable unit of the standard pack: 10 for a 10-tablet strip. '
  'Informational for every module except loose sales, which divide by it. '
  'NEVER a multiplier on stock — inventory_ledger still counts strips.';
comment on column public.medicines.pack_content_unit is
  'Content unit from parsePack(). Only TABLET/CAPSULE/PIECE can be sold loose; '
  'ML/GM/DOSE are measured contents of a sealed container and never splittable.';


-- ── 27.2  Pack contents on the batch ────────────────────────────────────────
--
-- A batch of 15s under a medicine catalogued as 10s is an ordinary occurrence,
-- and opening one has to yield fifteen tablets, not ten. The batch column wins
-- where it is set; the catalogue is the fallback for the batches that predate
-- this migration.

alter table public.inventory_batches
  add column if not exists content_quantity int,
  add column if not exists content_unit     text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_batches_content_unit_check'
  ) then
    alter table public.inventory_batches
      add constraint inventory_batches_content_unit_check
      check (content_unit is null or content_unit in
        ('TABLET','CAPSULE','PIECE','MCG','MG','KG','GM','ML','L','DOSE','IU'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'inventory_batches_content_quantity_check'
  ) then
    alter table public.inventory_batches
      add constraint inventory_batches_content_quantity_check
      check (content_quantity is null or content_quantity > 0);
  end if;
end $$;

comment on column public.inventory_batches.content_quantity is
  'What is actually inside one unit of THIS batch. Overrides '
  'medicines.pack_content_quantity when set. Opening one unit of this batch '
  'credits exactly this many loose units.';


-- ── 27.3  Countability ──────────────────────────────────────────────────────
--
-- The single definition of "can this be sold loose", used by the trigger, the
-- views and (mirrored in JS) by the API. A tube of 30GM ointment is not thirty
-- of anything a customer can buy; a 120MD inhaler is not 120 saleable doses.
-- Only a countable content unit describes discrete objects inside the pack.
--
-- content_quantity must exceed 1: a pack of one is already its own smallest
-- unit, and "opening" it would produce a second denomination for the same
-- physical object.

create or replace function public.is_countable_content(p_unit text)
returns boolean
language sql
immutable
as $$ select p_unit in ('TABLET', 'CAPSULE', 'PIECE') $$;

comment on function public.is_countable_content(text) is
  'Mirror of perContentUnitPrice()''s countable test in supplier-invoices.normalize.js. '
  'Keep the two in step — they are the same business rule in two languages.';


-- ── 27.4  Sealed ledger: one new reason ─────────────────────────────────────
--
-- 'strip_opened' is deliberately NOT 'sale'. The strip has not been sold — it
-- has changed denomination, and the money for it arrives later, in pieces.
-- Anything summing reason = 'sale' for revenue would otherwise double-count it
-- against the loose sales that follow.

alter table public.inventory_ledger drop constraint if exists inventory_ledger_reason_check;
alter table public.inventory_ledger
  add constraint inventory_ledger_reason_check
  check (reason in (
    'purchase_receipt','opening_stock','sale',
    'return_inward','return_outward','adjustment','expiry_writeoff',
    'strip_opened'
  ));


-- ── 27.5  The loose ledger ──────────────────────────────────────────────────
--
-- Append-only, per batch, counted in content units. No 'purchase_receipt':
-- loose stock is never delivered by a distributor, it is only ever created by
-- opening something. No 'return_outward' for the same reason — a debit note
-- covers sealed goods. An opening balance of loose tablets at go-live is an
-- 'adjustment', which forces the note that explains it.

create table if not exists public.loose_unit_ledger (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid        not null references public.inventory_batches(id),
  change_qty    int         not null check (change_qty <> 0),
  reason        text        not null
                  check (reason in (
                    'strip_opened','sale','return_inward','adjustment','expiry_writeoff'
                  )),
  ref_id        uuid,         -- bill_id, return_id, adjustment ref
  note          text,
  created_by    uuid references public.users(id),
  created_at    timestamptz not null default now()
  -- NO update / delete ever. Append only, exactly like inventory_ledger.
);

create index if not exists idx_loose_ledger_batch_id   on public.loose_unit_ledger(batch_id);
create index if not exists idx_loose_ledger_created_at on public.loose_unit_ledger(created_at desc);
create index if not exists idx_loose_ledger_reason     on public.loose_unit_ledger(reason);
-- The FEFO read is "loose balance for these batches": batch_id + change_qty
-- covers it index-only, which is the hot path on every loose sale.
create index if not exists idx_loose_ledger_balance    on public.loose_unit_ledger(batch_id) include (change_qty);

alter table public.loose_unit_ledger enable row level security;

create policy "authenticated_read_loose_ledger" on public.loose_unit_ledger
  for select using (auth.uid() is not null);
create policy "authenticated_insert_loose_ledger" on public.loose_unit_ledger
  for insert with check (auth.uid() is not null);
-- No UPDATE or DELETE policy — append only, enforced by RLS and by trigger.


-- ── 27.6  Loose ledger guards ───────────────────────────────────────────────
--
-- Two things the sealed ledger's trigger does, plus one it does not need.
--
-- The row lock is the addition. inventory_ledger relies on its callers taking
-- `FOR UPDATE` on the batch before writing (schema-22 does this in every
-- atomic function), which is correct but leaves a caller that forgets with a
-- racy SUM. Taking the lock inside the trigger makes the check self-contained:
-- a caller that already holds it re-locks its own row for free, and a caller
-- that does not gets serialised anyway. Two tills selling the last four loose
-- tablets can no longer both pass.

create or replace function public.check_no_negative_loose_stock()
returns trigger language plpgsql as $$
declare
  v_current int;
  v_content int;
  v_unit    text;
begin
  -- Serialise every loose movement for this batch behind the batch row — the
  -- same row create_bill_atomic locks, which is what makes the two
  -- denominations queue behind one mutex. (A batch_id that matches nothing
  -- simply locks nothing; the foreign key is what rejects it.)
  perform 1 from public.inventory_batches where id = NEW.batch_id for update;

  select coalesce(b.content_quantity, m.pack_content_quantity),
         coalesce(b.content_unit,     m.pack_content_unit)
    into v_content, v_unit
    from public.inventory_batches b
    join public.medicines m on m.id = b.medicine_id
   where b.id = NEW.batch_id;

  -- A batch nobody has described cannot be split. Refusing here rather than
  -- defaulting to some assumed pack size is the whole point: a guessed content
  -- quantity would put a wrong number of tablets on the shelf and nothing
  -- downstream could tell.
  --
  -- The test applies to POSITIVE movements only. Taking loose units out —
  -- selling them, writing them off, correcting a miscount — must stay possible
  -- even if the pack description is later changed or cleared, or that stock
  -- would be stranded: unsellable, unwritable-off, and still on the books.
  -- Creating loose units still requires a description, which is the direction
  -- that matters.
  if NEW.change_qty > 0
     and (v_content is null or not public.is_countable_content(v_unit) or v_content <= 1) then
    raise exception 'NOT_SPLITTABLE: batch % is not sold in countable contents', NEW.batch_id;
  end if;

  if NEW.change_qty < 0 then
    select coalesce(sum(change_qty), 0) into v_current
      from public.loose_unit_ledger where batch_id = NEW.batch_id;
    if v_current + NEW.change_qty < 0 then
      raise exception 'INSUFFICIENT_LOOSE_STOCK: batch would go below 0 (current: %, requested: %)',
        v_current, abs(NEW.change_qty);
    end if;
  end if;

  return NEW;
end; $$;

drop trigger if exists prevent_negative_loose_stock on public.loose_unit_ledger;
create trigger prevent_negative_loose_stock
  before insert on public.loose_unit_ledger
  for each row execute procedure public.check_no_negative_loose_stock();

drop trigger if exists block_loose_ledger_update on public.loose_unit_ledger;
create trigger block_loose_ledger_update before update on public.loose_unit_ledger
  for each row execute procedure public.block_ledger_mutation();

drop trigger if exists block_loose_ledger_delete on public.loose_unit_ledger;
create trigger block_loose_ledger_delete before delete on public.loose_unit_ledger
  for each row execute procedure public.block_ledger_mutation();


-- ── 27.7  Views ─────────────────────────────────────────────────────────────
--
-- batches_with_stock and medicines_with_stock select `b.*` / `m.*`, and 27.1
-- and 27.2 added columns in the middle of those expansions. CREATE OR REPLACE
-- VIEW can only append columns, so both are dropped and rebuilt — along with
-- expiry_summary, which selects `bws.*` from the first.

drop view if exists public.expiry_summary;
drop view if exists public.batches_with_stock;
drop view if exists public.medicines_with_stock;

-- The opened-stock entity, as a view rather than a table. `first_opened_at`
-- and `last_movement_at` give the audit trail its bookends without anyone
-- having to maintain a status column that could contradict the rows under it.
create or replace view public.batch_loose_stock as
select
  batch_id,
  coalesce(sum(change_qty), 0)::int                            as loose_qty,
  min(created_at) filter (where reason = 'strip_opened')       as first_opened_at,
  max(created_at)                                              as last_movement_at,
  coalesce(sum(change_qty) filter (where reason = 'strip_opened'), 0)::int
                                                               as units_ever_opened
from public.loose_unit_ledger
group by batch_id;

comment on view public.batch_loose_stock is
  'Loose (opened-pack) balance per batch, summed from loose_unit_ledger. '
  'The "OpenedStock" entity — computed, never stored, so it cannot drift.';

-- Scalar subqueries rather than two LEFT JOINs: joining both ledgers and
-- grouping would multiply each ledger''s rows by the other''s and inflate both
-- sums. stock_qty keeps its exact old meaning and old name; sealed_qty is an
-- alias for callers that want to be explicit about which pool they mean.
create or replace view public.batches_with_stock as
select
  b.*,
  m.name          as medicine_name,
  m.unit          as medicine_unit,
  mc.name         as category_name,
  mc.color        as category_color,
  coalesce((
    select sum(l.change_qty) from public.inventory_ledger l where l.batch_id = b.id
  ), 0)::int as stock_qty,
  case
    when b.exp_date < current_date then 'expired'
    when b.exp_date <= current_date + interval '90 days' then 'near_expiry'
    else 'ok'
  end as expiry_status,
  -- ── loose-unit columns (appended; everything above is unchanged) ──
  coalesce((
    select sum(l.change_qty) from public.inventory_ledger l where l.batch_id = b.id
  ), 0)::int as sealed_qty,
  coalesce((
    select sum(ll.change_qty) from public.loose_unit_ledger ll where ll.batch_id = b.id
  ), 0)::int as loose_qty,
  coalesce(b.content_quantity, m.pack_content_quantity) as effective_content_quantity,
  coalesce(b.content_unit,     m.pack_content_unit)     as effective_content_unit,
  -- coalesced to false, not left as NULL: `true and NULL` is NULL in SQL, so an
  -- unrecorded quantity beside a countable unit would otherwise answer "don't
  -- know" to a question the API treats as a yes/no.
  coalesce(
    public.is_countable_content(coalesce(b.content_unit, m.pack_content_unit))
    and coalesce(b.content_quantity, m.pack_content_quantity) > 1,
    false
  ) as loose_sale_supported
from public.inventory_batches b
join public.medicines m on m.id = b.medicine_id
join public.medicine_categories mc on mc.id = m.category_id;

create or replace view public.medicines_with_stock as
select
  m.*,
  mc.name  as category_name,
  mc.color as category_color,
  coalesce((
    select sum(il.change_qty)
    from public.inventory_batches ib
    join public.inventory_ledger  il on il.batch_id = ib.id
    where ib.medicine_id = m.id
  ), 0) as total_stock,
  coalesce((
    select count(*)
    from public.inventory_batches ib
    where ib.medicine_id = m.id
      and ib.exp_date <= (current_date + interval '90 days')
      and ib.exp_date >= current_date
  ), 0) as near_expiry_batch_count,
  coalesce((
    select sum(il.change_qty)
    from public.inventory_batches ib
    join public.inventory_ledger  il on il.batch_id = ib.id
    where ib.medicine_id = m.id
  ), 0) < m.low_stock_threshold as is_low_stock,
  -- ── loose-unit columns (appended) ──
  -- total_stock deliberately still counts SEALED units only. It feeds
  -- is_low_stock, the reorder thresholds and every "12 strips" label in the
  -- app; folding part-strips into it would change what every one of those
  -- numbers means.
  coalesce((
    select sum(ll.change_qty)
    from public.inventory_batches ib
    join public.loose_unit_ledger ll on ll.batch_id = ib.id
    where ib.medicine_id = m.id
  ), 0) as total_loose_stock,
  coalesce(
    public.is_countable_content(m.pack_content_unit) and m.pack_content_quantity > 1,
    false
  ) as loose_sale_supported
from public.medicines m
join public.medicine_categories mc on mc.id = m.category_id;

-- Rebuilt because it selects bws.*. Two changes of substance: a batch holding
-- only loose tablets still has stock and must still appear, and the value at
-- risk includes those tablets at their share of the unit cost.
create or replace view public.expiry_summary as
select
  bws.*,
  case
    when bws.exp_date < current_date                          then 'expired'
    when bws.exp_date <= current_date + interval '30 days'   then 'critical'
    when bws.exp_date <= current_date + interval '60 days'   then 'warning'
    when bws.exp_date <= current_date + interval '90 days'   then 'watch'
    else 'ok'
  end as urgency,
  (
    bws.stock_qty * bws.unit_cost
    + case
        when coalesce(bws.effective_content_quantity, 0) > 0
        then bws.loose_qty * (bws.unit_cost / bws.effective_content_quantity)
        else 0
      end
  ) as potential_loss_value,
  (bws.exp_date - current_date) as days_to_expiry
from public.batches_with_stock bws
where bws.stock_qty > 0 or bws.loose_qty > 0
order by bws.exp_date asc;


-- ── 27.8  Bill lines carry their denomination ───────────────────────────────
--
-- bill_items.qty has always meant "saleable units". A loose line means
-- tablets, and the two cannot share a column without a flag saying which —
-- that is precisely the mistake schema-25 had to undo one layer down.
--
-- Defaulting to false is what makes this migration invisible to every existing
-- row and every existing query: nothing was loose before it ran.

alter table public.bill_items
  add column if not exists is_loose              boolean not null default false,
  add column if not exists pack_content_quantity int;

comment on column public.bill_items.is_loose is
  'false: qty is sealed saleable units (strips) and unit_price is the price of one. '
  'true: qty is content units (tablets) out of an opened pack and unit_price is '
  'the per-tablet share. The flag is what keeps the two denominations apart in '
  'one column — never infer it from the quantity.';
comment on column public.bill_items.pack_content_quantity is
  'Contents per sealed unit at the moment of sale. A price snapshot in the same '
  'spirit as unit_price/mrp: re-cataloguing a pack later must not retroactively '
  'change what an old bill''s margin was.';

create index if not exists idx_bill_items_loose on public.bill_items(is_loose) where is_loose;


-- ── 27.9  Margin analytics: cost in the denomination that was sold ──────────
--
-- inventory_batches.unit_cost is the cost of a whole strip. A loose line's
-- unit_price is the price of one tablet. Comparing them directly reports a
-- ruinous negative margin on every split sale — the view has to divide the
-- cost by the same pack it divided the price by.

create or replace view public.margin_analytics as
select
  m.id             as medicine_id,
  m.name           as medicine_name,
  mc.name          as category_name,
  mc.color         as category_color,
  count(bi.id)     as times_sold,
  sum(bi.qty)      as total_qty_sold,
  avg(bi.unit_price::numeric)                                   as avg_selling_price,
  avg(c.effective_cost)                                         as avg_unit_cost,
  avg((bi.unit_price - c.effective_cost)::numeric)              as avg_margin_rupees,
  case when avg(bi.unit_price::numeric) > 0
       then avg(((bi.unit_price - c.effective_cost) / bi.unit_price)::numeric) * 100
       else 0 end                                               as avg_margin_pct,
  sum((bi.qty * (bi.unit_price - c.effective_cost))::numeric)   as total_margin_earned
from public.bill_items bi
join public.inventory_batches ib on ib.id = bi.batch_id
join public.medicines m          on m.id  = bi.medicine_id
join public.medicine_categories mc on mc.id = m.category_id
cross join lateral (
  select case
    when bi.is_loose and coalesce(bi.pack_content_quantity, 0) > 0
      then ib.unit_cost::numeric / bi.pack_content_quantity
    else ib.unit_cost::numeric
  end as effective_cost
) c
group by m.id, m.name, mc.name, mc.color;


-- ── 27.10  create_bill_atomic — sealed lines, loose lines, or both ──────────
--
-- p_items entries are one of two shapes, both FEFO-resolved by the API:
--
--   sealed  {medicine_id, batch_id, qty, unit_price, mrp}
--   loose   {medicine_id, batch_id, qty, unit_price, mrp, is_loose: true,
--            content_quantity, strips_to_open}
--
-- `strips_to_open` is how many sealed units this line must break to cover its
-- quantity — computed by the allocator against a stock read that may already
-- be stale by the time this runs. That is safe, and it is safe for the same
-- reason the existing sealed path is: both ledgers' triggers re-check against
-- the locked, committed balance, so a stale figure can only abort the whole
-- transaction. It can never post a wrong one.
--
-- Absent is_loose, this behaves byte-for-byte as before.
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


-- ── 27.11  approve_customer_return_atomic — return to the pool it came from ─
--
-- Which ledger a returned line goes back to is not a new field on the return:
-- it is bill_items.is_loose, joined through the bill_item_id the return
-- already carries. A denormalised copy could disagree with the line it
-- describes; a join cannot.
--
-- Loose tablets come back as loose tablets. There is no path from here to a
-- sealed strip, because an opened strip cannot be re-sealed — restoring one
-- would invent a saleable unit that does not exist on the shelf.
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

  perform 1 from public.inventory_batches b
   where b.id in (select batch_id from public.customer_return_items where return_id = p_return_id)
   order by b.id
   for update;

  insert into public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
  select cri.batch_id, cri.qty_returned, 'return_inward', p_return_id,
         'Customer return: ' || v_return_number, p_user_id
  from public.customer_return_items cri
  join public.bill_items bi on bi.id = cri.bill_item_id
  where cri.return_id = p_return_id and not bi.is_loose;

  insert into public.loose_unit_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
  select cri.batch_id, cri.qty_returned, 'return_inward', p_return_id,
         'Customer return: ' || v_return_number, p_user_id
  from public.customer_return_items cri
  join public.bill_items bi on bi.id = cri.bill_item_id
  where cri.return_id = p_return_id and bi.is_loose;

  select coalesce(sum(qty_returned * unit_price), 0) into v_refund
    from public.customer_return_items where return_id = p_return_id;

  update public.customer_returns set refund_amount = v_refund where id = p_return_id;

  return v_refund;
end; $$;


-- ── 27.12  commit_supplier_invoice — carry the pack through to the batch ────
--
-- Module 23 already parses "10'S" into 10 PIECE and has done since schema-25;
-- it just had nowhere to put the answer. Two INSERT columns and a backfill of
-- the catalogue's blank, which is the whole change. v_units is untouched:
-- stock in is still qty_billed + qty_free, still in saleable units.
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

    -- Saleable units, the denomination inventory_ledger is counted in.
    -- The pack contents describe what is inside each unit and take no part here.
    v_units := coalesce(v_item.qty_billed, 0) + coalesce(v_item.qty_free, 0);
    if v_units <= 0 then
      raise exception 'MISSING_QTY: line % has no quantity', v_item.line_no;
    end if;

    insert into public.inventory_batches
      (medicine_id, batch_no, exp_date, mfg_date, unit_cost, mrp, selling_price,
       supplier_id, po_id, created_by, content_quantity, content_unit)
    values
      (v_item.medicine_id, upper(trim(v_item.batch_no)), v_item.exp_date, v_item.mfg_date,
       v_item.unit_cost, v_item.mrp, v_item.selling_price,
       v_inv.supplier_id, v_purchase_id, p_user_id,
       -- Only a pack parsePack() actually recognised. An unparsed pack stays
       -- null and the batch simply cannot be split — which is the right answer,
       -- not a degraded one.
       case when v_item.pack_recognised then v_item.content_quantity::int else null end,
       case when v_item.pack_recognised then v_item.content_unit else null end)
    returning id into v_batch_id;

    -- Fill a blank on the catalogue, never overwrite a curated value: the
    -- owner's entry is a decision, this is only an inference from one invoice.
    update public.medicines
       set pack_content_quantity = case when v_item.pack_recognised then v_item.content_quantity::int end,
           pack_content_unit     = case when v_item.pack_recognised then v_item.content_unit end
     where id = v_item.medicine_id
       and pack_content_quantity is null
       and v_item.pack_recognised
       and v_item.content_quantity is not null;

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


-- These run with definer rights; the API calls them via the service-role client.
revoke execute on function public.create_bill_atomic(jsonb, jsonb) from anon;
revoke execute on function public.approve_customer_return_atomic(uuid, uuid) from anon;
revoke execute on function public.commit_supplier_invoice(uuid, uuid) from anon;
revoke execute on function public.is_countable_content(text) from anon;
