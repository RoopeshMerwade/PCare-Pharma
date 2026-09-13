# P.Care Pharma — Database Migration Order
## Run ALL scripts in Supabase SQL Editor in this exact sequence
### 19 files. Steps 1–11 create; steps 12–13 alter what step 11 created; step 14 is independent of Module 23 and only needs steps 1, 8 and 9; step 15 runs last among the schema files and touches steps 4, 5, 6, 7, 10 and 13; step 16 is security hardening that depends only on step 1 and that nothing else depends on; step 17 is the RLS lockdown, which depends on nothing and touches no object — run it after every schema file so it is the final word on who can reach `public.*`; step 18 is Module 30, which is purely additive and carries its own revoke, so it is safe on either side of step 17 but must come after step 14; step 19 is Module 36, one additive table that depends only on step 1 and likewise carries its own revoke.

1. backend/src/modules/auth/auth.sql
   Creates: public.users, audit_logs, handle_updated_at()

2. backend/src/modules/users/users.sql
   Creates: indexes, RLS policies, staff_summary view, enforce_staff_limit trigger

3. backend/src/modules/categories/categories.sql
   Creates: medicine_categories, categories_with_count view

4. backend/src/modules/medicines/medicines.sql
   Creates: medicines, medicines_with_stock view

5. backend/src/modules/inventory/inventory.sql
   Creates: inventory_batches, inventory_ledger, batches_with_stock view,
   prevent_negative_stock trigger, block_ledger_mutation trigger

6. backend/src/modules/suppliers/schema-06-10.sql
   Creates: suppliers, purchases, purchase_items, bills, bill_items,
   all related views and sequences

7. backend/src/modules/customers/schema-11-14.sql
   Creates: customers, customer_returns, supplier_returns,
   expiry_summary view and all related sequences

8. backend/src/modules/settings/schema-15-20.sql
   Creates: notifications, pharmacy_settings, margin_analytics view,
   daily_sales_summary view, audit indexes

