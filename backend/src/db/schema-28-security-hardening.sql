-- ============================================================
-- SCHEMA 28 — SECURITY HARDENING
--
-- Two independent, additive changes. Nothing is dropped, no existing row is
-- read, rewritten or deleted, and every statement is guarded so the whole file
-- is safe to re-run. It can be applied to a live database at any point after
-- step 1 (auth.sql) — it does not depend on any migration after that, and
-- nothing later depends on it.
--
--   1. Row Level Security on public.audit_logs (owner-only SELECT).
--   2. public.login_attempts + record_login_attempt() — shared state for the
--      per-account failed-login limiter, which was a per-process JS Map.
--
-- BOTH RELY ON THE SAME FACT: the API talks to Postgres as `service_role`,
-- which BYPASSES RLS entirely (config/supabase.js). Every existing backend
-- read and write therefore continues to work exactly as it does today. RLS
-- here is defence in depth for any path that is NOT service_role — the anon
-- key, a future direct-from-client query, a leaked publishable key.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. AUDIT LOGS — RLS, owner-only reads
-- ════════════════════════════════════════════════════════════
--
-- audit_logs is the one table that records who did what: every login, every
-- failed login (with the email attempted), every stock adjustment, every
-- account deactivation. It was the only table in the schema carrying that
-- class of data with RLS switched off, so any credential that could reach
-- PostgREST at all could read the entire trail.
--
-- The API surface was never the exposure — /api/v1/audit-logs is already
-- authorize('owner') at the router level (audit-logs.routes.js). This closes
-- the layer underneath it, so the guarantee does not rest on one middleware
-- line being present on one router.

alter table public.audit_logs enable row level security;

-- ── The owner check ─────────────────────────────────────────
--
-- Restated here rather than assumed from step 1. auth.sql defines
-- public.is_owner(), but the live project was built without it — its policies
-- use an inline `exists (select 1 from users …)` instead — so a migration that
-- merely REFERENCED the helper failed with 42883 on the database it was
-- written for. `create or replace` is idempotent and the definition is
-- character-identical to auth.sql's, so running either file in either order
-- leaves the same function behind.
--
-- SECURITY DEFINER is the whole point: the lookup runs as the function owner
-- and so does not re-trigger RLS on public.users. A policy that reads
-- public.users directly works only as long as the reader can see the row it
-- needs — and a policy ON users written that way recurses forever (42P17).
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

-- Idempotent: policies have no CREATE OR REPLACE form.
drop policy if exists "owner_read_audit_logs" on public.audit_logs;

create policy "owner_read_audit_logs" on public.audit_logs
  for select using (public.is_owner());

-- Deliberately NO insert / update / delete policy, and none for staff:
--
--   · No staff SELECT policy. Staff must not read the audit trail at all —
--     it contains other people's actions and failed-login emails. With RLS on
--     and no matching policy, their reads return zero rows rather than being
--     filtered to a subset.
--   · No INSERT policy. Audit writes come from utils/audit.js on the
--     service_role client, which bypasses RLS. Adding an INSERT policy would
--     let a non-service_role caller forge trail entries.
--   · No UPDATE or DELETE policy, ever. An append-only trail that the
--     application can rewrite is not evidence of anything. This matches how
--     inventory_ledger is protected by block_ledger_mutation.

comment on table public.audit_logs is
  'Append-only action trail. RLS: owner SELECT only; all writes are service_role. Never expose to staff.';


-- ════════════════════════════════════════════════════════════
-- 2. LOGIN ATTEMPTS — shared per-account brute-force counter
-- ════════════════════════════════════════════════════════════
--
-- The per-account limiter (5 failed attempts per email+IP per 15 minutes) lived
-- in a module-level JavaScript Map in auth.service.js. That is per PROCESS: run
-- under PM2 cluster mode or more than one instance and an attacker's attempts
-- spread across workers, each counting only the fraction it served — the real
-- ceiling becomes 5 x workers, and any restart resets it to zero.
--
-- Redis would be the usual answer, but there is no Redis in this project or its
-- deployment (no dependency, nothing in ecosystem.config.js or
-- nginx.conf.template). Postgres is already a hard dependency of the login path
-- — the profile read two lines later needs it — so counting here adds shared
-- state across every worker and instance at no new infrastructure cost.
--
-- utils/loginAttemptStore.js probes for this table once per process and falls
-- back to the in-memory Map if it is absent, so an API deployed before this
-- migration keeps working exactly as it did (with the per-process caveat) and
-- logs a warning naming this file.

