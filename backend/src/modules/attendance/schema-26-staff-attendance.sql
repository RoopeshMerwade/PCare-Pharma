-- ============================================================
-- MODULE 26: STAFF ATTENDANCE — CHECK-IN / CHECK-OUT
--
-- Prerequisites:
--   · Module 01 (auth.sql)        — public.users, public.handle_updated_at()
--   · Module 16 (schema-15-20.sql) — public.notifications
--   · Module 21 (schema-21-…)      — last rewrote notifications_type_check;
--                                    this file rewrites it again, so it must
--                                    run AFTER that one or REFILL_OVERDUE is
--                                    dropped back out of the allowed list.
--
-- Purely additive: one new table, one new function, one new view, and two new
-- values on an existing CHECK. Nothing existing is dropped or rewritten.
-- ============================================================

-- ══════════════════════════════════════════
-- The pharmacy's civil date.
--
-- Attendance is the only thing in this system keyed BY DATE — the unique
-- constraint below means "one row per person per day", so what "day" means
-- has to be decided once and used everywhere. It cannot be the UTC slicing
-- the sales figures use: UTC runs 5h30 behind IST, so every hour before
-- 05:30 IST belongs to the PREVIOUS UTC date, and a staff member opening the
-- shop early would be checking in against yesterday's row.
--
-- The table default and the view below both call this function rather than
-- writing the expression twice, so "today" can never come to mean two
-- different things inside one request.
-- ══════════════════════════════════════════
-- `set search_path = ''` because this function is evaluated inside a column
-- DEFAULT and a view — both run under whatever search_path the calling session
-- happens to have. Pinning it empty means no schema anyone puts in front can
-- change what "today" resolves to. `now()` lives in pg_catalog, which is always
-- searched implicitly, so the body needs no qualification.
create or replace function public.pharmacy_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

comment on function public.pharmacy_today() is
  'The pharmacy''s local calendar date (IST). Single definition of "today" for staff_attendance and today_staff_attendance.';

-- ══════════════════════════════════════════
-- staff_attendance — one row per staff member per day.
--
-- `status` is a GENERATED column, not a stored one that application code
-- sets. "Nothing is stored that can be computed" is the rule this codebase
-- applies to stock, margins, supplier balances and adherence, and status here
-- is a pure function of check_out_time. Deriving it in Postgres means the
-- column and the view below cannot disagree, and no code path can write a
-- status that contradicts the timestamps beside it.
--
-- 'absent' therefore never appears in this table, and correctly so: absence
-- is the ABSENCE OF A ROW, which is exactly what the view computes from the
-- left join. A row here always means the person came in.
-- ══════════════════════════════════════════
create table if not exists public.staff_attendance (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid        not null references public.users(id) on delete cascade,
  attendance_date date        not null default public.pharmacy_today(),
  check_in_time   timestamptz not null default now(),
  check_out_time  timestamptz,
  status          text generated always as (
                    case when check_out_time is not null then 'checked_out' else 'present' end
                  ) stored,
  notes           text,
  created_by      uuid        references public.users(id),   -- who RECORDED it (owner override ≠ user_id)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One shift record per person per day. This is also the race guard: two
  -- simultaneous check-ins collide here rather than both inserting, and the
  -- API maps 23505 back to ALREADY_CHECKED_IN.
  constraint staff_attendance_user_date_unique unique (user_id, attendance_date),

  -- A checkout before the check-in it closes is a clock error, not a shift.
  constraint staff_attendance_out_after_in
    check (check_out_time is null or check_out_time >= check_in_time)
);

comment on column public.staff_attendance.created_by is
  'The user who RECORDED the check-in — equal to user_id for self-service, the owner''s id for an administrative override.';

-- Today's board and the history filter both range over the date; the unique
-- constraint above already indexes (user_id, attendance_date), so a second
-- index on that pair would only be dead weight.
create index if not exists idx_attendance_date on public.staff_attendance(attendance_date desc);

drop trigger if exists staff_attendance_updated_at on public.staff_attendance;
create trigger staff_attendance_updated_at
  before update on public.staff_attendance
  for each row execute procedure public.handle_updated_at();

-- ══════════════════════════════════════════
-- RLS.
--
-- The API reaches this table through the service_role client, which bypasses
-- RLS entirely — so these policies are not what enforces the permission
-- model (attendance.service.js is). They are the floor underneath it: if
-- anything ever queries this table with a user's own JWT, a staff member can
-- see and write their own attendance and nothing else.
--
-- No delete policy, deliberately. Nothing in this system is hard-deleted.
-- ══════════════════════════════════════════
alter table public.staff_attendance enable row level security;

create policy "self_read_attendance" on public.staff_attendance
  for select using (auth.uid() = user_id);

create policy "owner_read_attendance" on public.staff_attendance
  for select using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

create policy "self_insert_attendance" on public.staff_attendance
  for insert with check (auth.uid() = user_id);

create policy "owner_insert_attendance" on public.staff_attendance
  for insert with check (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

create policy "self_update_attendance" on public.staff_attendance
  for update using (auth.uid() = user_id);

create policy "owner_update_attendance" on public.staff_attendance
  for update using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- ══════════════════════════════════════════
-- Extend the notifications type constraint (table created in Module 16,
-- last altered by Module 21 — the full list is restated because a CHECK
-- cannot be added to incrementally).
-- ══════════════════════════════════════════
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('LOW_STOCK','NEAR_EXPIRY','CUSTOMER_RETURN_PENDING',
                  'SUPPLIER_RETURN_PENDING','SYSTEM','PURCHASE_OVERDUE','REFILL_OVERDUE',
                  'STAFF_CHECK_IN','STAFF_CHECK_OUT'));

-- ══════════════════════════════════════════
-- today_staff_attendance — every active staff account, with today's record
-- if there is one. The LEFT JOIN is the point: a staff member who has not
-- arrived has no row in staff_attendance, and this view is what turns that
-- silence into an explicit 'absent'. A board built from the table alone
-- would simply omit the people it most needs to show.
--
-- security_invoker so the base table's RLS applies to whoever queries the
-- view, rather than to its owner. The API's service_role client bypasses RLS
-- either way; this matters only for a direct client query.
-- ══════════════════════════════════════════
create or replace view public.today_staff_attendance
with (security_invoker = on) as
select
  u.id                                                  as user_id,
  u.full_name,
  u.phone,
  u.role,
  u.avatar_url,
  u.is_active,
  coalesce(sa.attendance_date, public.pharmacy_today()) as attendance_date,
  sa.id                                                 as attendance_id,
  sa.check_in_time,
  sa.check_out_time,
  case
    when sa.id is null                 then 'absent'
    when sa.check_out_time is not null  then 'checked_out'
    else 'present'
  end                                                   as status,
  sa.notes
from public.users u
left join public.staff_attendance sa
  on sa.user_id = u.id
 and sa.attendance_date = public.pharmacy_today()
where u.role = 'staff'
  and u.is_active = true
order by u.full_name asc;
