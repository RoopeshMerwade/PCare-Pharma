-- ============================================================
-- SCHEMA 29 — RLS LOCKDOWN: public.* is service_role only
--
-- Closes the layer underneath the API. Every data query this application makes
-- goes through Express on the `service_role` client (config/supabase.js), which
-- BYPASSES RLS — so nothing here changes any behaviour the application has. It
-- removes reachability for everything that is NOT service_role.
--
--   1. Drop the 34 policies whose entire predicate is `auth.uid() IS NOT NULL`.
--   2. Revoke the blanket table grants Supabase gives `anon` / `authenticated`.
--
-- Safe to re-run: every drop is IF EXISTS, every revoke is idempotent. Nothing
-- is created, no row is read, rewritten or deleted, and no function, trigger,
-- view or constraint is touched. Depends on no migration and nothing depends
-- on it; it may be applied to a live database at any time.
--
--
-- WHY THIS SHAPE, AND NOT ROW-SCOPED PREDICATES
-- ---------------------------------------------
-- `auth.uid() IS NOT NULL` reads as a restriction and is not one. It means
-- "any logged-in user", which is every user — it imposes no row-level limit at
-- all. Where it was the predicate on bills, customers, purchases and the
-- ledgers, any holder of the publishable key plus any valid access token could
-- read every sale, every patient phone number and every purchase cost directly
-- through PostgREST, bypassing Express entirely. Server-side authorisation in
-- the service layer never sees such a request.
--
-- The obvious repair is to replace each predicate with the API's own rule
-- (`created_by = auth.uid() or is_owner()`, and so on). That was rejected
-- deliberately, on a measurement: NOTHING IN THIS CODEBASE QUERIES public.*
-- AS `anon` OR `authenticated`. Every createAuthClient() call site —
-- auth.service.js:82,111,120,149,161 and users.service.js:93,171 — is an
-- auth.* operation (signInWithPassword, signOut, refreshSession,
-- resetPasswordForEmail, updateUser). The browser never holds a Supabase
-- session against public.* at all; it holds an httpOnly refresh cookie scoped
-- to /api/v1/auth and talks only to Express.
--
-- So those policies were not guarding a live access path. They WERE an access
-- path, and one the application never asks for. Row-scoped predicates would be
-- 23 judgment calls, each an opportunity to write a rule that diverges from the
-- service layer's, none of them exercised by any code and therefore none of
-- them tested by anything. Denying the role outright is smaller, is verifiable
-- in one query, and fails closed rather than fails-subtly-permissive.
--
-- This is the same shape schema-28 gave public.login_attempts, for the same
-- reason.
--
--
-- WHAT IS DELIBERATELY LEFT IN PLACE
-- ----------------------------------
-- Policies that are already role- or row-scoped are NOT dropped:
--
--   · owner_read_audit_logs                      (schema-28, is_owner())
--   · self_read / self_update on users           (auth.uid() = id)
--   · self_*/owner_* on staff_attendance         (auth.uid() = user_id)
--   · user_read_notifications / user_update_…    (user_id = auth.uid())
--   · owner_* and owner_write_* everywhere else  (owner role check)
--
-- They express the right INTENT, and dropping them would throw away the
-- correct rules along with the wrong ones. After step 2 they are inert: with no
-- table grant, a non-service_role query is refused before any policy decides
-- anything.
--
-- But they are NOT merely dormant-and-correct, and this was measured after
-- applying, not assumed. Every owner_* policy on the live database spells the
-- check inline as `exists (select 1 from users u where u.id = auth.uid() …)`
-- rather than calling public.is_owner(). Reading public.users re-triggers
-- users' OWN policy, which is written the same way, so the cycle is detected
-- at REWRITE time and the query dies with 42P17 "infinite recursion detected
-- in policy for relation users". Because rewriting expands every policy
-- applicable to the command, a `for all` policy does this even to a SELECT.
--
-- Probed as anon after this migration: users, suppliers, purchase_items,
-- staff_invites and supplier_returns all return 500 / 42P17, where tables whose
-- remaining policies are UPDATE-only (bills, customers) correctly return
-- 401 / 42501. This PREDATES schema-29 — a permissive policy beside them never
-- stopped the other from being expanded — and it is invisible to the running
-- application, because service_role bypasses RLS and never expands a policy at
-- all. It surfaces here only because this file is what finally made anyone
-- query these tables as a non-service_role caller.
--
-- So: restoring a grant for a future direct-to-Supabase feature would NOT
-- yield working policies. They must first be rewritten to call
-- public.is_owner(), which schema-28 created for exactly this reason — it is
-- SECURITY DEFINER, so the lookup does not re-enter RLS on users. That is a
-- separate migration and is deliberately not done here; nothing is exposed by
-- the gap, since the failure is an error, not a disclosure.
--
-- NOT AFFECTED: Supabase Storage (its policies live in the `storage` schema,
-- untouched — Module 23's private bucket and signed URLs work exactly as
-- before), the `auth` schema and the whole login/refresh flow, and Realtime
-- (the supabase_realtime publication contains no tables; nothing subscribes).
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. DROP THE "ANY LOGGED-IN USER" POLICIES
-- ════════════════════════════════════════════════════════════
--
-- Grouped by table. The INSERT policies matter at least as much as the SELECT
-- ones: `with_check (auth.uid() IS NOT NULL)` on inventory_ledger and
-- loose_unit_ledger let a non-service_role caller append stock movements
-- directly — writing into the append-only ledgers that FEFO, total_stock and
-- every margin figure are computed from, without passing a single service-layer
-- guard. The ALL policies on patient_conditions, medication_schedules and
-- supplier_invoice_items are writable clinical and staging data on the same
-- terms.