create table if not exists public.login_attempts (
  -- 'email:ip' — the same key auth.service.js has always used. Not a foreign
  -- key to users: attempts against an address that does not exist must be
  -- counted too, or enumeration is free.
  attempt_key       text        primary key,
  attempt_count     int         not null default 0,
  window_started_at timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Supports the optional prune below; the table is otherwise read by PK only.
create index if not exists idx_login_attempts_window
  on public.login_attempts(window_started_at);

-- RLS on with NO policies at all: service_role bypasses it, everything else is
-- denied. The rows pair an email address with an IP, which is exactly the kind
-- of thing that should not be reachable by a publishable key.
alter table public.login_attempts enable row level security;

comment on table public.login_attempts is
  'Failed-login counter shared across workers/instances. service_role only (RLS on, no policies). Rows are disposable.';

-- ── Atomic increment ────────────────────────────────────────
--
-- The whole point of this function is that the read, the window check and the
-- write happen in ONE statement. Two workers racing on the same key cannot both
-- read 4 and both write 5 — INSERT .. ON CONFLICT DO UPDATE takes a row lock,
-- so the second waits and sees the first one's result.
--
-- The window rolls forward rather than being expired by a separate sweep: if
-- the stored window is older than p_window_seconds this is attempt 1 of a new
-- window, otherwise it is the next attempt in the current one.

create or replace function public.record_login_attempt(
  p_key            text,
  p_window_seconds int default 900
)
returns table (attempt_count int, window_started_at timestamptz)
language sql
security definer
set search_path = public
-- The RETURNING clause is wrapped in a CTE and its columns renamed before they
-- are selected out. `attempt_count` and `window_started_at` are BOTH columns of
-- this table and output-parameter names from RETURNS TABLE, and an unqualified
-- reference to a name that is both is an ambiguity error in a SQL-language
-- function. Renaming inside the CTE means the question cannot arise.
as $$
  with upserted as (
    insert into public.login_attempts as la (attempt_key, attempt_count, window_started_at, updated_at)
    values (p_key, 1, now(), now())
    on conflict (attempt_key) do update
      set attempt_count =
            case when la.window_started_at < now() - make_interval(secs => p_window_seconds)
                 then 1
                 else la.attempt_count + 1
            end,
          window_started_at =
            case when la.window_started_at < now() - make_interval(secs => p_window_seconds)
                 then now()
                 else la.window_started_at
            end,
          updated_at = now()
    returning la.attempt_count as new_count, la.window_started_at as new_window
  )
  select new_count, new_window from upserted;
$$;

-- SECURITY DEFINER means the function runs as its owner, so it must not be
-- callable by anyone who should not be counting login attempts.
revoke all on function public.record_login_attempt(text, int) from public;
revoke all on function public.record_login_attempt(text, int) from anon, authenticated;
grant execute on function public.record_login_attempt(text, int) to service_role;

-- ── Optional maintenance ────────────────────────────────────
--
-- Rows are bounded by the number of distinct email+IP pairs that have ever
-- failed, which for a single pharmacy is negligible — this exists so a large
-- deployment has something to schedule, not because the table needs it.
-- Nothing in the application calls it, and the limiter is correct without it:
-- a stale window is already treated as absent by both the read and the RPC.

create or replace function public.prune_login_attempts(p_older_than_hours int default 24)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  removed int;
begin
  delete from public.login_attempts
   where window_started_at < now() - make_interval(hours => p_older_than_hours);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_login_attempts(int) from public;
revoke all on function public.prune_login_attempts(int) from anon, authenticated;
grant execute on function public.prune_login_attempts(int) to service_role;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run these after applying; all three should hold)
-- ════════════════════════════════════════════════════════════
--
--   -- RLS is on and audit_logs has exactly one, owner-only, SELECT policy:
--   select relrowsecurity from pg_class where oid = 'public.audit_logs'::regclass;      -- t
--   select polname, polcmd from pg_policy where polrelid = 'public.audit_logs'::regclass;
--   -- expect one row: owner_read_audit_logs | r
--
--   -- The counter increments and rolls:
--   select * from public.record_login_attempt('verify@example.com:127.0.0.1', 900);     -- 1
--   select * from public.record_login_attempt('verify@example.com:127.0.0.1', 900);     -- 2
--   delete from public.login_attempts where attempt_key = 'verify@example.com:127.0.0.1';
--
--   -- Historical audit data is untouched:
--   select count(*) from public.audit_logs;   -- same as before this migration
