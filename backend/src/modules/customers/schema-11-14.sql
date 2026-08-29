-- ============================================================
-- MODULES 11–14: Customers, Customer Returns,
--                Supplier Returns, Expiry Management
-- Prerequisites: Modules 01–10 must exist
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- MODULE 11: CUSTOMERS
-- ════════════════════════════════════════════════════════════

create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  phone         text        unique,    -- primary identifier; null for anonymous
  email         text,
  date_of_birth date,
  address       text,
  notes         text,
  is_active     boolean     not null default true,
  created_by    uuid        references public.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_customers_phone  on public.customers(phone)      where phone is not null;
create index idx_customers_name   on public.customers(lower(name));
create index idx_customers_active on public.customers(is_active);

create trigger customers_updated_at before update on public.customers
  for each row execute procedure public.handle_updated_at();

alter table public.customers enable row level security;
create policy "authenticated_read_customers" on public.customers
  for select using (auth.uid() is not null);
create policy "authenticated_create_customer" on public.customers
  for insert with check (auth.uid() is not null);
create policy "owner_update_customer" on public.customers
  for update using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- View: customers with aggregated purchase stats (optimized single-pass aggregation)
create or replace view public.customers_with_stats as
with bill_lines as (
  select
    b.id as bill_id,
    coalesce(b.customer_id, c.id) as customer_id,
    b.created_at,
    (coalesce(sum(bi.qty * bi.unit_price), 0::numeric) - coalesce(b.discount_amount, 0::numeric)) as total,
    count(bi.id) as item_count
  from public.bills b
  join public.customers c on (b.customer_id = c.id or (b.customer_id is null and b.customer_phone = c.phone and c.phone is not null))
  left join public.bill_items bi on bi.bill_id = b.id
  group by b.id, coalesce(b.customer_id, c.id)
),
cust_totals as (
  select
    customer_id,
    count(bill_id)::bigint as total_bills,
    coalesce(sum(total), 0::numeric) as total_spent,
    max(created_at) as last_purchase_at,
    coalesce(sum(item_count), 0)::numeric as total_items_purchased
  from bill_lines
  group by customer_id
)
select
  c.*,
  coalesce(ct.total_bills, 0::bigint) as total_bills,
  coalesce(ct.total_spent, 0::numeric) as total_spent,
  ct.last_purchase_at,
  coalesce(ct.total_items_purchased, 0::numeric) as total_items_purchased
from public.customers c
left join cust_totals ct on ct.customer_id = c.id;

-- ════════════════════════════════════════════════════════════
-- MODULE 12: CUSTOMER RETURNS
-- ════════════════════════════════════════════════════════════

create sequence if not exists public.customer_return_seq start 1;

create table if not exists public.customer_returns (
  id              uuid primary key default gen_random_uuid(),
  return_number   text unique not null,         -- CR-2026-0001
  bill_id         uuid not null references public.bills(id),
  customer_name   text not null,
  customer_phone  text,
  reason          text not null,
  refund_mode     text not null
                    check (refund_mode in ('cash','upi','credit_note')),
  refund_amount   numeric(10,2),               -- computed on approval
  status          text not null default 'pending'
                    check (status in ('pending','approved','rejected')),
  rejection_note  text,
  notes           text,
  approved_by     uuid references public.users(id),
  approved_at     timestamptz,
  created_by      uuid references public.users(id),
  created_at      timestamptz not null default now()
);

create table if not exists public.customer_return_items (
  id               uuid primary key default gen_random_uuid(),
  return_id        uuid not null references public.customer_returns(id) on delete cascade,
  bill_item_id     uuid not null references public.bill_items(id),
  batch_id         uuid not null references public.inventory_batches(id),
  medicine_id      uuid not null references public.medicines(id),
  qty_returned     int  not null check (qty_returned > 0),
  unit_price       numeric(10,2) not null,     -- snapshot from original bill
  created_at       timestamptz not null default now()
);

create index idx_cr_bill       on public.customer_returns(bill_id);
create index idx_cr_status     on public.customer_returns(status);
create index idx_cr_items_ret  on public.customer_return_items(return_id);

alter table public.customer_returns       enable row level security;
alter table public.customer_return_items  enable row level security;

create policy "authenticated_read_cr" on public.customer_returns
  for select using (auth.uid() is not null);
create policy "authenticated_insert_cr" on public.customer_returns
  for insert with check (auth.uid() is not null);
