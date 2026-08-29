-- ============================================================
-- MODULES 15–20: Reports, Notifications, Dashboards,
--                Settings, Audit Logs UI
-- Prerequisites: Modules 01–14 must exist
-- ============================================================

-- ══════════════════════════════════════════
-- MODULE 15: REPORTS — no new tables
-- All data computed live from existing views
-- ══════════════════════════════════════════

-- Margin view: selling_price vs unit_cost from bill_items + batches
create or replace view public.margin_analytics as
select
  m.id             as medicine_id,
  m.name           as medicine_name,
  mc.name          as category_name,
  mc.color         as category_color,
  count(bi.id)     as times_sold,
  sum(bi.qty)      as total_qty_sold,
  avg(bi.unit_price::numeric)                               as avg_selling_price,
  avg(ib.unit_cost::numeric)                                as avg_unit_cost,
  avg((bi.unit_price - ib.unit_cost)::numeric)              as avg_margin_rupees,
  case when avg(bi.unit_price::numeric) > 0
       then avg(((bi.unit_price - ib.unit_cost) / bi.unit_price)::numeric) * 100
       else 0 end                                           as avg_margin_pct,
  sum((bi.qty * (bi.unit_price - ib.unit_cost))::numeric)  as total_margin_earned
from public.bill_items bi
join public.inventory_batches ib on ib.id = bi.batch_id
join public.medicines m          on m.id  = bi.medicine_id
join public.medicine_categories mc on mc.id = m.category_id
group by m.id, m.name, mc.name, mc.color;

-- Daily sales summary view (timezone normalized to Asia/Kolkata)
create or replace view public.daily_sales_summary as
select
  (date_trunc('day', b.created_at at time zone 'Asia/Kolkata'))::date as sale_date,
  count(b.id)                            as bill_count,
  coalesce(sum(bt.total), 0::numeric)             as total_revenue,
  coalesce(sum(case when b.payment_mode='cash'   then bt.total else 0::numeric end), 0::numeric) as cash_total,
  coalesce(sum(case when b.payment_mode='upi'    then bt.total else 0::numeric end), 0::numeric) as upi_total,
  coalesce(sum(case when b.payment_mode='credit' then bt.total else 0::numeric end), 0::numeric) as credit_total,
  coalesce(sum(case when b.payment_mode='card'   then bt.total else 0::numeric end), 0::numeric) as card_total
from public.bills b
join public.bills_with_totals bt on bt.id = b.id
group by (date_trunc('day', b.created_at at time zone 'Asia/Kolkata'))::date;

-- ══════════════════════════════════════════
-- MODULE 16: NOTIFICATIONS
-- ══════════════════════════════════════════
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        references public.users(id) on delete cascade,  -- null = all users
  type        text        not null
                check (type in ('LOW_STOCK','NEAR_EXPIRY','CUSTOMER_RETURN_PENDING',
                                'SUPPLIER_RETURN_PENDING','SYSTEM','PURCHASE_OVERDUE')),
  title       text        not null,
  message     text        not null,
  is_read     boolean     not null default false,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index idx_notifications_user    on public.notifications(user_id, is_read, created_at desc);
create index idx_notifications_type    on public.notifications(type);
create index idx_notifications_created on public.notifications(created_at desc);

alter table public.notifications enable row level security;
-- Users see their own + broadcast (user_id is null) notifications
create policy "user_read_notifications" on public.notifications
  for select using (auth.uid() is not null and (user_id = auth.uid() or user_id is null));
create policy "user_update_notifications" on public.notifications
  for update using (user_id = auth.uid() or
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));
create policy "system_insert_notifications" on public.notifications
  for insert with check (auth.uid() is not null);

-- ══════════════════════════════════════════
-- MODULE 19: SETTINGS
-- ══════════════════════════════════════════
create table if not exists public.pharmacy_settings (
  key         text primary key,
  value       text,
  description text,
  updated_by  uuid        references public.users(id),
  updated_at  timestamptz not null default now()
);

alter table public.pharmacy_settings enable row level security;
create policy "auth_read_settings" on public.pharmacy_settings
  for select using (auth.uid() is not null);
create policy "owner_write_settings" on public.pharmacy_settings
  for all using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));

-- Seed default settings
insert into public.pharmacy_settings (key, value, description) values
  ('pharmacy_name',              'P. Care Pharma',     'Pharmacy display name'),
  ('pharmacy_address',           '',                   'Full address for bills'),
  ('drug_license_no',            '',                   'Drug license number'),
  ('gst_no',                     '',                   'GST number'),
  ('owner_name',                 '',                   'Owner full name'),
  ('phone',                      '',                   'Counter phone number'),
  ('email',                      '',                   'Pharmacy email'),
  ('city',                       'Gadag',              'City'),
  ('state',                      'Karnataka',          'State'),
  ('pincode',                    '582101',             'PIN code'),
  ('currency_symbol',            '₹',                  'Currency symbol'),
  ('default_low_stock_threshold','20',                 'Default low stock alert level'),
  ('default_credit_terms_days',  '30',                 'Default vendor credit period'),
  ('financial_year_start',       '04',                 'Month financial year starts (1-12)')
on conflict (key) do nothing;

-- ══════════════════════════════════════════
-- MODULE 20: AUDIT LOGS — table already created in Module 01
-- Additional index for UI filtering
-- ══════════════════════════════════════════
create index if not exists idx_audit_action  on public.audit_logs(action);
create index if not exists idx_audit_created on public.audit_logs(created_at desc);
