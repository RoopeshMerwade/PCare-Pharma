# MODULES 11–14 — FUNCTIONAL DESIGN
## P.Care Pharma Management System v1.0
---

## MODULE 11 — CUSTOMERS

### Purpose
The customer registry links purchase history, loyalty, and family records
to a phone number. Not every buyer needs a record — walk-in guests are
already handled in Billing with no customer row. This module manages
REGISTERED customers who want history tracking and (future) loyalty points.

### Business Rules
- Owner and staff can create/search/view customers
- Owner only can edit or deactivate; staff is read-only after creation
- Phone number is the primary identifier — must be unique
- A customer can be linked retroactively to guest bills (by owner)
- Customer purchase history is read from bills table — never duplicated
- Deactivate, never delete — bills reference customer records
- No self-registration: staff creates the account at first visit

### Permissions
| Action                | Owner | Staff |
|-----------------------|-------|-------|
| Search / List         | ✅    | ✅    |
| View profile + history| ✅    | ✅    |
| Create                | ✅    | ✅    |
| Edit                  | ✅    | ❌    |
| Deactivate            | ✅    | ❌    |
| Hard delete           | ❌    | ❌    |

---

## MODULE 12 — CUSTOMER RETURNS

### Purpose
A customer returns medicine that was billed — wrong item, damaged packaging,
overprescribed. The system must reverse the stock and optionally issue a
refund, while preserving the original bill as immutable.

### Business Rules
- Return must reference an original bill_item (or the bill's id)
- Maximum qty_returned ≤ qty originally sold on that bill line
- On approval: positive inventory_ledger entry (reason='return_inward')
  for the returned batch — stock goes back on the shelf
- Refund mode: cash / UPI / credit-note (deduct from next purchase)
- Staff can initiate; owner approves before stock and refund are posted
- Status: pending → approved (stock restored) | rejected (nothing changes)
- Once approved, no further changes — append-only principle

### Permissions
| Action                | Owner | Staff |
|-----------------------|-------|-------|
| List all returns      | ✅    | ❌    |
| List own returns      | ✅    | ✅    |
| Create return         | ✅    | ✅    |
| Approve / Reject      | ✅    | ❌    |

---

## MODULE 13 — SUPPLIER RETURNS

### Purpose
Returning stock to a supplier — damaged goods, expired pre-arrival, excess
stock after a cancelled order. Creates a debit note against the supplier's
outstanding balance.

### Business Rules
- Must reference a specific batch (the physical stock being returned)
- qty_returned ≤ current computed stock in that batch
- On confirmation: negative inventory_ledger row (reason='return_outward')
  and a negative billing_cycles entry (debit note against supplier)
- Status: draft → sent → acknowledged
- Owner only for all operations

### Permissions
| Action                | Owner | Staff |
|-----------------------|-------|-------|
| All operations        | ✅    | ❌    |

---

## MODULE 14 — EXPIRY MANAGEMENT

### Purpose
A dedicated view aggregating all expiry-related intelligence across the
inventory: expired batches with remaining stock, batches expiring within
30/60/90 days, and a workflow to write them off or return them to supplier.
Also surfaces potential losses in rupee value.

### Business Rules
- All data is computed from inventory_batches + ledger — nothing stored
- Write-off calls appendLedger (reason='expiry_writeoff') from Module 05
- Near-expiry is defined as exp_date ≤ today + 90 days with stock > 0
- Expired is exp_date < today with stock > 0 (physical stock still on shelf)
- Owner can initiate supplier return directly from this view
- Email/WhatsApp alert when batch enters near-expiry window = Phase 2
- Owner only

### Permissions
| Action                | Owner | Staff |
|-----------------------|-------|-------|
| View expiry dashboard | ✅    | ❌    |
| Write off batch       | ✅    | ❌    |
| Initiate return       | ✅    | ❌    |