9. backend/src/modules/chronic-care/schema-21-chronic-care.sql
   Creates: chronic_conditions (seeded fixed list), patient_conditions,
   medication_schedules, adherence_acknowledgments, medication_schedule_status
   view. Also ALTERs the notifications type constraint (Module 16's table)
   to add REFILL_OVERDUE — must run AFTER schema-15-20.sql.

10. backend/src/db/schema-22-atomic-workflows.sql
    Creates: create_bill_atomic(), approve_customer_return_atomic(),
    send_supplier_return_atomic(), receive_purchase_atomic().
    REQUIRED by the API — bill creation, purchase receiving, and return
    approval/sending call these RPCs (single-transaction workflows with
    batch-row locking). Without this migration those endpoints return
    500 MIGRATION_REQUIRED.

11. backend/src/modules/supplier-invoices/schema-23-supplier-invoices.sql
    Creates: pg_trgm extension + trigram indexes on medicines/suppliers,
    the private `supplier-invoices` storage bucket, supplier_invoices,
    supplier_invoice_items, supplier_invoices_with_counts view,
    match_medicines_trgm(), match_suppliers_trgm(), commit_supplier_invoice().
    REQUIRED by Module 23 only — the rest of the app is unaffected if it is
    skipped, but every /api/v1/supplier-invoices endpoint fails without it.
    Must run LAST: commit_supplier_invoice() writes to inventory_batches,
    inventory_ledger, purchases and purchase_items, and calls
    next_purchase_number() from step 6.

12. backend/src/modules/supplier-invoices/schema-24-invoice-line-detail.sql
    ALTERs only — adds printed_rate, printed_mrp, rate_basis, pack_raw,
    discount_pct, gst_pct, mfg_code_raw to supplier_invoice_items;
    supplier_dl_no, printed_item_count to supplier_invoices; adds 'tablets'
    to the medicines.unit CHECK; recreates supplier_invoices_with_counts so
    `si.*` picks up the new document columns.
    Purely additive — nothing is dropped and no IMPORTED record is rewritten.
    Must run AFTER step 11 (it alters that step's tables) and after step 4
    (it replaces the medicines.unit constraint).
    Without it, ingestion writes NULL into columns the API expects and every
    line reports RATE_BASIS_UNRESOLVED.

13. backend/src/modules/supplier-invoices/schema-25-pack-contents.sql
    THE DENOMINATION FIX. Adds sale_unit, content_quantity, content_unit,
    sub_pack_quantity, sub_pack_unit, pack_recognised to supplier_invoice_items;
    DROPS rate_basis and pack_size; reverts the medicines.unit CHECK to its
    original list; replaces commit_supplier_invoice() so stock is
    (qty_billed + qty_free) rather than that times pack_size.

    Why it matters: the Pack column describes what is INSIDE one saleable unit
    ("100'S" = 100 tablets in a strip). It is not a count of saleable units.
    Steps 11–12 multiplied by it, which posted quantities into inventory_ledger
    in a different denomination from the one billing, FEFO and returns use —
    5 strips became 500. Verified against MEDICO M002948 and M002277: on all 18
    legible lines, qty_billed x printed_rate = line_total, so the rate is per
    Qty unit and the pack never enters stock or money.

    Must run AFTER step 12. Safe to run on an empty database; if any invoice has
    already been IMPORTED, its batches are in the wrong denomination and must be
    corrected by stock adjustment — this migration deliberately does not rewrite
    historical records.

14. backend/src/modules/attendance/schema-26-staff-attendance.sql
    Creates: pharmacy_today(), staff_attendance, the today_staff_attendance
    view, RLS policies and the updated_at trigger. Also ALTERs the
    notifications type constraint to add STAFF_CHECK_IN and STAFF_CHECK_OUT.

    Depends only on step 1 (public.users, handle_updated_at), step 8
    (notifications) and step 9 — it must run AFTER schema-21-chronic-care.sql
    because that file last rewrote notifications_type_check, and a CHECK cannot
    be added to incrementally: this migration restates the whole list, so
    running it BEFORE step 9 would have step 9 drop STAFF_CHECK_IN/OUT back out.
    Nothing in Module 23 is involved either way.

    Two things worth knowing before changing it:

    · `pharmacy_today()` is the IST calendar date, not `current_date`.
      Attendance is the one table keyed BY DATE — one row per person per day —
      and UTC runs 5h30 behind IST, so every hour before 05:30 IST belongs to
      the previous UTC day. The table default and the view both call this one
      function so "today" cannot come to mean two different things in one
      request. (The UTC slicing elsewhere in the app is a separate pre-existing
      skew and is untouched here.)

    · `status` is a GENERATED column, not one the API writes. It is a pure
      function of check_out_time, and "nothing is stored that can be computed"
      is the rule this codebase applies to stock, margins and balances. Being
      generated is what makes it impossible for the column and the view to
      disagree. 'absent' therefore never appears IN the table — absence is the
      absence of a row, which is what the view's left join computes.

    Purely additive and safe to re-run: nothing is dropped and no existing row
    is rewritten.

15. backend/src/db/schema-27-loose-units.sql
    LOOSE UNITS — selling tablets out of an opened strip.

    Creates: loose_unit_ledger (+ its prevent_negative_loose_stock and
    block_loose_ledger_* triggers), is_countable_content(), the
    batch_loose_stock view. Adds pack_content_quantity/pack_content_unit to
    medicines, content_quantity/content_unit to inventory_batches, and
    is_loose/pack_content_quantity to bill_items. Adds 'strip_opened' to the
    inventory_ledger reason CHECK. Replaces create_bill_atomic(),
    approve_customer_return_atomic() and commit_supplier_invoice().

    **inventory_ledger's denomination does not change.** It still counts sealed
    saleable units, exactly as schema-25 restored. Loose stock is a SECOND
    append-only ledger counted in contents, and the only bridge between the two
    is opening a pack: -1 to the sealed ledger, +content_quantity to the loose
    one, both tagged 'strip_opened'. Anything that reads the sealed ledger
    keeps meaning what it meant.

    Must run LAST. It rebuilds batches_with_stock, medicines_with_stock and
    expiry_summary — those views select `b.*` / `m.*` / `bws.*`, and adding
    columns mid-expansion is something CREATE OR REPLACE VIEW cannot do, so all
    three are dropped and recreated in dependency order. It also replaces two
    of step 10's functions and one of step 13's, so running it before either
    would have them overwrite it.

    Safe on a populated database and safe to re-run. Every added column is
    nullable or defaulted (`bill_items.is_loose` defaults to false, which is
    what every historical row is), no existing row is rewritten, and no
    existing figure changes: a catalogue that never records pack contents
    simply has no medicine that can be split, and the API behaves exactly as it
    did before.

    Two things worth knowing before changing it:

    · Only TABLET, CAPSULE and PIECE contents may be split, via
      is_countable_content(). A 100ML bottle and a 30GM tube are ONE saleable
      thing each — treating the number as a count of units is the same
      denomination error schema-25 had to undo, one layer down.

    · The batch's content_quantity wins over the medicine's; the medicine's is
      the fallback for batches created before this migration. Where neither is
      set the batch cannot be split at all, and the trigger raises
      NOT_SPLITTABLE rather than assuming a pack size — a guessed content
      quantity would put a wrong number of tablets on the shelf with nothing
      downstream able to tell.

16. backend/src/db/schema-28-security-hardening.sql
    SECURITY HARDENING. Two independent, additive changes:

    · RLS on `public.audit_logs` with a single owner-only SELECT policy
      (`public.is_owner()` from step 1). It was the only table carrying
      who-did-what data — including the email address on every failed login —
      with RLS switched off. No INSERT/UPDATE/DELETE policy is created: writes
      come from `utils/audit.js` on the service_role client, and a trail the
      application can rewrite is not evidence of anything.

    · `public.login_attempts` + `record_login_attempt()` — shared state for the
      per-account failed-login limiter (5 per email+IP per 15 min), which was a
      module-level JS `Map` and therefore counted per PROCESS: under PM2 cluster
      mode the real ceiling was 5 x workers and a restart reset it to zero.
      RLS on with no policies — service_role only.

    Depends only on step 1 (`public.is_owner()`). Order-independent with respect
    to every other file: nothing later reads or writes what it creates.

    Safe on a populated database and safe to re-run. Nothing is dropped, no
    existing row is read or rewritten, and every statement is guarded
    (`if not exists` / `drop policy if exists` / `create or replace`).

    **The API works without it**, which is deliberate. `utils/loginAttemptStore.js`
    probes for the table once per process and falls back to the in-memory Map,
    logging a warning that names this file — the same posture Module 27 takes
    with `config/capabilities.js`. A pending migration may cost the shared
    counter; it must never cost the till. Restart the API after applying so the
    probe re-runs.

17. backend/src/db/schema-29-rls-lockdown.sql
    RLS LOCKDOWN — `public.*` becomes service_role only. Drops the 34 policies
    whose entire predicate was `auth.uid() IS NOT NULL`, then revokes the
    blanket table grants Supabase gives `anon` and `authenticated`.

    `auth.uid() IS NOT NULL` reads as a restriction and is not one: it means
    "any logged-in user", which is every user. Where it was the predicate on
    bills, customers, purchases, suppliers and both ledgers, any holder of the
    publishable key plus a valid access token could read every sale, every
    patient phone number and every purchase cost straight through PostgREST,
    and INSERT into the append-only ledgers — none of it passing a single
    service-layer guard, so no API-side authorisation fix could see it.

    The predicates were not narrowed to row-scoped rules, deliberately: nothing
    in this codebase queries `public.*` as `anon` or `authenticated`. Every
    `createAuthClient()` call site is an `auth.*` operation, and the browser
    holds no Supabase session against `public.*` at all. Those policies were not
    guarding an access path, they WERE one, and one the application never uses.

    Policies that are already role- or row-scoped are kept (`owner_read_audit_logs`,
    the `users` and `staff_attendance` self_*/owner_* sets, the row-scoped
    notifications pair, and the `owner_write_*` policies). See the file header:
    they are inert under the revoked grant, and they are also latently broken —
    they spell the owner check inline against `public.users` instead of calling
    `public.is_owner()`, which recurses (42P17). That predates this file, is
    invisible to the API (service_role bypasses RLS), and must be repaired
    before any grant is ever restored.

    Depends on nothing and nothing depends on it. Safe on a populated database
    and safe to re-run: no table, row, function, trigger, view or constraint is
    touched, and every statement is `drop policy if exists` or an idempotent
    revoke. **No API change and no restart required** — every backend query runs
    on the service_role client, which bypasses RLS and keeps all 44 grants.

    NOT affected: Supabase Storage (policies live in the `storage` schema, so
    Module 23's private bucket and signed URLs are unchanged), the `auth` schema
    and the whole login/refresh flow, and Realtime (its publication has no
    tables).

18. backend/src/modules/stock-requisitions/schema-30-stock-requisitions.sql
    MODULE 30 — STOCK REQUISITIONS. Creates: `stock_requisitions`,
    `stock_requisition_items`, `medicine_vendor_prices` (view),
    `stock_requisitions_with_totals` (view), `stock_requisition_seq` +
    `next_requisition_number()`, one partial index on `inventory_batches`, and
    three new values on `notifications_type_check`.

    Depends on step 1 (`public.users`, `handle_updated_at()`), step 4
    (`medicines`), step 5 (`inventory_batches`), step 6 (`suppliers`,
    `purchases`, `purchase_items`), step 8 (`notifications`) and step 16
    (`public.is_owner()`).

    **Must run after step 14.** That file last rewrote `notifications_type_check`,
    and a CHECK cannot be extended incrementally — this one restates all nine
    existing values plus its own three. Running step 9 or step 14 again AFTER
    this file silently drops `STOCK_REQUISITION_RAISED`, `_APPROVED` and
    `_REJECTED` back out of the allowed list, and the failure is invisible:
    `createNotification` logs an insert failure at WARN and returns undefined, so
    the write succeeds, the bell stays empty and nothing surfaces. If you re-run
    either of those files, re-run this one.

    Should run after step 17 so it inherits the revoked default privileges, but
    it carries its own explicit `REVOKE ... FROM anon, authenticated` on all
    four new objects, so either order is safe. Its policies call
    `public.is_owner()` rather than spelling the owner check inline, so unlike
    the older `owner_*` sets they are not latently broken by the 42P17
    recursion described in step 17.

    Two things worth knowing before changing it:

    · **`medicine_vendor_prices` has two sources and the second is not
      belt-and-braces.** Source A is `purchase_items ⋈ purchases` where
      `status = 'received'` — the status filter is not policy, it is where the
      data is: `purchase_items.mrp` is NULL until receipt fills it. But no
      manual PO has ever reached `received` on this database (the
      `receive_purchase_atomic` arity defect, see the Known incomplete work
      section of CLAUDE.md), and Module 23 has never run against a live key.
      Source B — batches that record their own `supplier_id` — is therefore the
      whole view in practice, which is why `POST /inventory/batches` now
      validates `supplier_id` and the Add Batch form asks for it. Remove source
      B and the vendor dropdown is blank for every medicine in the shop.

    · **The four snapshot columns on `stock_requisition_items` are deliberate.**
      `supplier_name`, `unit_cost`, `mrp` and `price_as_of` look like a
      violation of "nothing stored that can be computed" and are not: they
      answer "what did the owner approve", the same past-tense question
      `bill_items.unit_price` answers. The migration carries the full argument
      above the table.

    Purely additive and safe to re-run: every object is `create ... if not
    exists` or `create or replace`, every policy is dropped before it is
    created, and the only existing object touched is the notifications CHECK.

19. backend/src/modules/notifications/schema-36-notification-dismissals.sql

    Module 36 — derived expiry and low-stock alerts. One new table,
    `notification_dismissals (user_id, alert_key, dismissed_at)`. Depends only
    on step 1 (`public.users`) and, at runtime, on the `expiry_summary` and
    `medicines_with_stock` shapes step 15 last rebuilt — it reads neither at
    migration time and alters neither, so it is safe on either side of steps 16
    and 17 and carries its own `REVOKE ... FROM anon, authenticated`.

    **Notably it does NOT touch `notifications_type_check`.** Expiry and
    low-stock alerts are computed per request and never inserted, and both
    types they use (`NEAR_EXPIRY`, `LOW_STOCK`) have been in that constraint
    since step 8 — so this migration adds nothing to the CHECK that has already
    been rewritten wholesale four times.

    Two things worth knowing before changing it:

    · **This table is the one place a DELETE policy is correct.** Everywhere
      else in this schema a row records something that happened and is never
      hard-deleted. A dismissal records nothing that happened — it is a live
      suppression flag, and one whose alert has stopped being true is not
      history worth keeping, it is an alert that has been wrongly silenced.
      Expiry is monotone so an expiry dismissal never needs revoking, but low
      stock is not: without deletion a medicine dismissed once could be
      restocked, fall low again under an identical key, and never speak again.
      The service deletes stale dismissals on every read for exactly that
      reason.

    · **The API survives this file not being applied.** `config/capabilities.js`
      probes once per process for the table; where it is absent the derived
      alerts are simply not offered and the bell behaves as it did before
      Module 36, stored events and all. That is deliberate — querying a table
      PostgREST does not know fails the WHOLE request, which would take
      `/notifications` down and break the bell for the attendance and
      requisition events that do work. **The probe caches, so restart the API
      after applying this file.**

    After applying and restarting, expect a one-time backlog: with no
    dismissals recorded, every batch inside the 90-day window alerts at once.
    Have the owner click "Mark all as read" once to set the baseline. From then
    on only a batch that CROSSES a threshold speaks again.

    Purely additive and safe to re-run: `create table if not exists`, and every
    policy is dropped before it is created.

20. backend/src/modules/supplier-invoices/schema-37-invoice-tax-detail.sql

    Module 23 (cont.) — invoice tax detail, document header and party
    snapshots. Depends only on steps 11–13 (the two supplier-invoice tables)
    and, at migration time, on `handle_updated_at()` from step 1 and
    `next_purchase_number()` from step 6, both of which exist long before it.
    It touches nothing any later migration created, so it is safe as the new
    last step and would also be safe immediately after step 13.

    Adds 30 columns to `supplier_invoices`, 13 to `supplier_invoice_items`, and
    one new table, `supplier_invoice_tax_summary (invoice_id, tax_rate, …)` —
    the vendor's own HSN/tax block, **one row per rate**, because an invoice
    routinely carries 5%, 12% and 18% together and modelling that as columns
    would fix the rate list in DDL.

    Four things worth knowing before changing it:

    · **`invoice_type` and `payment_type` are separate axes, deliberately.**
      "CREDIT" in a payment-terms column means the pharmacy has not paid yet;
      it does not mean the document is a credit note. Collapsing the two would
      make every unpaid delivery look like a return — a stock movement in the
      opposite direction. `invoice_type` is the only new NOT NULL column, and
      its DEFAULT `'TAX_INVOICE'` is exactly what every pre-migration row
      already was, which is the whole of the backfill.

    · **`round_off` and `adjustment_amount` carry no `>= 0` CHECK.** MEDICO
      M002948's round-off is −0.21 (taxable 10327.05 + GST 1263.16 = 11590.21
      against a printed payable of 11590.00), and rounding down is the commoner
      direction. A non-negative constraint would make the ordinary case
      unstorable. Every other money column keeps the `>= 0` discipline.

    · **The view is DROP + CREATE, not `create or replace`.** `si.*` expands at
      creation time, so §37.1's thirty new columns land where `supplier_name`,
      `uploaded_by_name` and `approved_by_name` currently sit. CREATE OR REPLACE
      may only append view columns, never rename one, so it fails with 42P16
      and takes the migration down with it. Same trap schema-24 §24.5
      documents, one migration later.

    · **`commit_supplier_invoice()` is replaced again, and this file is now its
      whole current definition.** The ONLY behavioural change from schema-25 is
      one guard: a document whose `invoice_type` is not `'TAX_INVOICE'` is
      refused. `v_units = qty_billed + qty_free` and the `unit_cost`/`mrp`
      passthrough are byte-identical — no costing behaviour changes. A credit
      note moves stock OUT, which is what `supplier_returns` and
      `send_supplier_return_atomic` already own; teaching a receipts function to
      decrement stock would give two functions authority over the same ledger
      sign.

    **The API survives this file not being applied.** `config/capabilities.js`
    probes once per process for `supplier_invoices.invoice_type`; where it is
    absent the new fields are stripped from every write and Module 23 behaves
    exactly as it did before — documents are still read, reviewed and imported,
    only the tax detail is not retained. That is load-bearing rather than
    defensive dressing: `ingestInvoice` writes the whole header in ONE insert,
    and sending a column PostgREST does not know rejects the entire statement
    with PGRST204 — so without the probe an unmigrated database would fail every
    upload, after paying for the storage write and the Gemini call. **The probe
    caches, so restart the API after applying this file.**

    Purely additive and safe to re-run: 49 `add column if not exists`, one
    `create table if not exists`, every index `if not exists`, and every policy
    dropped before it is created.

## Files added after step 20

These exist and must be run; the numbering above predates them.

- **backend/src/db/schema-31-live-drift.sql** — run immediately after step 18
  (schema-30), before schema-32. It commits back objects that existed only on the
  live project: `purchases.invoice_no`, the 4-argument `receive_purchase_atomic`,
  `purchases_with_totals` carrying `invoice_no` (and `supplier_balances`, rebuilt
  on top of it), and RLS on `chronic_conditions`. Without it, schema-34 aborts
  with 42883.
- **backend/src/db/schema-32 … schema-35** — run in numeric order after schema-31.
- **backend/src/db/schema-38-delete-bills.sql** — run last. Owner bill deletion:
  `bills_in_ist_range()`, `preview_bill_deletion()`, `delete_bill_atomic()`,
  `delete_bills_in_range_atomic()` and the ungranted `delete_bills_core()`.
  Depends on schema-06-10, 11-14, 21 and 27 and on `audit_logs`; changes no table
  or view. Deleting a bill removes the bill, its lines, rejected returns and
  adherence acknowledgments, writes an audit row with a snapshot of each bill in
  the same transaction, and **never touches either stock ledger**, so stock is not
  returned. Bills with a pending or approved return are refused. It replaces an
  unapplied draft, `schema-38-delete-bills-range.sql`, and drops that draft's
  functions if they exist. Safe to re-run.

## Module 23 also needs, outside SQL:
- `GEMINI_API_KEY` in backend/.env (see backend/.env.example). Without it the
  API still boots; the invoice endpoints answer 503 EXTRACTION_UNAVAILABLE.
- The `supplier-invoices` bucket must stay PRIVATE. Step 11 creates it that
  way; the API only ever hands out short-lived signed URLs.

## After running all scripts:
- Verify all tables exist in Supabase Table Editor
- Verify RLS is ON for every table (shield icon = green)
- Verify seed data in pharmacy_settings (14 rows)
- Verify seed categories (10 rows)
- Verify seed medicines (13 rows)
- Verify seed suppliers (3 rows)
