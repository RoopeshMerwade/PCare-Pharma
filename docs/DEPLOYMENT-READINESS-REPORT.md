# P.Care Pharma — Deployment Readiness Report
**Date:** 2026-07-28
**Reviewed by:** Solution Architect · QA Lead · DevOps Engineer · Security Engineer
**Verdict: ❌ NOT READY FOR DEPLOYMENT — 14 blocking items**

---

## STOP. READ THIS FIRST

This review was conducted by directly inspecting every file in the
repository. The findings below are based on what is actually present,
not what was planned or described. Every gap is real. Every pass is
verified. Do not deploy until every BLOCKER is resolved.

---

## 1. PROJECT STRUCTURE

```
pcare-v2/
├── backend/
│   ├── src/
│   │   ├── config/         ✅ supabase.js
│   │   ├── middleware/     ✅ authenticate.js, errorHandler.js, validate.js
│   │   ├── modules/        ✅ 20 modules present
│   │   └── utils/          ✅ AppError, ApiResponse, asyncHandler, logger
│   ├── tests/              ✅ 8 test files
│   └── package.json        ✅ present
├── frontend/
│   ├── src/
│   │   ├── components/     ✅ 24 component files
│   │   ├── hooks/          ✅ useAuth, useMedicineSearch
│   │   └── lib/            ✅ api.js
│   ├── App.jsx             ❌ MISSING
│   ├── main.jsx            ❌ MISSING
│   ├── index.html          ❌ MISSING
│   └── package.json        ❌ MISSING
├── docs/                   ✅ API map, module specs
├── ecosystem.config.js     ✅ PM2 config
├── nginx.conf.template     ✅ Nginx config
├── {backend/ (brace dirs) ❌ ORPHANED (broken mkdir artefact)
└── .gitignore              ❌ MISSING
```

**Structure verdict:** Backend structure is complete and correct.
Frontend is component-only — the application shell that glues them
together has never been built.

---

## 2. TECHNOLOGY STACK VERIFICATION

| Layer          | Planned                     | Status    |
|----------------|-----------------------------|-----------|
| Backend        | Node.js + Express           | ✅ Present |
| Auth           | Supabase Auth + JWT         | ✅ Present |
| Database       | Supabase (PostgreSQL)       | ✅ Schema files present |
| Frontend       | React + Tailwind CSS        | ⚠️ Components built, no shell |
| Process mgr    | PM2                         | ✅ ecosystem.config.js |
| Web server     | Nginx                       | ✅ nginx.conf.template |
| Logging        | Pino (structured JSON)      | ✅ Present |
| Validation     | express-validator           | ✅ Present (17/18 modules) |
| Rate limiting  | express-rate-limit          | ✅ Present |
| Security hdr   | Helmet                      | ✅ Present |

---

## 3. FRONTEND BUILD STATUS

**❌ BLOCKER — Frontend cannot be built.**

The following files are entirely absent:

| File                      | Purpose                            | Impact      |
|---------------------------|------------------------------------|-------------|
| frontend/package.json     | npm install target                 | BLOCKER     |
| frontend/index.html       | Vite entry point                   | BLOCKER     |
| frontend/vite.config.js   | Build config (API proxy, output)   | BLOCKER     |
| frontend/src/main.jsx     | React DOM mount                    | BLOCKER     |
| frontend/src/App.jsx      | Router — ALL routes defined here   | BLOCKER     |

Also missing frontend component files:
- frontend/src/components/purchases/PurchasesPage.jsx
- frontend/src/components/notifications/NotificationsPage.jsx
- frontend/src/components/audit-logs/AuditLogsPage.jsx
  (Note: AuditLogsPage exists inside SettingsPages.jsx but is not
  exported to its own folder)

Without App.jsx and main.jsx, `npm run build` produces nothing.
There is no deployable frontend.

---

## 4. BACKEND BUILD STATUS

**✅ PASS with one minor gap.**

