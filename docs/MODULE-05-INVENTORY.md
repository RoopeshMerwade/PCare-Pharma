# MODULE 05 — INVENTORY (BATCH-WISE)
## P.Care Pharma Management System v1.0
---

## 1. FUNCTIONAL DESIGN

### Core Architecture: Two-Table Append-Only Ledger

  inventory_batches  — one row per physical batch on the shelf
  inventory_ledger   — every stock movement, append-only, never updated

Stock quantity for any batch is ALWAYS:
  SELECT SUM(change_qty) FROM inventory_ledger WHERE batch_id = ?

This value is NEVER stored. Storing it would create two sources of truth.
The ledger IS the stock. The ledger IS the audit trail.

### Batch Lifecycle
  [Received via PO] → [Active on shelf] → [Partially sold] → [Depleted | Expired]

  - A batch enters via goods receipt (positive ledger row, reason='purchase_receipt')
  - Stock leaves via billing (negative ledger row, reason='sale')
  - Owner can adjust for physical count discrepancies (reason='adjustment')
  - Expired batches are written off (reason='expiry_writeoff')
  - Opening stock entries for go-live day (reason='opening_stock')

### FEFO — First Expiry, First Out
  When staff creates a bill, the system suggests the batch with the
  NEAREST expiry date that still has stock. Staff cannot choose a
  later-expiring batch if an earlier one has stock — this enforces
  Indian pharmacy dispensing standards and protects patients.

### Ledger Reasons (all legal values)
  purchase_receipt  — stock in from a PO goods receipt
  opening_stock     — go-live day initial stock entry
  sale              — stock out via a bill
  return_inward     — customer return adds stock back
  return_outward    — supplier return removes stock
  adjustment        — owner manual adjustment (requires note)
  expiry_writeoff   — expired batch written off

### Permissions Matrix
| Action                        | Owner | Staff |
|-------------------------------|-------|-------|
| View inventory / batches      | ✅    | ✅    |
| View ledger movements         | ✅    | ❌    |
| Receive stock (via PO)        | ✅    | ✅    | ← staff unbox deliveries
| Add opening stock             | ✅    | ❌    |
| Manual adjustment             | ✅    | ❌    |
| Expiry write-off              | ✅    | ❌    |
| View expired batches          | ✅    | ❌    |
| Hard delete any record        | ❌    | ❌    |

### FEFO Selling Rule (used by Billing module)
  GET /api/v1/inventory/:medicineId/available-batches
  Returns batches with stock > 0, ordered by exp_date ASC
  Billing module picks the first item off this list automatically
  and allows override only if the chosen batch also has stock.
