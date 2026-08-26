-- ============================================================
-- MODULE 05 — INVENTORY (BATCH-WISE)
-- Prerequisite: Module 04 (medicines) must exist
-- ============================================================

-- ── inventory_batches: one row per physical batch on the shelf
create table if not exists public.inventory_batches (
  id            uuid primary key default gen_random_uuid(),
  medicine_id   uuid        not null references public.medicines(id),
  batch_no      text        not null,
  mfg_date      date,
  exp_date      date        not null,
  unit_cost     numeric(10,2) not null check (unit_cost >= 0),   -- purchase price
  mrp           numeric(10,2) not null check (mrp > 0),          -- MRP on the strip
  selling_price numeric(10,2) not null check (selling_price > 0  -- can be ≤ MRP
                                               and selling_price <= mrp),
  supplier_id   uuid,         -- filled when created via goods receipt (Module 06)
  po_id         uuid,         -- filled when created via PO receipt (Module 08)
  created_by    uuid references public.users(id),
  created_at    timestamptz not null default now()
);

-- Unique batch number per medicine (same batch from two suppliers = two rows)
create unique index idx_batch_medicine_batchno
  on public.inventory_batches(medicine_id, lower(batch_no));

-- Fast lookup: medicine + expiry (FEFO queries)
create index idx_batch_exp_date
  on public.inventory_batches(medicine_id, exp_date asc);

-- ── inventory_ledger: append-only stock movement log
create table if not exists public.inventory_ledger (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid        not null references public.inventory_batches(id),
  change_qty    int         not null,   -- positive = in, negative = out
  reason        text        not null
                  check (reason in (
                    'purchase_receipt','opening_stock','sale',
                    'return_inward','return_outward','adjustment','expiry_writeoff'
                  )),
  ref_id        uuid,         -- sale_id, purchase_id, adjustment_id etc.
  note          text,         -- required for 'adjustment' and 'expiry_writeoff'
  created_by    uuid references public.users(id),
  created_at    timestamptz not null default now()
  -- NO update / delete ever. Append only.
);

-- Fast aggregate queries: stock per batch
create index idx_ledger_batch_id   on public.inventory_ledger(batch_id);
create index idx_ledger_created_at on public.inventory_ledger(created_at desc);
create index idx_ledger_reason     on public.inventory_ledger(reason);

-- RLS
alter table public.inventory_batches enable row level security;
alter table public.inventory_ledger  enable row level security;

create policy "authenticated_read_batches" on public.inventory_batches
  for select using (auth.uid() is not null);

create policy "authenticated_insert_batches" on public.inventory_batches
  for insert with check (auth.uid() is not null);

create policy "authenticated_read_ledger" on public.inventory_ledger
  for select using (auth.uid() is not null);

create policy "authenticated_insert_ledger" on public.inventory_ledger
  for insert with check (auth.uid() is not null);

-- No UPDATE or DELETE policy on ledger — append only enforced at DB level
-- (No update/delete policies = Postgres rejects them even for service role via RLS)

-- ── View: batches with computed stock (NEVER stored qty)
create or replace view public.batches_with_stock as
select
  b.*,
  m.name          as medicine_name,
  m.unit          as medicine_unit,
  mc.name         as category_name,
  mc.color        as category_color,
  coalesce(sum(l.change_qty), 0)::int as stock_qty,
  case
    when b.exp_date < current_date then 'expired'
    when b.exp_date <= current_date + interval '90 days' then 'near_expiry'
    else 'ok'
  end as expiry_status
from public.inventory_batches b
join public.medicines m on m.id = b.medicine_id
join public.medicine_categories mc on mc.id = m.category_id
left join public.inventory_ledger l on l.batch_id = b.id
group by b.id, m.id, mc.id;

-- ── View: medicines with computed stock + category info (moved from medicines.sql —
-- it needs public.inventory_batches / inventory_ledger, created here)
-- Stock is ALWAYS computed from the ledger — never stored on the medicine row
create or replace view public.medicines_with_stock as
select
  m.*,
  mc.name  as category_name,
  mc.color as category_color,
  -- total stock across ALL batches (computed, never stored)
  coalesce((
    select sum(il.change_qty)
    from public.inventory_batches ib
    join public.inventory_ledger  il on il.batch_id = ib.id
    where ib.medicine_id = m.id
  ), 0) as total_stock,
  -- count of batches expiring within 90 days
  coalesce((
    select count(*)
    from public.inventory_batches ib
    where ib.medicine_id = m.id
      and ib.exp_date <= (current_date + interval '90 days')
      and ib.exp_date >= current_date
  ), 0) as near_expiry_batch_count,
  -- is below threshold?
  coalesce((
    select sum(il.change_qty)
    from public.inventory_batches ib
    join public.inventory_ledger  il on il.batch_id = ib.id
    where ib.medicine_id = m.id
  ), 0) < m.low_stock_threshold as is_low_stock
from public.medicines m
join public.medicine_categories mc on mc.id = m.category_id;

-- ── Function: prevent negative stock at ledger insert
create or replace function public.check_no_negative_stock()
returns trigger language plpgsql as $$
declare current_stock int;
begin
  if NEW.change_qty < 0 then
    select coalesce(sum(change_qty), 0) into current_stock
    from public.inventory_ledger where batch_id = NEW.batch_id;
    if current_stock + NEW.change_qty < 0 then
      raise exception 'INSUFFICIENT_STOCK: Batch would go below 0 (current: %, requested: %)',
        current_stock, abs(NEW.change_qty);
    end if;
  end if;
  return NEW;
end; $$;

create trigger prevent_negative_stock
  before insert on public.inventory_ledger
  for each row execute procedure public.check_no_negative_stock();

-- ── Function: prevent updates/deletes on ledger (belt + braces with RLS)
create or replace function public.block_ledger_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'LEDGER_IMMUTABLE: inventory_ledger rows cannot be updated or deleted.';
end; $$;

create trigger block_ledger_update before update on public.inventory_ledger
  for each row execute procedure public.block_ledger_mutation();

create trigger block_ledger_delete before delete on public.inventory_ledger
  for each row execute procedure public.block_ledger_mutation();
