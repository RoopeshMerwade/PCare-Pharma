-- ============================================================
-- MODULE 01 — AUTHENTICATION (run FIRST before all other modules)
-- ============================================================

-- Function: auto-update updated_at on any table that uses it
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- Public users profile table (extends Supabase auth.users)
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text        not null,
  phone       text,
  role        text        not null check (role in ('owner','staff')),
  is_active   boolean     not null default true,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger users_updated_at before update on public.users
  for each row execute procedure public.handle_updated_at();

-- Helper: is the caller an owner?
-- SECURITY DEFINER makes this run as the function owner, so the lookup inside
-- does NOT re-trigger RLS on public.users. A policy ON public.users that queries
-- public.users directly recurses forever (Postgres 42P17) — always go through this.
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'owner'
  );
$$;

-- RLS
alter table public.users enable row level security;
create policy "owner_read_all"  on public.users for select using (public.is_owner());
create policy "self_read"   on public.users for select using (auth.uid() = id);
create policy "self_update" on public.users for update  using (auth.uid() = id);

-- Audit log table (used by every module)
create table if not exists public.audit_logs (
  id          bigserial   primary key,
  user_id     uuid        references public.users(id),
  action      text        not null,
  ip_address  inet,
  user_agent  text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index idx_audit_user_id    on public.audit_logs(user_id);
create index idx_audit_created_at on public.audit_logs(created_at desc);
create index idx_audit_action     on public.audit_logs(action);