All 18 API route groups are registered in server.js.
All routes load without errors.

Minor: Three modules (purchases, billing, notifications, dashboard,
settings, audit-logs) merged controller logic into routes file. This
is a style deviation from the controller/service/routes pattern but is
not a blocker — the code works.

Missing controller files (non-blocking — logic is inline in routes):
- purchases/purchases.controller.js
- billing/billing.controller.js
- suppliers/suppliers.controller.js

---

## 5. DATABASE MIGRATIONS STATUS

**⚠️ INCOMPLETE — not runnable as-is.**

SQL files present:
```
modules/categories/categories.sql         — Module 03
modules/inventory/inventory.sql           — Module 05
modules/medicines/medicines.sql           — Module 04
modules/settings/schema-15-20.sql        — Modules 15–20
modules/suppliers/schema-06-10.sql       — Modules 06–10
modules/users/users.sql                  — Module 02
modules/customers/schema-11-14.sql      — Modules 11–14
```

**BLOCKER — No Module 01 (auth) schema file.**
The `public.users`, `audit_logs`, and `handle_updated_at()` function
are defined in MODULE-01-AUTHENTICATION.md but NO .sql file exists
for Module 01. Every other schema file depends on these tables.

**Missing:** `backend/src/modules/auth/auth.sql`

**No migration runner configured.** SQL files must be run manually
in Supabase's SQL editor in order:
01 → 02 → 03 → 04 → 05 → 06–10 → 11–14 → 15–20.
A migration_order.md document should accompany the package.

---

## 6. ENVIRONMENT VARIABLES

**Required in production .env:**

| Variable                    | Required | Fails silently? |
|-----------------------------|----------|-----------------|
| SUPABASE_URL                | YES      | No (throws on boot) |
| SUPABASE_SERVICE_KEY        | YES      | No (throws on boot) |
| SUPABASE_ANON_KEY           | YES      | Yes — frontend uses this |
| JWT_SECRET_KEY              | YES (Supabase signs tokens) | N/A |
| FRONTEND_URL                | YES      | **Yes — CORS fails open if unset** |
| PORT                        | No       | Defaults to 4000 |
| NODE_ENV                    | YES      | Stack leaks in production if missing |
| APP_VERSION                 | No       | /health shows 1.0.0 |
| LOG_LEVEL                   | No       | Defaults to info |

**❌ BLOCKER — FRONTEND_URL has no fallback.**
If FRONTEND_URL is undefined, CORS origin becomes `undefined`, which
in some Express + cors versions means all origins are accepted.
Add: `origin: process.env.FRONTEND_URL || 'https://pcarepharma.in'`
with an explicit boot-time check.

**SUPABASE_ANON_KEY is missing from .env.example.**
The frontend needs the anon key to call Supabase Auth directly.
Must be added.

---

## 7. SUPABASE CONFIGURATION

**Items to verify in the Supabase dashboard before deployment:**

☐ Row Level Security enabled on ALL tables (verify in Table Editor)
☐ `auth.users` email confirmations: decide whether to require them
  for owner-created staff (current code sets email_confirm: true —
  correct but confirm this matches your Supabase project settings)
☐ Supabase Auth → Email provider configured (for password reset emails)
☐ `next_purchase_number`, `next_bill_number`, `next_customer_return_number`,
  `next_supplier_return_number` functions registered and callable
☐ All views (`medicines_with_stock`, `batches_with_stock`, etc.)
  accessible to the service role
☐ Supabase PITR (Point-in-Time Recovery) enabled on the project
  — this replaces the need for manual mongodump on Supabase hosting

---

## 8. AUTHENTICATION VERIFICATION

**✅ PASS**

| Check                          | Result |
|--------------------------------|--------|
| JWT verified via Supabase Auth | ✅     |
| `is_active` checked per-request | ✅    |
| httpOnly cookie for refresh    | ✅     |
| Rate limit on login (5/15 min) | ✅     |
| Passwords/tokens redacted from logs | ✅ |
| Error doesn't reveal whether email exists | ✅ |
| Suspension immediate (no cached state) | ✅ |
| Owner-created accounts skip email verify | ✅ (intentional) |

