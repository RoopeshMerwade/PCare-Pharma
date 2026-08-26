-- ============================================================
-- MODULE 02 — USER MANAGEMENT
-- Database: Supabase (PostgreSQL)
-- Note: public.users and audit_logs were created in Module 01
--       This file adds indexes, policies, and the invite table.
-- ============================================================

-- ── Indexes (performance on likely query patterns)
create index if not exists idx_users_role       on public.users(role);
create index if not exists idx_users_is_active  on public.users(is_active);
create index if not exists idx_audit_user_id    on public.audit_logs(user_id);
create index if not exists idx_audit_created_at on public.audit_logs(created_at desc);

-- ── Staff invite table
--    Owner creates an invite → link emailed → staff sets password
create table if not exists public.staff_invites (
  id           uuid primary key default gen_random_uuid(),
  email        text        not null unique,
  full_name    text        not null,
  phone        text,
  role         text        not null default 'staff' check (role = 'staff'),
  token        text        not null unique,       -- signed invite token
  expires_at   timestamptz not null,              -- 48h from creation
  accepted_at  timestamptz,                       -- null = pending
  created_by   uuid        references public.users(id),
  created_at   timestamptz not null default now()
);

-- RLS on staff_invites
alter table public.staff_invites enable row level security;

create policy "owner_manage_invites" on public.staff_invites
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- ── Additional RLS policies on public.users
-- Both go through public.is_owner() (SECURITY DEFINER, defined in auth.sql).
-- Inlining the lookup here instead would recurse — see the note on that function.
-- Owner can insert (create) new users
create policy "owner_insert_user" on public.users
  for insert with check (public.is_owner());

-- Owner can update any user
create policy "owner_update_any" on public.users
  for update using (public.is_owner());

-- ── View: active staff summary (for Owner dashboard widget)
create or replace view public.staff_summary as
select
  u.id,
  u.full_name,
  u.phone,
  u.role,
  u.is_active,
  u.avatar_url,
  u.created_at,
  (
    select created_at from public.audit_logs a
    where a.user_id = u.id and a.action = 'login'
    order by created_at desc limit 1
  ) as last_login_at
from public.users u
where u.role = 'staff';

-- ── Function: enforce max 4 active staff
create or replace function public.check_staff_limit()
returns trigger language plpgsql as $$
declare active_count int;
begin
  if NEW.role = 'staff' and NEW.is_active = true then
    select count(*) into active_count from public.users
    where role = 'staff' and is_active = true and id != NEW.id;
    if active_count >= 4 then
      raise exception 'STAFF_LIMIT_REACHED: Maximum 4 active staff accounts allowed.';
    end if;
  end if;
  return NEW;
end; $$;

create trigger enforce_staff_limit
  before insert or update on public.users
  for each row execute procedure public.check_staff_limit();