create policy "owner_update_cr" on public.customer_returns
  for update using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );
create policy "authenticated_read_cr_items" on public.customer_return_items
  for select using (auth.uid() is not null);
create policy "authenticated_insert_cr_items" on public.customer_return_items
  for insert with check (auth.uid() is not null);

create or replace function public.next_customer_return_number()
returns text language plpgsql as $$
begin return 'CR-' || to_char(now(),'YYYY') || '-' || lpad(nextval('customer_return_seq')::text,4,'0'); end; $$;

-- View: returns with computed totals
create or replace view public.customer_returns_with_totals as
select
  cr.*,
  u.full_name as created_by_name,
  a.full_name as approved_by_name,
  coalesce(sum(i.qty_returned * i.unit_price), 0) as item_total,
  count(i.id) as item_count
from public.customer_returns cr
left join public.customer_return_items i on i.return_id = cr.id
left join public.users u on u.id = cr.created_by
left join public.users a on a.id = cr.approved_by
group by cr.id, u.full_name, a.full_name;

-- ════════════════════════════════════════════════════════════
-- MODULE 13: SUPPLIER RETURNS
-- ════════════════════════════════════════════════════════════

create sequence if not exists public.supplier_return_seq start 1;

create table if not exists public.supplier_returns (
  id                  uuid primary key default gen_random_uuid(),
  return_number       text unique not null,     -- SR-2026-0001
  supplier_id         uuid not null references public.suppliers(id),
  purchase_id         uuid references public.purchases(id),
  reason              text not null,
  debit_note_amount   numeric(10,2),           -- computed on confirmation
  status              text not null default 'draft'
                        check (status in ('draft','sent','acknowledged')),
  notes               text,
  created_by          uuid references public.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.supplier_return_items (
  id             uuid primary key default gen_random_uuid(),
  return_id      uuid not null references public.supplier_returns(id) on delete cascade,
  batch_id       uuid not null references public.inventory_batches(id),
  medicine_id    uuid not null references public.medicines(id),
  qty_returned   int  not null check (qty_returned > 0),
  unit_cost      numeric(10,2) not null,       -- what you paid; basis of debit note
  created_at     timestamptz not null default now()
);

create index idx_sr_supplier on public.supplier_returns(supplier_id);
create index idx_sr_status   on public.supplier_returns(status);
create index idx_sri_return  on public.supplier_return_items(return_id);

create trigger supplier_returns_updated_at before update on public.supplier_returns
  for each row execute procedure public.handle_updated_at();

alter table public.supplier_returns       enable row level security;
alter table public.supplier_return_items  enable row level security;

create policy "owner_all_sr"       on public.supplier_returns for all using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));
create policy "owner_all_sr_items" on public.supplier_return_items for all using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));

create or replace function public.next_supplier_return_number()
returns text language plpgsql as $$
begin return 'SR-' || to_char(now(),'YYYY') || '-' || lpad(nextval('supplier_return_seq')::text,4,'0'); end; $$;

create or replace view public.supplier_returns_with_totals as
select
  sr.*,
  s.name as supplier_name,
  coalesce(sum(i.qty_returned * i.unit_cost), 0) as debit_total,
  count(i.id) as item_count
from public.supplier_returns sr
join public.suppliers s on s.id = sr.supplier_id
left join public.supplier_return_items i on i.return_id = sr.id
group by sr.id, s.name;

-- ════════════════════════════════════════════════════════════
-- MODULE 14: EXPIRY MANAGEMENT (views only — no new tables)
-- All data comes from inventory_batches + inventory_ledger
-- ════════════════════════════════════════════════════════════

-- Expiry summary view — batches with remaining stock, grouped by urgency
create or replace view public.expiry_summary as
select
  bws.*,
  case
    when bws.exp_date < current_date                          then 'expired'
    when bws.exp_date <= current_date + interval '30 days'   then 'critical'    -- 30d
    when bws.exp_date <= current_date + interval '60 days'   then 'warning'     -- 60d
    when bws.exp_date <= current_date + interval '90 days'   then 'watch'       -- 90d
    else 'ok'
  end as urgency,
  -- Potential loss value (what you paid for the remaining stock)
  (bws.stock_qty * bws.unit_cost) as potential_loss_value,
  -- Days until expiry (negative = already expired)
  (bws.exp_date - current_date) as days_to_expiry
from public.batches_with_stock bws
where bws.stock_qty > 0   -- only batches with physical stock remaining
order by bws.exp_date asc;
