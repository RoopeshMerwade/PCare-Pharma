-- ============================================================
-- MODULE 04 — MEDICINES
-- Prerequisite: Module 03 (medicine_categories) must exist
-- ============================================================

create table if not exists public.medicines (
  id                    uuid primary key default gen_random_uuid(),
  name                  text        not null,                -- Brand name e.g. "Metformin 500mg"
  generic_name          text,                               -- INN name e.g. "Metformin Hydrochloride"
  manufacturer          text,                               -- "Sun Pharma"
  category_id           uuid        not null references public.medicine_categories(id),
  unit                  text        not null
                          check (unit in ('strips','vials','bottles','tubes','packs','pcs')),
  default_selling_price numeric(10,2) not null check (default_selling_price > 0),
  low_stock_threshold   int         not null default 20 check (low_stock_threshold >= 0),
  hsn_code              text,                               -- for GST (Phase 2)
  description           text,
  is_active             boolean     not null default true,
  created_by            uuid        references public.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── Unique: name + manufacturer (prevents duplicates like two "Paracetamol 500mg" from same company)
create unique index idx_medicines_name_manufacturer
  on public.medicines(lower(name), lower(coalesce(manufacturer, '')));

-- ── Performance indexes
create index idx_medicines_category    on public.medicines(category_id) where is_active = true;
create index idx_medicines_is_active   on public.medicines(is_active);
-- Full-text search index on name + generic_name + manufacturer
create index idx_medicines_fts on public.medicines
  using gin(to_tsvector('english', coalesce(name,'') || ' ' || coalesce(generic_name,'') || ' ' || coalesce(manufacturer,'')));

-- ── Auto-update updated_at
create trigger medicines_updated_at
  before update on public.medicines
  for each row execute procedure public.handle_updated_at();

-- ── RLS
alter table public.medicines enable row level security;

-- All authenticated users can read
create policy "authenticated_read_medicines" on public.medicines
  for select using (auth.uid() is not null);

-- Owner only: insert
create policy "owner_insert_medicine" on public.medicines
  for insert with check (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- Owner only: update
create policy "owner_update_medicine" on public.medicines
  for update using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- ── View: categories with live medicine count (moved from categories.sql —
-- it needs public.medicines to exist, which it doesn't yet at that point)
create or replace view public.categories_with_count as
select
  c.*,
  count(m.id) filter (where m.is_active = true) as medicines_count
from public.medicine_categories c
left join public.medicines m on m.category_id = c.id
group by c.id;

-- NOTE: medicines_with_stock view moved to inventory.sql — it needs
-- public.inventory_batches / inventory_ledger, which don't exist yet here.

-- ── Seed: 13 medicines matching the Phase 1 prototype
-- (requires the 10 seed categories from Module 03 to exist)
insert into public.medicines
  (name, generic_name, manufacturer, category_id, unit, default_selling_price, low_stock_threshold, hsn_code)
select v.name, v.generic_name, v.manufacturer,
       mc.id, v.unit, v.price, v.threshold, v.hsn
from (values
  ('Metformin 500mg',      'Metformin Hydrochloride', 'Sun Pharma',       'Diabetes',              'strips',  25.00, 50, '30042090'),
  ('Glimepiride 1mg',      'Glimepiride',             'Sanofi India',     'Diabetes',              'strips',  45.00, 30, '30042090'),
  ('Amlodipine 5mg',       'Amlodipine Besylate',     'Cipla',            'BP & Cardiac',          'strips',  38.00, 40, '30049099'),
  ('Aspirin 75mg',         'Acetylsalicylic Acid',    'Bayer',            'BP & Cardiac',          'strips',  12.00, 60, '30049099'),
  ('Rosuvastatin 10mg',    'Rosuvastatin Calcium',    'AstraZeneca',      'BP & Cardiac',          'strips',  55.00, 30, '30049099'),
  ('Amoxicillin 500mg',    'Amoxicillin Trihydrate',  'GSK',              'Antibiotics',           'strips',  45.00, 30, '30041010'),
  ('Azithromycin 500mg',   'Azithromycin',            'Pfizer',           'Antibiotics',           'strips',  85.00, 20, '30041090'),
  ('Paracetamol 650mg',    'Paracetamol',             'Micro Labs',       'General & OTC',         'strips',  18.00, 100,'30049099'),
  ('Cetrizine 10mg',       'Cetirizine Hydrochloride','UCB India',        'General & OTC',         'strips',  22.00, 40, '30049099'),
  ('Pantoprazole 40mg',    'Pantoprazole Sodium',     'Sun Pharma',       'General & OTC',         'strips',  32.00, 40, '30049099'),
  ('Vitamin D3 60K',       'Cholecalciferol',         'Mankind Pharma',   'Vitamins & Supplements','pcs',     48.00, 30, '30049099'),
  ('Calcium + D3',         'Calcium Carbonate + D3',  'Cadila Healthcare','Vitamins & Supplements','strips',  65.00, 30, '30049099'),
  ('Betadine Ointment 5%', 'Povidone Iodine',         'Win-Medicare',     'Ointments & Creams',    'tubes',   85.00, 15, '30049099')
) as v(name, generic_name, manufacturer, cat_name, unit, price, threshold, hsn)
join public.medicine_categories mc on lower(mc.name) = lower(v.cat_name)
on conflict do nothing;
