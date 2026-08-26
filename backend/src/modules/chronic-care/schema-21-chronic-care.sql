-- ============================================================
-- MODULE 21: CHRONIC MEDICATION ADHERENCE MONITORING
-- Prerequisites: Modules 01-20 must exist (needs customers, medicines,
-- bills, bill_items, notifications)
-- ============================================================

-- ══════════════════════════════════════════
-- Fixed lookup list of chronic conditions
-- (per product decision: pick-from-list, not free text)
-- ══════════════════════════════════════════
create table if not exists public.chronic_conditions (
  id        uuid primary key default gen_random_uuid(),
  name      text unique not null,
  is_active boolean not null default true
);

insert into public.chronic_conditions (name) values
  ('Type 2 Diabetes Mellitus'),
  ('Hypertension'),
  ('Hypothyroidism'),
  ('Hyperthyroidism'),
  ('Asthma'),
  ('COPD'),
  ('Chronic Kidney Disease'),
  ('Coronary Artery Disease'),
  ('Epilepsy'),
  ('Rheumatoid Arthritis'),
  ('Osteoarthritis'),
  ('Depression / Anxiety Disorder'),
  ('Parkinson''s Disease'),
  ('HIV / ART Therapy'),
  ('Other (see notes)')
on conflict (name) do nothing;

-- ══════════════════════════════════════════
-- Patient conditions — links a customer to a diagnosis.
-- Sensitive personal health data (DPDP Act) — never exported,
-- never included in WhatsApp/SMS message content.
-- ══════════════════════════════════════════
create table if not exists public.patient_conditions (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references public.customers(id),
  condition_id       uuid not null references public.chronic_conditions(id),
  diagnosed_date     date,
  prescribing_doctor text,          -- visibility only — no commission logic (Indian law)
  notes              text,          -- e.g. free-text detail when condition = 'Other'
  is_active          boolean not null default true,
  created_by         uuid references public.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_pc_customer on public.patient_conditions(customer_id);
create trigger patient_conditions_updated_at before update on public.patient_conditions
  for each row execute procedure public.handle_updated_at();

alter table public.patient_conditions enable row level security;
create policy "auth_read_patient_conditions"  on public.patient_conditions for select using (auth.uid() is not null);
create policy "auth_write_patient_conditions" on public.patient_conditions for all    using (auth.uid() is not null);

-- ══════════════════════════════════════════
-- Medication schedules — a customer + medicine + expected refill cycle.
-- Both owner and staff may create/edit (per product decision).
-- ══════════════════════════════════════════
create table if not exists public.medication_schedules (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers(id),
  medicine_id       uuid not null references public.medicines(id),
  condition_id      uuid references public.patient_conditions(id),   -- optional link
  refill_cycle_days int  not null check (refill_cycle_days > 0),      -- e.g. 30
  early_grace_days  int  not null default 7 check (early_grace_days >= 0),
  late_grace_days   int  not null default 7 check (late_grace_days  >= 0),
  start_date        date not null default current_date,
  is_active         boolean not null default true,
  created_by        uuid references public.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_ms_customer on public.medication_schedules(customer_id);
create index idx_ms_medicine on public.medication_schedules(medicine_id);
create trigger medication_schedules_updated_at before update on public.medication_schedules
  for each row execute procedure public.handle_updated_at();

alter table public.medication_schedules enable row level security;
create policy "auth_read_medication_schedules"  on public.medication_schedules for select using (auth.uid() is not null);
create policy "auth_write_medication_schedules" on public.medication_schedules for all    using (auth.uid() is not null);

-- ══════════════════════════════════════════
-- Adherence acknowledgments — an audit trail of every time staff
-- was warned (early refill / overdue) and chose to proceed anyway.
-- Required by product decision: sale is never blocked, but must be
-- acknowledged and logged — important for controlled-substance safety.
-- ══════════════════════════════════════════
create table if not exists public.adherence_acknowledgments (
  id                        uuid primary key default gen_random_uuid(),
  bill_id                   uuid references public.bills(id),
  schedule_id               uuid not null references public.medication_schedules(id),
  status_at_sale            text not null check (status_at_sale in ('early_refill','overdue')),
  days_since_last_purchase  int,
  acknowledged_by           uuid references public.users(id),
  acknowledged_at           timestamptz not null default now()
);

create index idx_ack_bill     on public.adherence_acknowledgments(bill_id);
create index idx_ack_schedule on public.adherence_acknowledgments(schedule_id);

alter table public.adherence_acknowledgments enable row level security;
create policy "auth_read_ack"   on public.adherence_acknowledgments for select using (auth.uid() is not null);
create policy "auth_insert_ack" on public.adherence_acknowledgments for insert with check (auth.uid() is not null);

-- ══════════════════════════════════════════
-- Extend notifications type constraint to include REFILL_OVERDUE
-- (notifications table itself was created in Module 16)
-- ══════════════════════════════════════════
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('LOW_STOCK','NEAR_EXPIRY','CUSTOMER_RETURN_PENDING',
                  'SUPPLIER_RETURN_PENDING','SYSTEM','PURCHASE_OVERDUE','REFILL_OVERDUE'));

-- ══════════════════════════════════════════
-- Computed view — status is ALWAYS derived live from bills, never stored.
-- Same architectural principle as stock, balances, and margins elsewhere
-- in this system: nothing is cached that can be recomputed from source data.
-- ══════════════════════════════════════════
create or replace view public.medication_schedule_status as
select
  ms.id                     as schedule_id,
  ms.customer_id,
  c.name                    as customer_name,
  c.phone                   as customer_phone,
  ms.medicine_id,
  m.name                    as medicine_name,
  m.unit                    as medicine_unit,
  ms.condition_id,
  cc.name                   as condition_name,
  ms.refill_cycle_days,
  ms.early_grace_days,
  ms.late_grace_days,
  ms.start_date,
  ms.is_active,
  lastp.last_purchased_date,
  case when lastp.last_purchased_date is null then null
       else (current_date - lastp.last_purchased_date)
  end as days_since_last_purchase,
  case
    when lastp.last_purchased_date is null then 'no_purchase_yet'
    when (current_date - lastp.last_purchased_date) < (ms.refill_cycle_days - ms.early_grace_days)
         then 'early_refill'
    when (current_date - lastp.last_purchased_date) > (ms.refill_cycle_days + ms.late_grace_days)
         then 'overdue'
    when (current_date - lastp.last_purchased_date) >= (ms.refill_cycle_days - 3)
         then 'due_soon'
    else 'on_track'
  end as status
from public.medication_schedules ms
join public.customers c            on c.id  = ms.customer_id
join public.medicines m            on m.id  = ms.medicine_id
left join public.patient_conditions pcnd on pcnd.id = ms.condition_id
left join public.chronic_conditions cc   on cc.id   = pcnd.condition_id
left join lateral (
  select max(b.created_at)::date as last_purchased_date
  from public.bills b
  join public.bill_items bi on bi.bill_id = b.id
  where b.customer_phone = c.phone and bi.medicine_id = ms.medicine_id
) lastp on true
where ms.is_active = true;
