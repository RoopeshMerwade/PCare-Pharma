# MODULE 03 — MEDICINE CATEGORIES
## P.Care Pharma Management System v1.0
---

## 1. FUNCTIONAL DESIGN

### Purpose
Medicine Categories organise the catalog into named groups used as:
- Filter chips in Owner Inventory and Staff selling tab
- Required field when adding a new medicine
- Grouping in reports and margin analytics

### Business Rules
- Owner can create, edit, reorder, and deactivate categories
- Staff can only VIEW categories (needed to dispense)
- A category CANNOT be deleted if it has medicines linked to it
  → Soft-deactivate only; deactivated categories hide from pickers but
    preserve historical data and existing medicines
- Category names must be unique (case-insensitive)
- Maximum 30 active categories (practical UX limit for filter chips)
- Sort order is owner-controlled (drag-to-reorder in UI, PATCH /reorder)
- Each category optionally carries a color hex for badge rendering
  → If no color chosen, a deterministic color is derived from the name
- 10 seed categories ship with every fresh installation

### Seed Categories (in sort order)
1. Diabetes             #3B82F6
2. BP & Cardiac         #EF4444
3. Antibiotics          #10B981
4. General & OTC        #6B7280
5. Vitamins & Supplements #F59E0B
6. Pediatrics           #8B5CF6
7. Ointments & Creams   #EC4899
8. Syrups               #14B8A6
9. Surgical & IV        #F97316
10. Sanitary            #06B6D4

### Permissions Matrix
| Action              | Owner | Staff |
|---------------------|-------|-------|
| List categories     | ✅    | ✅    |
| Create category     | ✅    | ❌    |
| Edit category       | ✅    | ❌    |
| Reorder             | ✅    | ❌    |
| Deactivate          | ✅    | ❌    |
| Hard delete         | ❌    | ❌    |
