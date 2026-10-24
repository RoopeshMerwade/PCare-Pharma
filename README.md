# P.Care Pharma

A management and point-of-sale (POS) system for a single retail pharmacy in India. It runs the counter (billing), the stock room (batches, expiry, stock requests), purchasing (purchase orders, supplier invoices read by AI), and the owner's view of the business (dashboards, reports, audit log).

It is built for one shop with **one owner and up to four staff** who share one internet connection. Many design choices in the code follow from that: rate limits are set per account rather than per IP, there is one canonical stock ledger, and everything the owner must sign off on is kept behind an owner-only role.

Production: <https://pcare-pharma.com>

---

## Contents

- [What it does](#what-it-does)
- [Roles](#roles)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started (local)](#getting-started-local)
- [Database setup](#database-setup)
- [Configuration](#configuration)
- [Testing](#testing)
- [API](#api)
- [Deployment](#deployment)
- [Security model](#security-model)
- [Rules for contributors](#rules-for-contributors)
- [Further documentation](#further-documentation)

---

## What it does

| Area | What the user gets |
|---|---|
| **Billing (POS)** | Search medicines, build a bill, take cash / UPI / card / credit. Stock is picked **FEFO** (first expiry, first out) automatically. Sells whole packs or loose units (e.g. 3 tablets from a strip). Bills are immutable; mistakes are corrected with a customer return. |
| **Medicines & categories** | Catalogue with generic name, manufacturer, HSN code, unit (`tablets`, `strips`, `vials`, …), pack contents (e.g. 10 TABLET per strip), low-stock threshold, and generic alternatives. Up to 30 active categories. |
| **Inventory** | Each medicine has batches (batch no., expiry, cost, MRP, selling price). Stock is **computed from an append-only ledger**, never stored as a number. The owner can adjust stock or write off a batch, always with a reason. |
| **Expiry tracker** | Batches grouped by how soon they expire, the value at risk, and one-click write-off of expired stock. |
| **Suppliers & purchases** | Distributor records, purchase orders (draft → sent → received), receiving goods into new batches, supplier returns with debit notes, supplier balances. |
| **Supplier invoices (AI)** | Upload a distributor's invoice (PDF/JPG/PNG/WebP). Google Gemini reads it into lines; the app matches each line to a catalogue medicine, checks the tax math, and flags problems. Staff review and correct it; the owner approves, which creates the batches, ledger rows and a purchase record in one transaction. |
| **Stock requests** | Staff raise a request for what is running low, with the last price each distributor charged. The owner approves or rejects it and can export it as XLSX or PDF to send to a distributor. |
| **Customers** | Customer records with purchase history and stats. |
| **Customer returns** | Staff raise a return against a bill (checked against the quantity sold). The owner approves it, which returns the stock and records the refund. |
| **Chronic care** | Track a patient's long-term conditions and medication schedules. At billing, the counter is warned if a refill is too early or overdue, and staff must acknowledge the warning before the sale goes through. |
| **Attendance** | Staff check in and out; the owner sees today's board and the history. |
| **Notifications** | A bell with stored events (attendance, requests) and live alerts (low stock, near expiry) that can be dismissed. |
| **Dashboards & reports** | Owner: revenue trends, payment mix, margins, top medicines, stock health, purchases. Staff: their own day. Sales report exports to Excel. |
| **Settings & audit log** | Pharmacy details (name, licence, GST no.) and a log of every sensitive action, readable only by the owner. |

---

## Roles

There are exactly two roles. Each request is checked on the server; the frontend hides pages only for convenience.

| | Owner | Staff |
|---|---|---|
| Create bills, raise returns and stock requests, check in/out | ✅ | ✅ |
| See bills / returns / requests | All | Only their own |
| See purchase cost and supplier details | ✅ | ❌ (with two deliberate exceptions: invoice review and vendor prices on stock requests) |
| Approve returns, stock requests, supplier invoices | ✅ | ❌ |
| Catalogue, suppliers, purchases, expiry write-offs, stock adjustments | ✅ | ❌ |
| Staff accounts, settings, reports, audit log, bill deletion | ✅ | ❌ |

---

## How it works

```
 Browser (React SPA)
      │  HTTPS
      ▼
 nginx ── serves frontend/dist, proxies /api/* ──►  Express API (Node, PM2, :4000)
                                                         │  service_role key
                                                         ▼
                                              Supabase (Postgres + Auth + Storage)
                                                         │
                                       Google Gemini ◄───┘ (invoice reading only)
```

- **The browser never talks to the database.** Every read and write goes through the Express API, which uses Supabase's `service_role` key. Supabase Auth issues the login tokens; the API checks each one and loads the user's role from the database on every request, so a suspended account is locked out at once.
- **Tokens.** The access token is kept in memory in the browser (not `localStorage`). The refresh token is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/auth`.
- **Multi-step writes run inside Postgres.** Creating a bill, approving a return, receiving a purchase, importing an invoice and deleting bills are each one database function (RPC) that locks the batch rows it touches. A sale that would take stock below zero fails in a trigger, and the whole bill rolls back.
- **Optional parts degrade instead of breaking.** If `GEMINI_API_KEY` is not set, the invoice endpoints answer `503` and the rest of the app works. If a later, optional migration hasn't been applied, the API detects that once at startup (`backend/src/config/capabilities.js`) and turns off only that feature.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 5, React Router 6, Tailwind CSS 3, Radix UI, Recharts, Vitest + Testing Library + axe |
| Backend | Node.js (CI runs 24; 22 also works), Express 4, express-validator, Helmet, express-rate-limit, Multer, Pino, ExcelJS, PDFKit, Jest + Supertest |
| Data | Supabase: PostgreSQL (views, triggers, RPCs, RLS), Supabase Auth, a private Storage bucket |
| AI | Google Gemini API, for reading supplier invoices only |
| Ops | nginx, PM2, Let's Encrypt, GitHub Actions, one EC2 host |

---

## Repository layout

```
.
├── backend/
│   ├── src/
│   │   ├── app.js              # Express app: security headers, CORS, rate limits, routes
│   │   ├── server.js           # Binds the port (app.js is imported directly by tests)
│   │   ├── config/             # env validation, Supabase clients, optional-migration probes
│   │   ├── middleware/         # authenticate/authorize, validation, request id, error handler
│   │   ├── modules/<name>/     # One folder per feature:
│   │   │                       #   *.routes.js      URL + validation + role guard
│   │   │                       #   *.controller.js  HTTP in/out
│   │   │                       #   *.service.js     business logic + DB queries
│   │   │                       #   *.sql            that module's schema
│   │   ├── db/                 # Cross-module migrations (schema-22, 27–39)
│   │   └── utils/              # AppError, audit log, row-access check, money, dates, PostgREST helpers
│   ├── tests/                  # Integration tests (need a real Supabase test project)
│   │   └── unit/               # Pure tests, no network or credentials
│   ├── tools/postman/          # Generates docs/api/PCare-Pharma.postman_collection.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx             # Routes; ProtectedRoute gates owner-only pages
│   │   ├── components/<area>/  # Pages and dialogs, one folder per feature
│   │   ├── ui/                 # Design-system primitives (Button, Dialog, Table, charts…)
│   │   ├── patterns/           # Page-level patterns (ResourcePage, FilterBar, FormDialog…)
│   │   ├── domain/             # Pharmacy-specific UI logic (stock, packs, invoices, charts)
│   │   ├── hooks/              # useAuth, useResource, useNotifications, …
│   │   └── lib/api.js          # The one HTTP client: token refresh, errors, downloads
│   └── public/theme-init.js    # Theme bootstrap (an external file so the CSP needs no inline script)
├── docs/                       # Module designs, migration order, deploy reviews, API collection
├── nginx.conf.template         # Production nginx site (TLS, CSP, rate limits, SPA)
├── ecosystem.config.js         # PM2 process definition
├── run-demo.sh                 # Start backend + frontend locally
└── .github/workflows/deploy.yml
```

---

## Getting started (local)

### Prerequisites

- Node.js 22 or newer, with npm
- A Supabase project (free tier is fine) for real data
- Optional: a Google Gemini API key, for invoice reading

### Quick UI-only demo

```bash
./run-demo.sh
```

This installs dependencies, writes a **dummy** `backend/.env` if none exists, and starts both servers. The UI loads, but with dummy keys you can't log in or see data.

### Full setup

```bash
# 1. Backend
cd backend
cp .env.example .env        # fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY
                            # and set NODE_ENV=development, FRONTEND_URL=http://localhost:3000
npm install
npm run dev                 # API on http://localhost:4000 (nodemon)

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                 # SPA on http://localhost:3000, /api proxied to :4000
```

Then:

1. Apply the database migrations (next section).
2. In Supabase → Authentication → Users, create the owner account, then insert a matching row in `public.users` with `role = 'owner'`. The owner creates staff accounts from the **Staff** page.
3. Log in at <http://localhost:3000>.

Health checks: `GET /health` (process is up) and `GET /ready` (database is reachable).

---

## Database setup

The schema is plain SQL, run by hand in the **Supabase SQL editor**. There is no migration runner.

**The order matters. Follow [`docs/MIGRATION-ORDER.md`](docs/MIGRATION-ORDER.md) exactly.** It lists every file, what each one creates, and what depends on what. In short:

1. Module schemas: `auth` → `users` → `categories` → `medicines` → `inventory` → `suppliers` → `customers` → `settings` → `chronic-care`
2. `db/schema-22-atomic-workflows.sql`. **Required:** billing, receiving and returns call these functions.
3. Supplier-invoice schemas (23, 24, 25), attendance (26), loose units (27)
4. Security: `schema-28-security-hardening.sql`, then `schema-29-rls-lockdown.sql`, which removes every table grant from the public Supabase keys
5. Stock requests (30), live-drift fixes (31), then 32 → 35, notifications (36), invoice tax detail (37), bill deletion (38) and `schema-39-go-live-hardening.sql` last

Some features check for their columns once at startup. **Restart the API after applying a migration.**

---

## Configuration

All configuration is in `backend/.env`. [`backend/.env.example`](backend/.env.example) documents every variable. The API checks these at startup and refuses to boot if a required one is missing. In production it also refuses an `http://` or `localhost` `FRONTEND_URL`.

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | `service_role` key. **Server only.** Bypasses RLS. |
| `SUPABASE_ANON_KEY` | ✅ | Used for Supabase Auth calls (login, refresh, password reset) |
| `FRONTEND_URL` | ✅ | Exact public origin. Used for CORS and password-reset links. |
| `NODE_ENV` | ✅ | `production` hides stack traces and marks the cookie `Secure` |
| `PORT` | | Default `4000` |
| `LOG_LEVEL` | | `debug` / `info` / `warn` / `error` |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, … | | Invoice reading. Leave the key unset to turn the feature off. |
| `INVOICE_*` | | Upload size, uploads per hour per user, concurrent reads, preview-link lifetime |
| `TEST_OWNER_*`, `TEST_STAFF_*` | | Credentials for the integration tests. **Never set these in production.** |

The frontend needs no `.env` by default: it calls `/api` on its own origin. `VITE_API_URL` can point it at another host.

---

## Testing

```bash
# Backend: unit tests (no network, no credentials). This is what CI runs.
cd backend
npx jest tests/unit tests/supplier-invoice-routes.test.js tests/supplier-invoice-extraction.test.js --runInBand

# Backend: full suite. Needs a NON-production Supabase project with seeded
# owner/staff users and TEST_* credentials in .env.
npm test

# Frontend: lint + tests + production build. This is what CI runs.
cd frontend
npm run check
```

The frontend tests include automated accessibility checks (axe) on the UI components.

---

## API

- REST over JSON, all under `/api/v1/<module>`. Logged-in requests send `Authorization: Bearer <access_token>`.
- Success: `{ "success": true, "data": …, "message": … }`. Error: `{ "error": "CODE", "message": "…", "details"?: … }`.
- Lists are paged with `?page=&limit=` (at most 100 per page).
- **Postman collection:** [`docs/api/`](docs/api/README.md) has over 100 requests, generated from the live Express router. Regenerate it with `cd backend && npm run postman`; `npm run postman:check` fails if it is stale.
- A route map and production checklist are in [`docs/API-ROUTE-MAP-AND-PRODUCTION-CHECKLIST.md`](docs/API-ROUTE-MAP-AND-PRODUCTION-CHECKLIST.md).

---

## Deployment

Production runs on one EC2 host: **nginx** serves the built SPA and proxies `/api/*` to the API, and **PM2** runs the API (`ecosystem.config.js`).

**Automatic deploys** ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)): on every push to `main`:

1. Backend unit tests and frontend `npm run check` run in parallel.
2. If both pass, the workflow SSHs into the host as `pcare`. That key can run only `/srv/pcare/deploy.sh` (a forced command), and the host key is pinned.
3. It confirms the site is up with `GET https://pcare-pharma.com/ready`.

The workflow runs only for `main`. Pull requests are not tested by CI, so run the checks above locally before merging.

**First-time server setup:** see the header of [`nginx.conf.template`](nginx.conf.template) (certificate issuance) and [`docs/PRODUCTION-DEPLOYMENT-REVIEW.md`](docs/PRODUCTION-DEPLOYMENT-REVIEW.md).

**Single-service alternative:** if `frontend/dist` exists, the Express app serves the SPA itself from the same origin (e.g. one Render web service). Helmet's CSP in `app.js` mirrors nginx's for this case.

---

## Security model

- **Two layers of authorisation.** `authorize('owner')` on a route decides who may call it. `assertCanAccess()` (`utils/authz.js`) decides whether a staff member may see a particular bill, return or request. `created_by` always comes from the verified token, never from the request body.
- **Locked-down database.** RLS is on for every table. `schema-29` removes all table grants from the public `anon`/`authenticated` roles, and `schema-39` removes their right to run functions, so the public Supabase key can't read or write data even if it leaks.
- **Brute-force limits.** 5 failed logins per account (per account + IP) per 15 minutes, counted in Postgres so the limit holds across restarts, plus a per-network backstop and nginx's own limit.
- **Headers.** HSTS, a strict CSP with no inline script, `X-Frame-Options: DENY`, `nosniff`, and a restrictive Permissions-Policy.
- **Uploads.** File type and size are checked before the file is held in memory, uploads are capped per user per hour, one invoice is read at a time, and originals are stored in a **private** bucket that is shown only through short-lived signed URLs.
- **Safe search.** User search text is escaped before it is put into a PostgREST filter (`utils/postgrest.js`).
- **Audit.** Logins, failed logins, user changes, settings changes, approvals, write-offs and bill deletions are written to `audit_logs`.

To report a vulnerability, contact the repository owner privately; please don't open a public issue.

---

## Rules for contributors

These rules hold up the rest of the design. Breaking one usually breaks stock or money figures without any visible error.

- **Stock is never stored.** It is `SUM(inventory_ledger.change_qty)` (plus the loose-unit ledger). Never update a stock number; add a ledger row.
- **The ledger is append-only.** A trigger blocks `UPDATE`/`DELETE` on it.
- **FEFO always.** Sales take the batch that expires first.
- **Bills are immutable.** Corrections go through customer returns. The only exception is the owner's audited bill deletion (`schema-38`), and that never touches stock.
- **No hard deletes** of catalogue, people or partners. Deactivate and reactivate instead.
- **`created_by` comes from the JWT**, never from the request.
- **Staff never see purchase cost** unless a documented exception says so.
- **Doctor relationships are for visibility only**, with no commission logic (Indian law).
- **Selling price may not exceed MRP.**
- **A new database function must `revoke … from public, anon, authenticated`** and grant to `service_role` only (see `schema-39`).
- **A new endpoint needs a `routes-meta.js` entry**, or `npm run postman:check` fails.

---

## Further documentation

| Document | What it covers |
|---|---|
| [`docs/MIGRATION-ORDER.md`](docs/MIGRATION-ORDER.md) | Database setup, step by step (the source of truth) |
| [`docs/MODULE-*.md`](docs/) | Functional design of individual modules |
| [`docs/UI-GUIDELINES-IMPLEMENTATION.md`](docs/UI-GUIDELINES-IMPLEMENTATION.md) | UI rules and acceptance criteria (including A9, staff cost visibility) |
| [`docs/API-ROUTE-MAP-AND-PRODUCTION-CHECKLIST.md`](docs/API-ROUTE-MAP-AND-PRODUCTION-CHECKLIST.md) | Every route plus a go-live checklist |
| [`docs/PRODUCTION-DEPLOYMENT-REVIEW.md`](docs/PRODUCTION-DEPLOYMENT-REVIEW.md) | Production deployment review |
| [`docs/api/README.md`](docs/api/README.md) | Using and regenerating the Postman collection |
| [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | Historical release-status snapshot (July 2026; predates modules 22+) |
