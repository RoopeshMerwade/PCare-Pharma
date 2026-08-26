# P.Care Pharma — Complete API Route Map
## Version 1.0 — 20 Modules

All routes prefixed with /api/v1

### MODULE 01 — AUTH
POST   /auth/login               Public
POST   /auth/logout              Auth
POST   /auth/refresh             Public
POST   /auth/forgot-password     Public
POST   /auth/reset-password      Public
GET    /auth/me                  Auth

### MODULE 02 — USERS
GET    /users                    Owner
GET    /users/me                 Auth
GET    /users/:id                Owner
POST   /users                    Owner
PATCH  /users/:id                Auth (owner: any; staff: self only)
PATCH  /users/:id/activate       Owner
PATCH  /users/:id/deactivate     Owner
POST   /users/:id/reset-password Owner

### MODULE 03 — CATEGORIES
GET    /categories               Auth
GET    /categories/:id           Auth
POST   /categories               Owner
PATCH  /categories/reorder       Owner
PATCH  /categories/:id           Owner
PATCH  /categories/:id/deactivate Owner
PATCH  /categories/:id/reactivate Owner

### MODULE 04 — MEDICINES
GET    /medicines                Auth
GET    /medicines/search         Auth
GET    /medicines/alerts/low-stock  Owner
GET    /medicines/alerts/near-expiry Owner
GET    /medicines/:id            Auth
POST   /medicines                Owner
PATCH  /medicines/:id            Owner
PATCH  /medicines/:id/deactivate Owner
PATCH  /medicines/:id/reactivate Owner

### MODULE 05 — INVENTORY
GET    /inventory                Auth
GET    /inventory/:medicineId/batches Auth
GET    /inventory/:medicineId/available-batches Auth (Billing FEFO)
GET    /inventory/batch/:batchId Auth
GET    /inventory/expired        Owner
GET    /inventory/movements      Owner
POST   /inventory/batches        Auth (staff + owner)
POST   /inventory/adjust         Owner
PATCH  /inventory/batch/:batchId/writeoff Owner

### MODULE 06 — SUPPLIERS
GET    /suppliers                Auth
GET    /suppliers/:id            Auth
POST   /suppliers                Owner
PATCH  /suppliers/:id            Owner
PATCH  /suppliers/:id/deactivate Owner
PATCH  /suppliers/:id/reactivate Owner

### MODULES 07+08 — PURCHASES
GET    /purchases                Owner
GET    /purchases/:id            Owner
POST   /purchases                Owner
PATCH  /purchases/:id            Owner
PATCH  /purchases/:id/send       Owner
PATCH  /purchases/:id/cancel     Owner
POST   /purchases/:id/receive    Owner
POST   /purchases/:id/items      Owner
DELETE /purchases/:id/items/:itemId Owner

### MODULES 09+10 — BILLING
GET    /billing/totals           Owner
GET    /billing                  Auth (owner: all; staff: own)
GET    /billing/:id              Auth
POST   /billing                  Auth (creates bill)

### MODULE 11 — CUSTOMERS
GET    /customers/search         Auth
GET    /customers                Auth
GET    /customers/:id            Auth
GET    /customers/:id/history    Auth
POST   /customers                Auth
PATCH  /customers/:id            Owner
PATCH  /customers/:id/deactivate Owner
PATCH  /customers/:id/reactivate Owner

### MODULE 12 — CUSTOMER RETURNS
GET    /customer-returns         Auth (owner: all; staff: own)
GET    /customer-returns/:id     Auth
POST   /customer-returns         Auth
PATCH  /customer-returns/:id/approve Owner
PATCH  /customer-returns/:id/reject  Owner

### MODULE 13 — SUPPLIER RETURNS
GET    /supplier-returns         Owner
GET    /supplier-returns/:id     Owner
POST   /supplier-returns         Owner
PATCH  /supplier-returns/:id/send        Owner
PATCH  /supplier-returns/:id/acknowledge Owner

### MODULE 14 — EXPIRY
GET    /expiry/dashboard         Owner
GET    /expiry/report            Owner
GET    /expiry/urgency/:urgency  Owner
PATCH  /expiry/batch/:id/writeoff Owner
POST   /expiry/bulk-writeoff     Owner

### MODULE 15 — REPORTS
GET    /reports/sales            Owner
GET    /reports/margins          Owner
GET    /reports/purchases        Owner
GET    /reports/inventory        Owner
GET    /reports/top-medicines    Owner

### MODULE 16 — NOTIFICATIONS
GET    /notifications            Auth
GET    /notifications/count      Auth
PATCH  /notifications/read-all   Auth
PATCH  /notifications/:id/read   Auth

### MODULES 17+18 — DASHBOARD
GET    /dashboard/owner          Owner
GET    /dashboard/staff          Auth

### MODULE 19 — SETTINGS
GET    /settings                 Auth
PATCH  /settings                 Owner

### MODULE 20 — AUDIT LOGS
GET    /audit-logs               Owner

---
# PRODUCTION CHECKLIST — v1.0

## Pre-deployment (must complete)
☐ Supabase project created; all 20 schema files run in order
☐ .env populated with real keys (JWT_SECRET 64+ chars random)
☐ SEED_ON_START=false
☐ test_credentials.md deleted
☐ npm install in /backend
☐ npm run build in /frontend → /frontend/dist exists
☐ PM2 started: pm2 start ecosystem.config.js --env production
☐ Nginx config enabled; certbot SSL issued
☐ /health returns { status: ok }
☐ Login with owner account works
☐ Login with staff account returns 403 on /dashboard/owner

## Go-live (owner does this)
☐ Change all PINs/passwords from test values
☐ Update Settings → pharmacy name, address, license no, GST
☐ Enter opening stock via inventory batches
☐ Create real staff accounts; delete test accounts
☐ Create a test bill and verify inventory decrements
☐ Print QR code for counter

## Security (verified before real patient data)
☐ Rate limiting confirmed: 6th login attempt returns 429
☐ HTTPS enforced: http:// redirects to https://
☐ DB port NOT accessible from public internet
☐ Logs do not contain passwords/tokens/patient medical details
☐ Staff cannot access /api/v1/dashboard/owner (403 confirmed)
☐ Supabase RLS enabled on all tables (verify in Supabase UI)

## Monitoring (ongoing)
☐ Daily mongodump cron active (or Supabase PITR enabled)
☐ /health checked weekly
☐ Audit logs reviewed monthly
☐ Backup restore drill run quarterly
