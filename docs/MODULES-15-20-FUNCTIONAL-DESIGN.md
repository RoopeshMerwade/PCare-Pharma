# MODULES 15–20 — FUNCTIONAL DESIGN
## P.Care Pharma Management System v1.0
---

## MODULE 15 — REPORTS
### Purpose
Business intelligence layer — all data computed live from existing tables.
No data duplication. No stored report rows. Owner-only.

### Report types
- Sales report: totals by day/week/month + per-payment-mode breakdown
- Margin analytics: (selling_price - unit_cost) / selling_price per medicine and per vendor
- Inventory snapshot: current stock, low stock, out-of-stock counts
- Purchase report: ordered vs received totals per supplier per period
- Expiry report: stock at risk by urgency bucket (delegates to Module 14)

### Permissions: Owner only for all

---

## MODULE 16 — NOTIFICATIONS
### Purpose
In-app alert system. Triggers: low stock, near expiry, pending returns,
new staff activity. No external channels (email/WhatsApp = Phase 3).

### Notification types
- LOW_STOCK, NEAR_EXPIRY, CUSTOMER_RETURN_PENDING,
  SUPPLIER_RETURN_PENDING, SYSTEM

### Permissions
| Action              | Owner | Staff |
|---------------------|-------|-------|
| View own            | ✅    | ✅    |
| Mark read           | ✅    | ✅    |
| View all users'     | ✅    | ❌    |
| Create (internal)   | System| System|

---

## MODULE 17 — OWNER DASHBOARD
### Purpose
First screen after owner login. All widgets are computed live. Fast.
Critical business at-a-glance: today's revenue, stock alerts,
pending approvals, top movers.

### Widgets
- Today's sales (total + breakdown by mode)
- This week / this month comparison
- Low stock count + list preview (top 5)
- Near expiry count (within 30d)
- Pending customer returns count
- Pending supplier returns count
- Top 5 medicines by qty sold this month
- Unread notifications count

### Permissions: Owner only

---

## MODULE 18 — STAFF DASHBOARD
### Purpose
Quick-access home for staff after login. Focused on today's counter work.
No financial totals (those are owner-only).

### Widgets
- Today's bills created by this staff member
- Quick-bill shortcut (tap → goes to billing)
- Low stock warning (medicines below threshold)
- Pending returns they submitted (own)
- Shift summary: bill count + item count (today, by this staff)

### Permissions: Staff (and owner can view a staff-mode summary)

---

## MODULE 19 — SETTINGS
### Purpose
Pharmacy profile configuration. Owner-managed. Persisted as key-value
rows in pharmacy_settings. Some settings affect system behavior
(low-stock threshold default, credit terms default, etc.).

### Setting keys
- pharmacy_name, pharmacy_address, drug_license_no, gst_no,
  owner_name, phone, email, city, state, pincode,
  default_low_stock_threshold, default_credit_terms_days,
  currency_symbol, financial_year_start

### Permissions: Owner only for write; both roles can read pharmacy name/address

---

## MODULE 20 — AUDIT LOGS UI + FINAL POLISH
### Purpose
Searchable, filterable UI over the audit_logs table (created in Module 01).
Also: server.js route map verification, production checklist, .gitignore,
PM2 ecosystem config, and Nginx config template.

### Audit log features
- Paginated list with filter by action, user, date range
- Human-readable action labels
- Expandable metadata JSON per entry

### Permissions: Owner only
