# MODULE 04 — MEDICINES
## P.Care Pharma Management System v1.0
---

## 1. FUNCTIONAL DESIGN

### Architecture Decision (Critical)
The medicines table is the MASTER CATALOG ONLY.
It holds identity and pricing defaults — NOT stock quantities.

Stock lives in Module 05 (inventory_batches + inventory_ledger).
This separation is non-negotiable:
  - Indian pharmacy law: price is per-batch (MRP printed on strip)
  - The append-only ledger must be the single source of stock truth
  - A medicine can have zero, one, or many active batches simultaneously

### Data Model: What a Medicine IS
- Brand name          ("Metformin 500mg Tablet")
- Generic / INN name  ("Metformin Hydrochloride")  ← search anchor
- Manufacturer        ("Sun Pharma")
- Category            (FK to Module 03)
- Unit                (strips / vials / bottles / tubes / packs / pcs)
- Default selling price  ← pre-fills PO form; actual MRP captured per batch
- Low-stock threshold    ← triggers alert when computed stock falls below
- HSN code               ← for GST invoicing (Phase 2)
- is_active              ← deactivate, never delete

### What a Medicine is NOT
- A stock record (that's inventory_batches)
- A price point (that's the batch's MRP — Indian law)
- A transaction record (that's billing / purchases)

### Business Rules
- Owner can create, edit, deactivate medicines
- Staff can only VIEW (needed to build a bill)
- Deactivated medicines: hidden from billing/PO pickers; history preserved
- No hard delete — ever. A medicine with any ledger history is immutable.
- Name + manufacturer must be unique together (prevents catalog duplicates)
- The "stock" shown in the UI is always computed:
    SUM(inventory_ledger.change_qty) per batch, summed across all batches
    for this medicine — NEVER stored on the medicine row itself
- Low-stock alert fires on Owner Home when computed_stock < low_stock_threshold
- Near-expiry alert fires when any batch exp_date < today + 90 days

### Permissions Matrix
| Action                    | Owner | Staff |
|---------------------------|-------|-------|
| List medicines            | ✅    | ✅    |
| Search (autocomplete)     | ✅    | ✅    |
| View medicine detail      | ✅    | ✅    |
| Create                    | ✅    | ❌    |
| Edit                      | ✅    | ❌    |
| Deactivate / Reactivate   | ✅    | ❌    |
| Hard delete               | ❌    | ❌    |

### Seed Medicines (13 — matching the Phase 1 prototype)
Paracetamol 650mg, Metformin 500mg, Glimepiride 1mg,
Amlodipine 5mg, Aspirin 75mg, Rosuvastatin 10mg,
Amoxicillin 500mg, Azithromycin 500mg,
Cetrizine 10mg, Pantoprazole 40mg,
Vitamin D3 60K, Calcium + D3,
Betadine Ointment 5%