-- ── Sales: every bill in the pharmacy ───────────────────────
drop policy if exists "authenticated_read_bills"            on public.bills;
drop policy if exists "authenticated_insert_bills"          on public.bills;
drop policy if exists "authenticated_read_bill_items"       on public.bill_items;
drop policy if exists "authenticated_insert_bill_items"     on public.bill_items;

-- ── Customers: names and phone numbers ──────────────────────
drop policy if exists "authenticated_read_customers"        on public.customers;
drop policy if exists "authenticated_create_customer"       on public.customers;

-- ── Customer returns ────────────────────────────────────────
drop policy if exists "authenticated_read_cr"               on public.customer_returns;
drop policy if exists "authenticated_insert_cr"             on public.customer_returns;
drop policy if exists "authenticated_read_cr_items"         on public.customer_return_items;
drop policy if exists "authenticated_insert_cr_items"       on public.customer_return_items;

-- ── Cost price and vendor data (criterion A9) ───────────────
-- These are the tables the UI guidelines say Staff must never see. Until now
-- the database granted every authenticated user a full read of all three.
drop policy if exists "authenticated_read_purchases"        on public.purchases;
drop policy if exists "authenticated_read_purchase_items"   on public.purchase_items;
drop policy if exists "authenticated_read_suppliers"        on public.suppliers;

-- ── Stock: the append-only ledgers and their batches ────────
drop policy if exists "authenticated_read_ledger"           on public.inventory_ledger;
drop policy if exists "authenticated_insert_ledger"         on public.inventory_ledger;
drop policy if exists "authenticated_read_loose_ledger"     on public.loose_unit_ledger;
drop policy if exists "authenticated_insert_loose_ledger"   on public.loose_unit_ledger;
drop policy if exists "authenticated_read_batches"          on public.inventory_batches;
drop policy if exists "authenticated_insert_batches"        on public.inventory_batches;

-- ── Catalogue ───────────────────────────────────────────────
drop policy if exists "authenticated_read_medicines"        on public.medicines;
drop policy if exists "authenticated_read_categories"       on public.medicine_categories;

-- ── Clinical data — these were polcmd = '*' (ALL commands) ──
drop policy if exists "auth_read_patient_conditions"        on public.patient_conditions;
drop policy if exists "auth_write_patient_conditions"       on public.patient_conditions;
drop policy if exists "auth_read_medication_schedules"      on public.medication_schedules;
drop policy if exists "auth_write_medication_schedules"     on public.medication_schedules;
drop policy if exists "auth_read_ack"                       on public.adherence_acknowledgments;
drop policy if exists "auth_insert_ack"                     on public.adherence_acknowledgments;

