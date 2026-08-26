-- ============================================================
-- MODULE 03 — MEDICINE CATEGORIES
-- ============================================================

create table if not exists public.medicine_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  description text,
  color       text        not null default '#6B7280',  -- hex for badge
  sort_order  int         not null default 0,
  is_active   boolean     not null default true,
  created_by  uuid        references public.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Case-insensitive unique name
create unique index idx_categories_name_lower
  on public.medicine_categories(lower(name));

-- Fast filter by active status
create index idx_categories_sort
  on public.medicine_categories(sort_order, name)
  where is_active = true;

-- Auto-update updated_at
create trigger categories_updated_at
  before update on public.medicine_categories
  for each row execute procedure public.handle_updated_at();

-- RLS
alter table public.medicine_categories enable row level security;

-- All authenticated users can read active categories
create policy "authenticated_read_categories" on public.medicine_categories
  for select using (auth.uid() is not null);

-- Only owner can insert
create policy "owner_insert_category" on public.medicine_categories
  for insert with check (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- Only owner can update
create policy "owner_update_category" on public.medicine_categories
  for update using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- NOTE: categories_with_count view moved to medicines.sql — it left-joins
-- public.medicines, which doesn't exist yet at this point in the migration order.

-- Function: enforce max 30 active categories
create or replace function public.check_category_limit()
returns trigger language plpgsql as $$
declare active_count int;
begin
  if NEW.is_active = true then
    select count(*) into active_count from public.medicine_categories
      where is_active = true and id != coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
    if active_count >= 30 then
      raise exception 'CATEGORY_LIMIT_REACHED: Maximum 30 active categories allowed.';
    end if;
  end if;
  return NEW;
end; $$;

create trigger enforce_category_limit
  before insert or update on public.medicine_categories
  for each row execute procedure public.check_category_limit();

-- ── Seed data (run once on fresh install)
insert into public.medicine_categories (name, color, sort_order) values
  ('Diabetes',              '#3B82F6', 1),
  ('BP & Cardiac',          '#EF4444', 2),
  ('Antibiotics',           '#10B981', 3),
  ('General & OTC',         '#6B7280', 4),
  ('Vitamins & Supplements','#F59E0B', 5),
  ('Pediatrics',            '#8B5CF6', 6),
  ('Ointments & Creams',    '#EC4899', 7),
  ('Syrups',                '#14B8A6', 8),
  ('Surgical & IV',         '#F97316', 9),
  ('Sanitary',              '#06B6D4', 10)
on conflict do nothing;
