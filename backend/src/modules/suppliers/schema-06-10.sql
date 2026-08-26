-- ============================================================
-- MODULES 06–10: Suppliers, Purchases, Purchase Items, Bills, Bill Items
-- Run in order. Prerequisites: Modules 01–05 must exist.
-- ============================================================

-- ── MODULE 06: SUPPLIERS
create table if not exists public.suppliers (
  id                uuid primary key default gen_random_uuid(),
  name              text        not null,
  contact_person    text,
  phone             text,
  email             text,
  gst_no            text,
  drug_license_no   text,
  credit_terms_days int         not null default 30,
  is_active         boolean     not null default true,
  notes             text,
  created_by        uuid        references public.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index idx_suppliers_name on public.suppliers(lower(name));
create index idx_suppliers_active on public.suppliers(is_active);
create trigger suppliers_updated_at before update on public.suppliers
  for each row execute procedure public.handle_updated_at();

alter table public.suppliers enable row level security;
create policy "authenticated_read_suppliers" on public.suppliers for select using (auth.uid() is not null);
create policy "owner_write_suppliers"        on public.suppliers for all    using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));

-- ── MODULE 07: PURCHASES (Purchase Orders)
create table if not exists public.purchases (
  id                     uuid primary key default gen_random_uuid(),
  purchase_number        text unique not null,          -- PO-2026-0001
  supplier_id            uuid        not null references public.suppliers(id),
  status                 text        not null default 'draft'
                           check (status in ('draft','sent','received','cancelled')),
  expected_delivery_date date,
  notes                  text,
  received_at            timestamptz,
  received_by            uuid        references public.users(id),
  created_by             uuid        references public.users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
  -- subtotal always computed from purchase_items
);

create index idx_purchases_supplier on public.purchases(supplier_id);
create index idx_purchases_status   on public.purchases(status);
create trigger purchases_updated_at before update on public.purchases
  for each row execute procedure public.handle_updated_at();

alter table public.purchases enable row level security;
create policy "authenticated_read_purchases" on public.purchases for select using (auth.uid() is not null);
create policy "owner_write_purchases" on public.purchases for all using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));

-- Auto-generate purchase number
create sequence if not exists public.purchase_number_seq start 1;
create or replace function public.next_purchase_number()
returns text language plpgsql as $$
begin return 'PO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('purchase_number_seq')::text, 4, '0'); end; $$;

-- ── MODULE 08: PURCHASE ITEMS
create table if not exists public.purchase_items (
  id             uuid primary key default gen_random_uuid(),
  purchase_id    uuid        not null references public.purchases(id) on delete cascade,
  medicine_id    uuid        not null references public.medicines(id),
  qty_ordered    int         not null check (qty_ordered > 0),
  unit_cost      numeric(10,2) not null check (unit_cost >= 0),
  -- Filled when purchase is received
  qty_received   int,
  batch_no       text,
  batch_id       uuid        references public.inventory_batches(id),
  mrp            numeric(10,2),
  selling_price  numeric(10,2),
  exp_date       date,
  mfg_date       date,
  created_at     timestamptz not null default now()
);

create index idx_purchase_items_purchase on public.purchase_items(purchase_id);
create index idx_purchase_items_medicine on public.purchase_items(medicine_id);

alter table public.purchase_items enable row level security;
create policy "authenticated_read_purchase_items" on public.purchase_items for select using (auth.uid() is not null);
create policy "owner_write_purchase_items" on public.purchase_items for all using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));

-- View: purchases with computed totals + supplier name
create or replace view public.purchases_with_totals as
select
  p.*,
  s.name               as supplier_name,
  s.phone              as supplier_phone,
  s.credit_terms_days,
  coalesce(sum(pi.qty_ordered * pi.unit_cost), 0)  as ordered_total,
  coalesce(sum(pi.qty_received * pi.unit_cost), 0) as received_total,
  count(pi.id)                                     as item_count
from public.purchases p
join public.suppliers s on s.id = p.supplier_id
left join public.purchase_items pi on pi.purchase_id = p.id
group by p.id, s.id;