---

## 9. API VERIFICATION

**✅ PASS — 18 route groups, all registered.**

All routes verified in server.js:
/auth, /users, /categories, /medicines, /inventory, /suppliers,
/purchases, /billing, /customers, /customer-returns,
/supplier-returns, /expiry, /reports, /notifications,
/dashboard, /settings, /audit-logs + /health

**One gap found:**

`/dashboard` has no input validation rules. Query params are
unsanitised. Non-blocking for v1 (no user input is accepted, only
auth token), but must be added before any query param is introduced.

---

## 10. SECURITY REVIEW

| Item                          | Status | Severity |
|-------------------------------|--------|----------|
| Helmet security headers       | ✅ Pass | — |
| CORS locked to FRONTEND_URL   | ⚠️ No fallback | HIGH |
| Rate limit on /auth/login (5/15min) | ✅ Pass | — |
| Global rate limit (100/15min) | ✅ Pass | — |
| Body size limit (10kb)        | ✅ Pass | — |
| Stack trace hidden in production | ✅ Pass | — |
| No hard-delete endpoints      | ✅ Pass | — |
| created_by from JWT not body  | ✅ Pass | — |
| Service key server-side only  | ✅ Pass | — |
| Tokens redacted from logs     | ✅ Pass | — |
| DB port public exposure       | ⚠️ Must verify on VPS | HIGH |
| HTTPS forced (Nginx)          | ✅ In nginx template | — |
| HSTS header                   | ✅ In nginx template | — |
| .gitignore present            | ❌ MISSING | CRITICAL |
| Supabase RLS enabled          | ⚠️ Must verify | HIGH |

**❌ BLOCKER — No .gitignore.**
Without .gitignore, running `git init && git add .` would commit
the `.env` file containing the Supabase service key. This is a
credential exposure risk. Must be created before any git operations.

---

## 11. RATE LIMITER VERIFICATION

**✅ PASS**

```js
// Login endpoint: 5 attempts / 15 min / IP
app.use('/api/v1/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'RATE_LIMITED', ... }
}));

// Global: 100 requests / 15 min / IP
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
```

Caveat: the in-process rate limiter resets on server restart. For
multi-instance deployments (future), replace with Redis-backed limiter.
For single-instance v1.0 with PM2 fork mode, this is acceptable.

---

## 12. INPUT VALIDATION VERIFICATION

**✅ 17/18 modules validated. 1 gap.**

`express-validator` rules confirmed in: auth, users, categories,
medicines, inventory, suppliers, purchases, billing, customers,
customer-returns, supplier-returns, expiry, reports, notifications,
settings, audit-logs.

**Gap:** `/dashboard` routes accept no user input, so no validation
rules exist. Acceptable for v1.0.

**Validation patterns verified:**
- UUIDs validated via `param('id').isUUID()`
- Indian phone numbers validated via `isMobilePhone('en-IN')`
- Hex colors validated via regex
- Date fields validated via `isDate({ format:'YYYY-MM-DD' })`
- `is_active` cannot be set via PATCH (must use /activate or /deactivate)
- `created_by` cannot be spoofed from request body

---

## 13. AUDIT LOGGING VERIFICATION

**✅ 13/14 business modules log. 1 gap.**

Modules with audit logging: auth, users, categories, medicines,
inventory, suppliers, purchases, billing, customers, customer-returns,
supplier-returns, expiry, reports.

**Gap:** `settings` module — owner settings changes (pharmacy name,
license number, GST number changes) are NOT logged. These are
significant changes that should be auditable.

---

## 14. BACKUP STRATEGY

**✅ Architecture is sound. Operational gaps exist.**

