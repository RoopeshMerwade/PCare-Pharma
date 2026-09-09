-- =============================================================================
-- Module 16 (Notifications) — schema-36: per-user alert dismissals
--
-- Prerequisites:
--   · modules/auth/auth.sql          — public.users, public.is_owner()
--   · db/schema-27-loose-units.sql   — expiry_summary / medicines_with_stock in
--                                      their current form (alerts read them; this
--                                      file does not alter them)
--
-- Purely additive: one new table. Nothing existing is dropped, altered or
-- rewritten — in particular notifications_type_check is NOT touched, because
-- derived alerts never reach the notifications table and both types they use
-- (NEAR_EXPIRY, LOW_STOCK) have been in that constraint since schema-15-20.
-- That matters: the CHECK has been rewritten wholesale four times
-- (schema-15-20 → 21 → 26 → 30) and dropping a value from it fails SILENTLY,
-- because createNotification logs an insert error at WARN and returns undefined.
-- This migration sidesteps that trap entirely rather than adding to it.
--
-- WHAT THIS TABLE IS. Expiry and low-stock alerts are computed from
-- expiry_summary and medicines_with_stock on every request, never stored — a
-- stored "batch B12 expires in 12 days" survives B12 being written off, and the
-- bell then asserts something that stopped being true, with no retirement sweep
-- to correct it. This table stores the one thing that genuinely cannot be
-- computed: which alert a given user has chosen to silence. alert_key carries
-- the severity tier, so silencing a batch at 90 days does not silence it at 30.
-- =============================================================================

create table if not exists public.notification_dismissals (
  user_id      uuid        not null references public.users(id) on delete cascade,
  alert_key    text        not null,
  dismissed_at timestamptz not null default now(),

  primary key (user_id, alert_key),

  -- Shape guard, not a whitelist: the prefix is what tells PATCH /:id/read that
  -- an identifier is an alert key and not a notifications.id UUID, so a row that
  -- does not carry it could never be produced or consumed by the API.
  constraint notification_dismissals_key_shape
    check (alert_key like 'alert:%' and length(alert_key) between 8 and 128)
);

comment on table public.notification_dismissals is
  'Which derived alerts a user has silenced. Not history — a row here is a live '
  'suppression, and the service deletes any whose alert is no longer true.';

comment on column public.notification_dismissals.alert_key is
  'alert:<TYPE>:<entity_id>:<tier>, e.g. alert:NEAR_EXPIRY:<batch_id>:critical. '
  'The tier is part of the identity: that is what makes escalation re-alert.';

comment on column public.notification_dismissals.dismissed_at is
  'When the user silenced it. Informational — the service decides whether a '
  'dismissal still applies by whether its alert is still live, not by age.';

-- No secondary index. The primary key (user_id, alert_key) is a covering prefix
-- for the only two access paths: load all dismissals for a user, and delete a
-- named set of keys for a user.

alter table public.notification_dismissals enable row level security;

drop policy if exists "user_read_own_dismissals"   on public.notification_dismissals;
drop policy if exists "user_insert_own_dismissals" on public.notification_dismissals;
drop policy if exists "user_delete_own_dismissals" on public.notification_dismissals;

create policy "user_read_own_dismissals" on public.notification_dismissals
  for select using (user_id = auth.uid());

create policy "user_insert_own_dismissals" on public.notification_dismissals
  for insert with check (user_id = auth.uid());

-- DELIBERATE DEPARTURE from the house rule that no table gets a DELETE policy.
-- That rule protects records of things that happened; nothing here happened. A
-- dismissal is a live suppression flag, and one whose alert has stopped being
-- true is not history to preserve — it is an alert that has been wrongly
-- silenced. Low stock is not monotone: without deletion, a medicine dismissed
-- once could be restocked, fall low again, and never speak. Deleting is the
-- correctness mechanism, not a cleanup convenience.
create policy "user_delete_own_dismissals" on public.notification_dismissals
  for delete using (user_id = auth.uid());

-- No UPDATE policy: a dismissal is inserted or deleted, never edited.

-- House rule: no GRANTs. The API runs on service_role and bypasses RLS; the
-- policies above are the floor beneath it, and this revoke is correct
-- regardless of run order against schema-29.
revoke all on public.notification_dismissals from anon, authenticated;

-- VERIFICATION (run after applying; all three should hold)
--   select relrowsecurity from pg_class
--    where oid = 'public.notification_dismissals'::regclass;                 -- t
--   select count(*) from pg_policy
--    where polrelid = 'public.notification_dismissals'::regclass;            -- 3
--   select has_table_privilege('authenticated','public.notification_dismissals','select'); -- f