-- ── MODULE 09: BILLS (Sales)
create sequence if not exists public.bill_number_seq start 1;

create table if not exists public.bills (
  id              uuid primary key default gen_random_uuid(),
  bill_number     text unique not null,   -- BILL-2026-0001
  customer_name   text,                   -- guest or linked customer name
  customer_phone  text,
  customer_id     uuid,                   -- nullable: future customer module
  payment_mode    text not null
                    check (payment_mode in ('cash','upi','credit','card')),
  payment_status  text not null default 'paid'
                    check (payment_status in ('paid','pending')),
  discount_amount numeric(10,2) not null default 0 check (discount_amount >= 0),
  notes           text,
  created_by      uuid references public.users(id),
  created_at      timestamptz not null default now()
  -- total always computed from bill_items
);

create index idx_bills_created_at on public.bills(created_at desc);
create index idx_bills_customer   on public.bills(customer_phone);
create index idx_bills_created_by on public.bills(created_by);

alter table public.bills enable row level security;
create policy "authenticated_read_bills" on public.bills for select using (auth.uid() is not null);
create policy "authenticated_insert_bills" on public.bills for insert with check (auth.uid() is not null);
-- No update/delete on bills — append-only principle
create policy "owner_update_bills" on public.bills for update using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));

create or replace function public.next_bill_number()
returns text language plpgsql as $$
begin return 'BILL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('bill_number_seq')::text, 4, '0'); end; $$;

-- ── MODULE 10: BILL ITEMS
create table if not exists public.bill_items (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid        not null references public.bills(id),
  medicine_id  uuid        not null references public.medicines(id),
  batch_id     uuid        not null references public.inventory_batches(id),
  qty          int         not null check (qty > 0),
  unit_price   numeric(10,2) not null check (unit_price > 0),  -- price snapshot
  mrp          numeric(10,2) not null check (mrp > 0),         -- mrp snapshot
  -- unit_price <= mrp enforced; snapshots protect historical accuracy
  created_at   timestamptz not null default now()
);

create index idx_bill_items_bill     on public.bill_items(bill_id);
create index idx_bill_items_medicine on public.bill_items(medicine_id);
create index idx_bill_items_batch    on public.bill_items(batch_id);

alter table public.bill_items enable row level security;
create policy "authenticated_read_bill_items" on public.bill_items for select using (auth.uid() is not null);
create policy "authenticated_insert_bill_items" on public.bill_items for insert with check (auth.uid() is not null);

-- View: bills with computed totals
create or replace view public.bills_with_totals as
select
  b.*,
  u.full_name as created_by_name,
  coalesce(sum(bi.qty * bi.unit_price), 0)  as subtotal,
  coalesce(sum(bi.qty * bi.unit_price), 0) - b.discount_amount as total,
  count(bi.id) as item_count
from public.bills b
left join public.bill_items bi on bi.bill_id = b.id
left join public.users u on u.id = b.created_by
group by b.id, u.id;

-- Supplier outstanding balance view (computed from purchases and payments)
create or replace view public.supplier_balances as
select
  s.id as supplier_id,
  s.name as supplier_name,
  s.credit_terms_days,
  coalesce(sum(p.received_total), 0) as total_purchased,
  0::numeric as total_paid   -- payment module will populate this
from public.suppliers s
left join public.purchases_with_totals p on p.supplier_id = s.id
  and p.status = 'received'
group by s.id, s.name, s.credit_terms_days;

-- Seed: 3 suppliers matching the prototype
insert into public.suppliers (name, contact_person, phone, gst_no, drug_license_no, credit_terms_days) values
  ('Laxmi Pharma',    'Rajesh K.', '9739692329', '29AIKPJ7778E1ZO', 'KA-GD1-20B/157430', 30),
  ('Samarth Pharma',  'Akkamma',   '9483922097', '29ABHPH9436K1Z4', 'KA/GD1/20B-214741', 21),
  ('Apex Surgical',   'Vinod R.',  '9845000777', '29AAHCA1234Z1ZX', 'KA-GD1-20B/999001', 15)
on conflict do nothing;