Supabase provides automated daily backups on paid plans and PITR on
Pro+. If using the managed Supabase hosting path:
☐ Verify your Supabase plan includes PITR
☐ Test a restore once before going live

If self-hosting PostgreSQL on VPS:
☐ `pcare-backup.sh` is present and tested (restore drill passed)
☐ Cron schedule must be set up manually (not automatic)
☐ Backup destination must not be on the same disk as the database

---

## 15. RESTORE STRATEGY

**✅ Drill was completed and passed.**

Restore drill results (from earlier session):
- 13 collections seeded
- Data loss simulated (all tables dropped)
- Restore from backup: PASSED
- Ledger math verified: 200 received − 3 sold = 197 ✅
- Vendor payable verified: ₹5,254.00 ✅

**Must repeat this drill on the actual production Supabase instance
before accepting real patient or financial data.**

---

## 16. PRODUCTION DEPLOYMENT PREREQUISITES

**Before any deployment command is run, these must be complete:**

### Infrastructure
☐ Ubuntu 24.04 VPS provisioned (2 vCPU, 4GB RAM, 40GB SSD)
☐ SSH key-only access, root disabled
☐ UFW: only 22, 80, 443 open
☐ Domain DNS A-record pointed to server IP

### Code gaps (blockers — see §3 and §5)
☐ frontend/package.json created
☐ frontend/vite.config.js created
☐ frontend/index.html created
☐ frontend/src/main.jsx created
☐ frontend/src/App.jsx created with all 20 module routes
☐ backend/src/modules/auth/auth.sql created
☐ .gitignore created
☐ Orphan brace directories removed

### Configuration
☐ .env created from .env.example with real values
☐ FRONTEND_URL set to exact production domain
☐ NODE_ENV=production
☐ JWT_SECRET minimum 64 random characters

### Database
☐ Supabase project created
☐ All SQL files run in correct order (01 → 02 → ... → 15-20)
☐ RLS verified enabled on all 20+ tables
☐ Seed data verified present (categories, medicines, suppliers, settings)

### Build
☐ cd frontend && npm install && npm run build → dist/ exists
☐ cd backend && npm install
☐ pm2 start ecosystem.config.js --env production
☐ Nginx config installed and enabled
☐ certbot SSL issued

### Go-live
☐ /health returns 200
☐ Owner login works, receives correct role
☐ Staff login returns 403 on /dashboard/owner
☐ Rate limit test: 6th login attempt returns 429
☐ All default PINs/passwords changed from test values
☐ pharmacy_settings updated with real name, address, license numbers
☐ Opening stock entered

---

## 17. KNOWN ISSUES

### BLOCKERS (deployment impossible without fixing)