-- ── Module 23 staging — also writable ───────────────────────
drop policy if exists "authenticated_read_supplier_invoices"        on public.supplier_invoices;
drop policy if exists "authenticated_insert_supplier_invoices"      on public.supplier_invoices;
drop policy if exists "authenticated_update_supplier_invoices"      on public.supplier_invoices;
drop policy if exists "authenticated_read_supplier_invoice_items"   on public.supplier_invoice_items;
drop policy if exists "authenticated_write_supplier_invoice_items"  on public.supplier_invoice_items;

-- ── Settings and notifications ──────────────────────────────
drop policy if exists "auth_read_settings"                  on public.pharmacy_settings;
-- Forgeable notifications for any user_id, including NULL (broadcast).
-- user_read_notifications / user_update_notifications are row-scoped and stay.
drop policy if exists "system_insert_notifications"         on public.notifications;


-- ════════════════════════════════════════════════════════════
-- 2. REVOKE THE BLANKET GRANTS
-- ════════════════════════════════════════════════════════════
--
-- Supabase grants anon and authenticated full DML on everything in `public` by
-- default — here, 44 objects (28 tables + 16 views). Dropping policies alone
-- leaves that grant standing, so a policy added later by accident (or by the
-- dashboard's "enable read access for all users" template) would immediately be
-- live. Removing the grant means the policy layer is not the only thing
-- standing between a publishable key and this data.
--
-- It also changes the failure mode in the direction we want. With RLS on and no
-- policy, a stray query returns ZERO ROWS — indistinguishable from "no data".
-- With no grant it returns 42501 permission denied, which is unmissable and
-- names its own cause.
--
-- Views are covered by the same statement. Several (batches_with_stock,
-- margin_analytics, expiry_summary, today_staff_attendance) aggregate exactly
-- the cost and clinical figures the policies above were exposing, and a view
-- does not inherit its base tables' RLS unless it is declared security_invoker
-- — so the grant is the only control on them and revoking it is the point.

revoke all on all tables in schema public from anon, authenticated;

-- Sequences are intentionally not revoked: with no table writable there is
-- nothing a nextval() could be used for, and the identity sequences are
-- service_role's business.

-- Best-effort, so tables created LATER do not silently re-acquire the grant.
-- This only rescinds default privileges entered by the role running this
-- migration (postgres, which is what dashboard DDL and these files use); a
-- table created by another role may still be granted, which is what the
-- standing-grants check in VERIFICATION below is for.
alter default privileges in schema public revoke all on tables from anon, authenticated;

comment on schema public is
  'PCare Pharma application data. Reached ONLY via Express on the service_role client (config/supabase.js). anon and authenticated hold no grants here by design — see schema-29-rls-lockdown.sql. Do not add a policy for those roles without also restoring a grant, deliberately and scoped.';


-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run after applying; all four should hold)
-- ════════════════════════════════════════════════════════════
--
--   -- 1. No bare "any logged-in user" predicate survives anywhere:
--   select tablename, policyname from pg_policies
--    where schemaname = 'public'
--      and (qual = '(auth.uid() IS NOT NULL)' or with_check = '(auth.uid() IS NOT NULL)');
--   -- expect zero rows
--
--   -- 2. No standing grants to the publishable-key roles:
--   select grantee, count(distinct table_name) from information_schema.role_table_grants
--    where table_schema = 'public' and grantee in ('anon','authenticated')
--    group by grantee;
--   -- expect zero rows (was 44 each)
--
--   -- 3. The scoped policies are still there:
--   select tablename, policyname from pg_policies
--    where schemaname = 'public' and tablename in ('audit_logs','users','staff_attendance','notifications')
--    order by tablename, policyname;
--   -- expect owner_read_audit_logs, self_read, self_update, the attendance
--   -- self_*/owner_* set, user_read_notifications, user_update_notifications
--
--   -- 4. Data is untouched and service_role still reads everything:
--   select (select count(*) from public.bills)      as bills,       -- unchanged
--          (select count(*) from public.audit_logs) as audit_logs;  -- unchanged
--
--   -- And the closed door, from the other side:
--   set local role authenticated;
--   select * from public.bills;   -- expect: ERROR 42501 permission denied
--   reset role;