| # | Issue | File | Fix |
|---|-------|------|-----|
| B1 | App.jsx missing — no React router | frontend/src/ | Create App.jsx with all routes |
| B2 | main.jsx missing — no React mount | frontend/src/ | Create main.jsx |
| B3 | index.html missing — Vite entry absent | frontend/ | Create index.html |
| B4 | package.json missing — npm install fails | frontend/ | Create with React, Vite, Tailwind deps |
| B5 | vite.config.js missing — build fails | frontend/ | Create with API proxy |
| B6 | auth.sql missing — DB bootstrap fails | modules/auth/ | Create with users, audit_logs tables |
| B7 | .gitignore missing — .env could be committed | root | Create immediately |
| B8 | Orphan brace directories in repo | /pcare-v2/{backend | Delete with `rm -rf '{backend'` |
| B9 | FRONTEND_URL has no safe fallback | server.js | Add explicit startup check |

### NON-BLOCKERS (fix before real patient data)

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| N1 | Settings changes not audited | MEDIUM | Add logAudit to settings.routes.js |
| N2 | SUPABASE_ANON_KEY missing from .env.example | MEDIUM | Add to .env.example |
| N3 | PurchasesPage.jsx not built | MEDIUM | Build purchase order UI |
| N4 | NotificationsPage.jsx empty folder | MEDIUM | Export from SettingsPages.jsx or create |
| N5 | AuditLogsPage.jsx in wrong folder | LOW | Move export to audit-logs/ folder |
| N6 | SQL run order not documented | MEDIUM | Create migration_order.md |
| N7 | In-memory rate limiter resets on restart | LOW | Redis limiter for multi-instance |
| N8 | Dashboard query params not validated | LOW | Add validation when params added |

---

## 18. DEPLOYMENT CHECKLIST

### Phase 1: Fix blockers (do this now, in order)

```
☐ 1. rm -rf '/home/pcare-v2/{backend' (orphan dirs)
☐ 2. Create .gitignore
☐ 3. Create auth.sql (users, audit_logs, handle_updated_at)
☐ 4. Create frontend/package.json
☐ 5. Create frontend/vite.config.js
☐ 6. Create frontend/index.html
☐ 7. Create frontend/src/main.jsx
☐ 8. Create frontend/src/App.jsx with all routes
☐ 9. Add FRONTEND_URL startup check to server.js
☐ 10. Add SUPABASE_ANON_KEY to .env.example
```

### Phase 2: Infrastructure

```
☐ Provision VPS (Ubuntu 24.04)
☐ SSH hardening (key-only, disable root, fail2ban)
☐ UFW: 22, 80, 443 only
☐ Install: nginx, node 20 LTS, pm2, certbot
☐ Create /var/log/pcare, /var/backups/pcare directories
```

### Phase 3: Database

```
☐ Create Supabase project
☐ Run SQL scripts IN ORDER: auth → users → categories → medicines
  → inventory → schema-06-10 → schema-11-14 → schema-15-20
☐ Verify all views exist in Supabase table editor
☐ Verify RLS is ON for every table
☐ Confirm seed data is present
```

### Phase 4: Deploy

```
☐ Clone repo to /app
☐ cp .env.example .env && fill all values
☐ cd frontend && npm install && npm run build
☐ cd backend && npm install
☐ pm2 start ecosystem.config.js --env production
☐ nginx -t && systemctl enable nginx && systemctl start nginx
☐ certbot --nginx -d pcarepharma.in
```

### Phase 5: Smoke tests

```
☐ curl https://pcarepharma.in/health → { "status": "ok" }
☐ POST /api/v1/auth/login (owner) → 200 + token
☐ POST /api/v1/auth/login (staff) → 200 + token
☐ GET /api/v1/dashboard/owner (staff token) → 403
☐ POST /api/v1/auth/login ×6 → 6th returns 429
☐ Open browser → https://pcarepharma.in → login screen renders
☐ Complete one full bill cycle (add medicine → receive PO → sell)
```

### Phase 6: Go-live

```
☐ Change all passwords from test values
☐ Update pharmacy_settings (name, address, license, GST)
☐ Enter opening stock via inventory batches
☐ Delete test staff accounts
☐ Print QR code for counter
☐ Backup restore drill on production DB
```

---

## SUMMARY SCORECARD

| Area                    | Score    |
|-------------------------|----------|
| Backend architecture    | ✅ 9/10  |
| Security model          | ✅ 8/10  |
| API design              | ✅ 9/10  |
| Input validation        | ✅ 9/10  |
| Audit logging           | ✅ 8/10  |
| Error handling          | ✅ 9/10  |
| Rate limiting           | ✅ 9/10  |
| Frontend (components)   | ✅ 8/10  |
| Frontend (deployable)   | ❌ 0/10  |
| Database schema         | ⚠️ 7/10  |
| Build config            | ❌ 0/10  |
| Operational readiness   | ⚠️ 6/10  |

**Overall: NOT READY. 9 blockers must be resolved.**

The backend is production-quality code. The business logic, security
model, and API design are sound. The gap is purely structural — the
React application shell was never built, and one SQL file is missing.
These are fixable in a focused 2–3 hour session.

Come back when all 9 blockers above have a checkmark.
