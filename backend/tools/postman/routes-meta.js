// â”€â”€ Postman collection metadata.
//
// The generator discovers routes by walking the live Express router, so a new
// endpoint shows up in the collection the moment it is mounted. What it CANNOT
// discover is human intent: a description, a realistic example body, sensible
// query values. That is what this file supplies.
//
// Keys are `METHOD /express/path` exactly as registered (params keep their
// `:name` form). Anything missing from here is still exported â€” flagged with a
// TODO description â€” so the collection is never silently incomplete.
//
// Fields:
//   name        request label in Postman (defaults to METHOD + path)
//   description shown in Postman's docs pane
//   auth        'public' for endpoints that need no bearer token
//   role        'owner' | 'staff' â€” documented, and drives the [owner] suffix
//   body        example JSON request body
//   query       example query params â€” { key: value } or { key: [value, 'desc'] }
//   pathVars    maps an express param to a collection variable name
//   capture     { var, path } â€” test script saves a value from the response
//                for later requests (path is dot-notation into the JSON body)

const OWNER = 'owner';
const STAFF = 'staff';

module.exports = {

  // â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /health': {
    name: 'Liveness probe',
    auth: 'public',
    description: 'Process is up. Used by nginx and uptime monitoring. Never touches the database.',
  },
  'GET /ready': {
    name: 'Readiness probe',
    auth: 'public',
    description: 'Dependencies reachable â€” runs a cheap `pharmacy_settings` count. Returns 503 `not_ready` if Supabase is unreachable. Use this in deploy gates, not `/health`.',
  },

  // â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'POST /api/v1/auth/login': {
    name: 'Login',
    auth: 'public',
    description:
      'Returns the access token in the JSON body and sets the refresh token in an httpOnly `pcare_refresh` cookie (path `/api/v1/auth`, sameSite strict).\n\n' +
      'The test script saves `access_token` to a collection variable, so every other request in this collection authenticates automatically. **Run this first.**\n\n' +
      'Rate limited to 5 attempts / 15 min per IP.',
    body: { email: '{{owner_email}}', password: '{{owner_password}}' },
    capture: { var: 'access_token', path: 'data.session.access_token' },
  },
  'POST /api/v1/auth/refresh': {
    name: 'Refresh access token',
    auth: 'public',
    description:
      'Reads the `pcare_refresh` cookie â€” no request body. Supabase rotates the refresh token on every use, so the response also sets a **new** cookie; the old one is dead immediately.\n\n' +
      'The frontend calls this automatically on `401 TOKEN_INVALID` via a single-flight promise in `frontend/src/lib/api.js`. You rarely need to call it by hand.\n\n' +
      '**The response includes `user_id` â€” whose token this is.** The refresh cookie is scoped to the origin, not to a browser tab, so a machine where two people have signed in has exactly one, and a tab refreshing against it can be handed a token belonging to the other person. The client compares `user_id` against the identity that tab believes it is and locks the tab on a mismatch, rather than adopting the token silently and recording the next sale under the wrong name.',
    capture: { var: 'access_token', path: 'data.access_token' },
  },
  'POST /api/v1/auth/forgot-password': {
    name: 'Request password reset',
    auth: 'public',
    description: 'Always returns 200 with the same message whether or not the email exists â€” deliberate, so the endpoint cannot be used to enumerate accounts.',
    body: { email: '{{owner_email}}' },
  },
  'POST /api/v1/auth/reset-password': {
    name: 'Reset password with token',
    auth: 'public',
    description:
      '`token` is the `token_hash` from the reset email link. The service verifies it as a recovery OTP to establish a session, then sets the new password.\n\n' +
      'Password must be â‰¥ 8 chars with at least one uppercase letter and one number.',
    body: { token: 'PASTE_TOKEN_HASH_FROM_EMAIL', new_password: 'NewPassw0rd' },
  },
  'GET /api/v1/auth/me': {
    name: 'Current session user',
    description: 'Re-reads the profile from the database on every call, so a mid-session suspension takes effect immediately.',
  },
  'POST /api/v1/auth/logout': {
    name: 'Logout',
    description: 'Revokes the Supabase session and clears the `pcare_refresh` cookie.',
  },

  // â”€â”€ Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/users': {
    name: 'List staff', role: OWNER,
    description: 'All user accounts with their active status.',
  },
  'GET /api/v1/users/me': {
    name: 'My profile',
    description: 'Any authenticated role. Registered before `/:id` so it is not swallowed by the UUID param route.',
  },
  'GET /api/v1/users/:id': {
    name: 'Get user', role: OWNER,
    description: 'Full profile including active status and role.',
    pathVars: { id: 'user_id' },
  },
  'POST /api/v1/users': {
    name: 'Create staff account', role: OWNER,
    description:
      'Creates the Supabase auth user and the profile row, then emails a password-setup link. No password is ever accepted here.\n\n' +
      'A duplicate email returns `409 EMAIL_EXISTS`. Staff headcount is capped by the `enforce_staff_limit` trigger.',
    body: { full_name: 'Anita Rao', email: 'anita.rao@example.com', phone: '9876543210' },
    capture: { var: 'user_id', path: 'data.user.id' },
  },
  'PATCH /api/v1/users/:id': {
    name: 'Update profile',
    description: 'Owner, or a staff member updating themselves. `role` and `email` are rejected here by design â€” sending either returns 422.',
    pathVars: { id: 'user_id' },
    body: { full_name: 'Anita Rao', phone: '9876543210' },
  },
  'PATCH /api/v1/users/:id/activate': {
    name: 'Activate user', role: OWNER,
    description: 'Restores a deactivated account. The user can sign in again immediately.', pathVars: { id: 'user_id' },
  },
  'PATCH /api/v1/users/:id/deactivate': {
    name: 'Deactivate user', role: OWNER,
    description: 'Soft-disable â€” the account is never deleted. `authenticate` re-reads the profile per request, so an active session dies on the next call.',
    pathVars: { id: 'user_id' },
  },
  'POST /api/v1/users/:id/reset-password': {
    name: 'Send password reset email', role: OWNER,
    description: 'Owner-triggered reset for a staff member. Sends the email; the owner never sets or sees the password.',
    pathVars: { id: 'user_id' },
  },

  // â”€â”€ Categories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/categories': {
    name: 'List categories',
    description: 'Staff see active only. Owners can pass `includeInactive=true`.',
    query: { includeInactive: ['false', 'owner only; true also returns deactivated categories'] },
  },
  'GET /api/v1/categories/:id': { name: 'Get category', pathVars: { id: 'category_id' } },
  'POST /api/v1/categories': {
    name: 'Create category', role: OWNER,
    description: '`color` is a hex code used for the category chip in the UI.',
    body: { name: 'Antibiotics', description: 'Systemic antibacterials', color: '#3B82F6' },
    capture: { var: 'category_id', path: 'data.category.id' },
  },
  'PATCH /api/v1/categories/reorder': {
    name: 'Reorder categories', role: OWNER,
    description: 'Send every category id in the desired display order. Registered before `/:id` so `reorder` is not parsed as a UUID.',
    body: { orderedIds: ['{{category_id}}'] },
  },
  'PATCH /api/v1/categories/:id': {
    name: 'Update category', role: OWNER,
    description: 'Send only the fields you are changing.',
    pathVars: { id: 'category_id' },
    body: { name: 'Antibiotics', color: '#2563EB' },
  },
  'PATCH /api/v1/categories/:id/deactivate': { name: 'Deactivate category', role: OWNER, pathVars: { id: 'category_id' } },
  'PATCH /api/v1/categories/:id/reactivate': { name: 'Reactivate category', role: OWNER, pathVars: { id: 'category_id' } },

  // â”€â”€ Medicines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/medicines/search': {
    name: 'Search medicines (typeahead)',
    description: 'Matches name, generic name and manufacturer. Search text is sanitised before it reaches the PostgREST `or()` filter.',
    query: { q: 'para' },
  },
  'GET /api/v1/medicines/alerts/low-stock': {
    name: 'Low stock alerts', role: OWNER,
    description: 'Medicines whose live ledger stock is at or below their `low_stock_threshold`.',
  },
  'GET /api/v1/medicines/alerts/near-expiry': {
    name: 'Near-expiry alerts', role: OWNER,
    description: 'Batches approaching expiry while still holding sellable stock.',
  },
  'GET /api/v1/medicines': {
    name: 'List medicines',
    description: 'Stock quantities come from the `medicines_with_stock` view â€” summed live from the ledger, never a stored column.',
    query: {
      page: 1, limit: 30,
      categoryId: ['', 'UUID; optional filter'],
      stock: ['', 'low | out | ok'],
      search: ['', 'free text'],
    },
  },
  'GET /api/v1/medicines/:id': { name: 'Get medicine', pathVars: { id: 'medicine_id' } },
  'GET /api/v1/medicines/:id/alternatives': {
    name: 'Generic alternatives',
    description:
      'Other active medicines sharing this one\'s generic molecule, best-stocked first (max 10) â€” what to offer when the brand asked for is out of stock.\n\n' +
      'A medicine with no `generic_name` returns an empty list rather than guessing from the brand name. Stock figures come from `medicines_with_stock`, so they are summed live from the ledger.',
    pathVars: { id: 'medicine_id' },
  },
  'POST /api/v1/medicines': {
    name: 'Create medicine', role: OWNER,
    description:
      'Catalog entry only â€” it holds no stock. Stock arrives via Inventory â†’ Add batch, or Purchases â†’ Receive.\n\n' +
      '`unit` is the denomination stock is COUNTED in (strips, bottles, tubes). `pack_content_quantity` / `pack_content_unit` describe what is INSIDE one of those â€” `10` + `TABLET` for a strip of ten. Both optional, and only meaningful as a pair: sending one without the other stores neither, because a countable pack of unknown size is exactly what would let a strip be split into an invented number of tablets.\n\n' +
      'Recording countable contents (TABLET, CAPSULE, PIECE) is what enables single-unit sales for this medicine. It never multiplies stock â€” a receipt of 5 strips of 10 is 5 in the ledger, not 50.',
    body: {
      name: 'Paracetamol 500mg', generic_name: 'Paracetamol', manufacturer: 'Cipla',
      category_id: '{{category_id}}', unit: 'tablet', default_selling_price: 2.5,
      low_stock_threshold: 100, hsn_code: '30049099', description: 'Antipyretic / analgesic',
      pack_content_quantity: 10, pack_content_unit: 'TABLET',
    },
    capture: { var: 'medicine_id', path: 'data.medicine.id' },
  },
  'PATCH /api/v1/medicines/:id': {
    name: 'Update medicine', role: OWNER,
    description: 'Sending `is_active` is rejected â€” use the deactivate/reactivate endpoints.',
    pathVars: { id: 'medicine_id' },
    body: { default_selling_price: 2.75, low_stock_threshold: 150 },
  },
  'PATCH /api/v1/medicines/:id/deactivate': { name: 'Deactivate medicine', role: OWNER, pathVars: { id: 'medicine_id' } },
  'PATCH /api/v1/medicines/:id/reactivate': { name: 'Reactivate medicine', role: OWNER, pathVars: { id: 'medicine_id' } },

  // â”€â”€ Inventory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/inventory': {
    name: 'Inventory overview',
    description: 'Per-medicine stock position across all batches, with live totals summed from the ledger.',
    query: { page: 1, limit: 30, search: ['', 'free text'] },
  },
  'GET /api/v1/inventory/:medicineId/batches': {
    name: 'All batches for a medicine',
    description: 'Every batch including expired and zero-stock ones â€” the full history, not just what is sellable.',
    pathVars: { medicineId: 'medicine_id' },
  },
  'GET /api/v1/inventory/:medicineId/available-batches': {
    name: 'Sellable batches (FEFO order)',
    description: 'In-stock, unexpired batches, nearest expiry first â€” the same ordering billing consumes. Read-only view of what a sale would pick.',
    pathVars: { medicineId: 'medicine_id' },
  },
  'GET /api/v1/inventory/batch/:batchId': { name: 'Get batch', pathVars: { batchId: 'batch_id' } },
  'POST /api/v1/inventory/batches': {
    name: 'Add batch (opening stock)',
    description:
      'Both roles â€” staff do the unboxing. Creates the batch and its opening ledger entry.\n\n' +
      '`opening_qty` is written as a ledger row, not a stored quantity: stock is always `SUM(inventory_ledger.change_qty)`.\n\n' +
      'For goods against a purchase order use `POST /purchases/:id/receive` instead.\n\n' +
      '`content_quantity` / `content_unit` describe what is inside ONE unit of this batch, and are only needed when it differs from the medicine\'s own `pack_content_*` â€” a run of 15s under a product catalogued as 10s. They are informational for every module except loose sales, which divide by them; they never multiply `opening_qty`.',
    body: {
      medicine_id: '{{medicine_id}}', batch_no: 'BATCH-001', exp_date: '2027-06-30',
      mfg_date: '2025-06-01', unit_cost: 1.2, mrp: 3, selling_price: 2.5,
      opening_qty: 500, reason: 'opening_stock',
      content_quantity: 10, content_unit: 'TABLET',
    },
    capture: { var: 'batch_id', path: 'data.batch.id' },
  },
  'GET /api/v1/inventory/expired': {
    name: 'Expired batches still holding stock', role: OWNER,
    description: 'Past-expiry batches with stock that has not been written off yet â€” the clean-up worklist.',
  },
  'GET /api/v1/inventory/movements': {
    name: 'Ledger movements', role: OWNER,
    description: 'The append-only audit trail: every stock change ever made, newest first. Nothing here is ever updated or deleted â€” `block_ledger_mutation` enforces that in Postgres.',
    query: {
      batchId: ['', 'UUID'], medicineId: ['', 'UUID'],
      reason: ['', 'purchase_receipt | opening_stock | sale | return_inward | return_outward | adjustment | expiry_writeoff | strip_opened'],
      page: 1, limit: 50,
    },
  },
  'POST /api/v1/inventory/adjust': {
    name: 'Manual stock adjustment', role: OWNER,
    description:
      'Posts a correcting ledger row (positive or negative) â€” it never edits history. A note of 5â€“500 chars is mandatory and is audit-logged.\n\n' +
      'Driving stock below zero is refused by the `prevent_negative_stock` trigger with `409 INSUFFICIENT_STOCK`.\n\n' +
      '`denomination` selects which pool to correct: `sealed` (the default, and what every request meant before Module 27) writes to `inventory_ledger` in whole packs; `loose` writes to `loose_unit_ledger` in single units, for recounting an opened pack. A batch with no recorded pack contents refuses a loose adjustment with `422 NOT_SPLITTABLE` rather than assuming a pack size.',
    body: { batch_id: '{{batch_id}}', adjustment_qty: -5, note: 'Damaged in transit â€” 5 strips discarded', denomination: 'sealed' },
  },
  'PATCH /api/v1/inventory/batch/:batchId/writeoff': {
    name: 'Write off a batch', role: OWNER,
    description: 'Zeroes the batch by posting a negative ledger entry for its full remaining stock.',
    pathVars: { batchId: 'batch_id' },
  },

  // â”€â”€ Suppliers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/suppliers': {
    name: 'List suppliers',
    description: 'Outstanding balances are merged in from the `supplier_balances` view â€” computed live, never stored.',
    query: { includeInactive: ['false', 'owner only'] },
  },
  'GET /api/v1/suppliers/:id': { name: 'Get supplier', pathVars: { id: 'supplier_id' } },
  'POST /api/v1/suppliers': {
    name: 'Create supplier', role: OWNER,
    description: '`credit_terms_days` drives the payment-due calculation on purchase orders.',
    body: {
      name: 'MedPlus Distributors', phone: '9876543210', email: 'orders@medplus.example',
      gst_no: '29ABCDE1234F1Z5', credit_terms_days: 30,
      address: '14 Industrial Estate, Bengaluru', contact_person: 'R. Kumar',
    },
    capture: { var: 'supplier_id', path: 'data.supplier.id' },
  },
  'PATCH /api/v1/suppliers/:id': {
    name: 'Update supplier', role: OWNER,
    description: 'Send only the fields you are changing.',
    pathVars: { id: 'supplier_id' },
    body: { credit_terms_days: 45, contact_person: 'R. Kumar' },
  },
  'PATCH /api/v1/suppliers/:id/deactivate': { name: 'Deactivate supplier', role: OWNER, pathVars: { id: 'supplier_id' } },
  'PATCH /api/v1/suppliers/:id/reactivate': { name: 'Reactivate supplier', role: OWNER, pathVars: { id: 'supplier_id' } },

  // â”€â”€ Purchases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/purchases': {
    name: 'List purchase orders', role: OWNER,
    description: 'Newest first, with supplier name and order totals.',
    query: { supplierId: ['', 'UUID'], status: ['', 'draft | sent | received | cancelled'], page: 1, limit: 30 },
  },
  'GET /api/v1/purchases/:id': {
    name: 'Get purchase order', role: OWNER,
    description: 'Includes line items. Grab an item `id` from here for the `receive` call.',
    pathVars: { id: 'purchase_id' },
  },
  'POST /api/v1/purchases': {
    name: 'Create purchase order', role: OWNER,
    description: 'Creates a **draft**. Nothing reaches inventory until the order is received.',
    body: {
      supplier_id: '{{supplier_id}}',
      expected_date: '2026-09-15',
      notes: 'Monthly restock',
      items: [{ medicine_id: '{{medicine_id}}', qty_ordered: 100, unit_cost: 1.2 }],
    },
    capture: { var: 'purchase_id', path: 'data.purchase.id' },
  },
  'PATCH /api/v1/purchases/:id': {
    name: 'Update draft purchase', role: OWNER,
    description: 'Header fields only, and only while the order is still a draft.',
    pathVars: { id: 'purchase_id' },
    body: { expected_date: '2026-09-20', notes: 'Delivery pushed a week' },
  },
  'PATCH /api/v1/purchases/:id/send': {
    name: 'Send order to supplier', role: OWNER,
    description: 'draft â†’ sent. Line items are frozen from this point.',
    pathVars: { id: 'purchase_id' },
  },
  'PATCH /api/v1/purchases/:id/cancel': {
    name: 'Cancel order', role: OWNER,
    description: 'Closes the order without receiving it. Inventory is untouched; a received order cannot be cancelled.',
    pathVars: { id: 'purchase_id' },
  },
  'POST /api/v1/purchases/:id/receive': {
    name: 'Receive goods â†’ stock', role: OWNER,
    description:
      'Runs `receive_purchase_atomic()` â€” **one database transaction**: locks the purchase, creates a batch per line, posts inward ledger entries, updates received quantities and sets status `received`. All of it commits or none of it does.\n\n' +
      '`purchase_item_id` values come from `GET /purchases/:id`.\n\n' +
      'âš ï¸ Requires migration `schema-22-atomic-workflows.sql`; without it this returns `500 MIGRATION_REQUIRED`.\n\n' +
      '**Not yet wired into the frontend** â€” this endpoint currently has no UI caller.',
    pathVars: { id: 'purchase_id' },
    body: {
      items: [{
        purchase_item_id: 'PASTE_FROM_GET_PURCHASE',
        batch_no: 'BATCH-002', qty_received: 100, exp_date: '2027-12-31',
        mrp: 3, selling_price: 2.5,
      }],
    },
  },
  'POST /api/v1/purchases/:id/items': {
    name: 'Add line item to draft', role: OWNER,
    description: '**Not yet wired into the frontend.**',
    pathVars: { id: 'purchase_id' },
    body: { medicine_id: '{{medicine_id}}', qty_ordered: 50, unit_cost: 1.15 },
  },
  'DELETE /api/v1/purchases/:id/items/:itemId': {
    name: 'Remove line item from draft', role: OWNER,
    description: 'The only DELETE verb in the API, and it only removes an unsent draft line â€” no business record is ever hard-deleted. **Not yet wired into the frontend.**',
    pathVars: { id: 'purchase_id', itemId: 'purchase_item_id' },
  },

  // â”€â”€ Billing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/billing/totals': {
    name: 'Sales totals', role: OWNER,
    description: 'Aggregate revenue for a date range. Computed live â€” no totals are stored.',
    query: { dateFrom: '2026-08-01', dateTo: '2026-08-31' },
  },
  'GET /api/v1/billing': {
    name: 'List bills',
    description: 'Owners see every bill; staff see only the bills they created.',
    query: {
      page: 1, limit: 30, search: ['', 'bill number or customer'],
      paymentMode: ['', 'cash | upi | credit | card'],
      dateFrom: ['', 'YYYY-MM-DD'], dateTo: ['', 'YYYY-MM-DD'],
    },
  },
  'GET /api/v1/billing/:id': { name: 'Get bill with items', pathVars: { id: 'bill_id' } },
  'POST /api/v1/billing': {
    name: 'Create bill (sale)',
    description:
      'The core transaction. Server-side, in order:\n\n' +
      '1. **Chronic adherence check.** If the customer has overdue refills, responds `409 ADHERENCE_ACK_REQUIRED` with the warnings. This *never* blocks the sale â€” resend the same body with those warnings echoed in `acknowledged_warnings` and it proceeds.\n' +
      '2. **Duplicate lines merged.** Two lines for the same medicine are summed before allocation, so a cart cannot oversell one batch.\n' +
      '3. **FEFO allocation.** Nearest-expiry batch first, spilling into the next as needed. Staff never pick a batch.\n' +
      '4. **`create_bill_atomic()`** â€” one transaction that locks the batches, writes the bill, its items and the negative ledger entries.\n\n' +
      'Prices are snapshotted per batch at sale time. **Bills are immutable** â€” there is no PATCH or DELETE; corrections go through Customer Returns.\n\n' +
      '**Two denominations per line (Module 27).** `qty` counts whole sealed packs â€” strips, bottles, tubes â€” and is the denomination `inventory_ledger` and `medicines.unit` have always used. `loose_qty` counts single units out of an opened pack and is optional; omitting it is exactly the request this endpoint took before, and behaves identically.\n\n' +
      'A line needs a quantity in at least one of the two, and `qty` may be `0` when `loose_qty` is not. Loose units are only accepted for a medicine whose pack contents are **countable** â€” `pack_content_unit` of TABLET, CAPSULE or PIECE. A 100ML bottle or a 30GM tube answers `422 LOOSE_SALE_UNSUPPORTED`, because one millilitre is not a thing anyone dispenses.\n\n' +
      'Loose allocation is FEFO too, and spends already-open packs before breaking a new one: for each batch in expiry order it takes what is loose, then opens `ceil(remaining / contents)` packs â€” the minimum, never one per unit. Opening posts `-1 strip_opened` to `inventory_ledger` and `+contents strip_opened` to `loose_unit_ledger`, so the two ledgers reconcile and nothing changes denomination silently. Insufficient loose stock answers `409 INSUFFICIENT_LOOSE_STOCK`.\n\n' +
      'âš ï¸ Requires migrations `schema-22-atomic-workflows.sql` and, for `loose_qty`, `schema-27-loose-units.sql`.',
    body: {
      customer_phone: '9876543210',
      payment_mode: 'cash',
      discount_amount: 0,
      items: [{ medicine_id: '{{medicine_id}}', qty: 2, loose_qty: 3 }],
      acknowledged_warnings: [],
    },
    capture: { var: 'bill_id', path: 'data.bill.id' },
  },

  // â”€â”€ Customers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/customers/search': {
    name: 'Search customers (typeahead)',
    description: 'Top 10 matches on name, phone or email â€” for the customer picker on the billing screen.',
    query: { q: '98765' },
  },
  'GET /api/v1/customers': {
    name: 'List customers',
    description: 'Reads `customers_with_stats` â€” visit counts and spend are computed live from bills.',
    query: { page: 1, limit: 50, search: ['', 'name, phone or email'], includeInactive: ['false', 'owner only'] },
  },
  'GET /api/v1/customers/:id': { name: 'Get customer', pathVars: { id: 'customer_id' } },
  'GET /api/v1/customers/:id/history': {
    name: 'Purchase history',
    description: 'Bills are linked by phone number, so a customer recorded without a phone returns an empty page rather than an error.',
    pathVars: { id: 'customer_id' },
    query: { page: 1, limit: 20 },
  },
  'POST /api/v1/customers': {
    name: 'Register customer',
    description: 'Phone is optional but strongly recommended: it is the key that links bills to this customer, and it cannot be changed later. A duplicate phone returns `409 DUPLICATE_PHONE`.',
    body: {
      name: 'Ramesh Iyer', phone: '9876543210', email: 'ramesh@example.com',
      date_of_birth: '1975-04-12', address: '22 MG Road, Bengaluru', notes: '',
    },
    capture: { var: 'customer_id', path: 'data.customer.id' },
  },
  'PATCH /api/v1/customers/:id': {
    name: 'Update customer', role: OWNER,
    description: '`phone` is immutable after creation â€” it is the join key for bill history. Sending it returns `422 PHONE_IMMUTABLE`.',
    pathVars: { id: 'customer_id' },
    body: { name: 'Ramesh Iyer', email: 'ramesh.iyer@example.com' },
  },
  'PATCH /api/v1/customers/:id/deactivate': { name: 'Deactivate customer', role: OWNER, pathVars: { id: 'customer_id' } },
  'PATCH /api/v1/customers/:id/reactivate': { name: 'Reactivate customer', role: OWNER, pathVars: { id: 'customer_id' } },

  // â”€â”€ Customer Returns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/customer-returns': {
    name: 'List customer returns',
    description: 'Owners see all; staff see only their own submissions.',
    query: { status: ['', 'pending | approved | rejected'], page: 1, limit: 30 },
  },
  'GET /api/v1/customer-returns/:id': { name: 'Get return', pathVars: { id: 'customer_return_id' } },
  'POST /api/v1/customer-returns': {
    name: 'Submit return request',
    description:
      'The **only** way to correct a bill, since bills are immutable. Creates a `pending` request â€” no stock or money moves yet.\n\n' +
      'Quantities are checked cumulatively against every prior approved *and* pending return for the same bill line, so the same strip cannot be returned twice across separate requests.\n\n' +
      '`bill_item_id` values come from `GET /billing/:id`.',
    body: {
      bill_id: '{{bill_id}}',
      reason: 'Customer reported an adverse reaction',
      refund_mode: 'cash',
      items: [{ bill_item_id: 'PASTE_FROM_GET_BILL', qty_returned: 1 }],
    },
    capture: { var: 'customer_return_id', path: 'data.return.id' },
  },
  'PATCH /api/v1/customer-returns/:id/approve': {
    name: 'Approve return', role: OWNER,
    description:
      'Runs `approve_customer_return_atomic()`: claims the pending row with a conditional UPDATE (so two simultaneous approvals cannot both succeed â€” the loser gets `409 INVALID_STATUS`), locks the batches, posts the inward ledger entries and computes the refund. One transaction.\n\n' +
      'âš ï¸ Requires migration `schema-22-atomic-workflows.sql`.',
    pathVars: { id: 'customer_return_id' },
  },
  'PATCH /api/v1/customer-returns/:id/reject': {
    name: 'Reject return', role: OWNER,
    description: 'No stock or refund movement. The request row is kept for the audit trail.',
    pathVars: { id: 'customer_return_id' },
    body: { rejection_note: 'Outside the 7-day return window' },
  },

  // â”€â”€ Supplier Returns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/supplier-returns': {
    name: 'List supplier returns', role: OWNER,
    description: 'Newest first.',
    query: { supplierId: ['', 'UUID'], status: ['', 'draft | sent | acknowledged'], page: 1, limit: 30 },
  },
  'GET /api/v1/supplier-returns/:id': { name: 'Get supplier return', role: OWNER, pathVars: { id: 'supplier_return_id' } },
  'POST /api/v1/supplier-returns': {
    name: 'Draft supplier return', role: OWNER,
    description: 'Creates a draft. Stock stays put until the return is sent.',
    body: {
      supplier_id: '{{supplier_id}}',
      reason: 'Damaged packaging on receipt',
      items: [{ batch_id: '{{batch_id}}', qty_returned: 10 }],
    },
    capture: { var: 'supplier_return_id', path: 'data.return.id' },
  },
  'PATCH /api/v1/supplier-returns/:id/send': {
    name: 'Send return â†’ stock out', role: OWNER,
    description:
      'Runs `send_supplier_return_atomic()`: claims the draft with a conditional UPDATE, locks the batches, posts the outward ledger entries and records the debit note amount â€” in one transaction.\n\n' +
      'âš ï¸ Requires migration `schema-22-atomic-workflows.sql`.',
    pathVars: { id: 'supplier_return_id' },
  },
  'PATCH /api/v1/supplier-returns/:id/acknowledge': {
    name: 'Mark acknowledged by supplier', role: OWNER,
    description: 'Status only â€” stock already moved when the return was sent.',
    pathVars: { id: 'supplier_return_id' },
  },

  // â”€â”€ Expiry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/expiry/dashboard': {
    name: 'Expiry dashboard', role: OWNER,
    description: 'Counts and stock value bucketed by urgency.',
  },
  'GET /api/v1/expiry/report': {
    name: 'Full expiry report', role: OWNER,
    description: 'Every batch with stock, its days-to-expiry and the value at risk. The exportable view behind the dashboard.',
  },
  'GET /api/v1/expiry/urgency/:urgency': {
    name: 'Batches by urgency', role: OWNER,
    description: 'Path value must be one of `expired`, `critical`, `warning`, `watch`.',
    pathVars: { urgency: 'expiry_urgency' },
  },
  'PATCH /api/v1/expiry/batch/:batchId/writeoff': {
    name: 'Write off one expired batch', role: OWNER,
    description: 'Same effect as the inventory write-off, reached from the expiry workflow. Posts a negative ledger entry for the full remaining stock.',
    pathVars: { batchId: 'batch_id' },
  },
  'POST /api/v1/expiry/bulk-writeoff': {
    name: 'Write off all expired batches', role: OWNER,
    description: 'Sweeps every expired batch still holding stock. Note: each write-off is its own transaction, not one batch-wide transaction â€” a mid-run failure leaves earlier write-offs committed (they are valid on their own).',
  },

  // â”€â”€ Reports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/reports/sales': {
    name: 'Sales report', role: OWNER,
    description: 'Revenue over time. Omit the dates for the default window.',
    query: { dateFrom: '2026-08-01', dateTo: '2026-08-31', groupBy: ['day', 'day | week | month'] },
  },
  'GET /api/v1/reports/margins': {
    name: 'Margin report', role: OWNER,
    description: 'Reads the `margin_analytics` view â€” margins are computed live from cost and sale price, never stored.',
    query: { categoryId: ['', 'UUID'], limit: 50 },
  },
  'GET /api/v1/reports/purchases': {
    name: 'Purchase report', role: OWNER,
    description: 'Spend by supplier over a date range.',
    query: { supplierId: ['', 'UUID'], dateFrom: '2026-08-01', dateTo: '2026-08-31' },
  },
  'GET /api/v1/reports/inventory': {
    name: 'Inventory valuation', role: OWNER,
    description: 'Stock on hand valued at cost and at selling price, with the spread between them.',
  },
  'GET /api/v1/reports/top-medicines': {
    name: 'Top-selling medicines', role: OWNER,
    description: '**Not yet surfaced in the frontend.**',
    query: { dateFrom: '2026-08-01', dateTo: '2026-08-31', limit: 10 },
  },

  // â”€â”€ Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/notifications': {
    name: 'List notifications',
    description: 'Alerts for the signed-in user, newest first.',
    query: { unreadOnly: ['false', 'true returns unread only'] },
  },
  'GET /api/v1/notifications/count': {
    name: 'Unread count',
    description: '**Not yet surfaced in the frontend** â€” the header bell has no unread badge wired to this.',
  },
  'PATCH /api/v1/notifications/read-all': {
    name: 'Mark all read',
    description: 'Clears the unread state for every notification belonging to the signed-in user.',
  },
  'PATCH /api/v1/notifications/:id/read': {
    name: 'Mark one read',
    description: 'Marks a single notification read. Only affects notifications owned by the caller.',
    pathVars: { id: 'notification_id' },
  },

  // â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/dashboard/owner': {
    name: 'Owner dashboard', role: OWNER,
    description: 'Revenue, margins, alerts and supplier dues.',
  },
  'GET /api/v1/dashboard/staff': {
    name: 'Staff dashboard', role: STAFF,
    description: "Both roles may call this â€” it is the counter view: today's sales, low stock, expiring soon.",
  },

  // â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/settings': {
    name: 'Get all settings',
    description: 'Returns a flat keyâ†’value object plus the raw rows.',
  },
  'PATCH /api/v1/settings': {
    name: 'Update settings', role: OWNER,
    description: 'Send only the keys you are changing. Any key outside the allow-list returns `422 INVALID_KEYS`.',
    body: {
      pharmacy_name: 'P.Care Pharmacy',
      pharmacy_address: '12 MG Road, Bengaluru 560001',
      drug_license_no: 'KA-B-123456',
      gst_no: '29ABCDE1234F1Z5',
      currency_symbol: 'â‚¹',
      default_low_stock_threshold: '100',
      default_credit_terms_days: '30',
    },
  },

  // â”€â”€ Audit Logs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/audit-logs': {
    name: 'List audit logs', role: OWNER,
    description: 'Every privileged action, newest first. The response also carries `action_types` for a filter dropdown.',
    query: {
      action: ['', 'e.g. bill_created, stock_adjusted, login_failed'],
      userId: ['', 'UUID'], dateFrom: ['', 'YYYY-MM-DD'], dateTo: ['', 'YYYY-MM-DD'],
      page: 1, limit: 50,
    },
  },

  // â”€â”€ Chronic Care â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/chronic-care/condition-options': {
    name: 'Condition options',
    description: 'The fixed seeded condition list for dropdowns. Creating new conditions is not exposed through the API.',
  },
  'GET /api/v1/chronic-care/overdue': {
    name: 'Overdue refills',
    description: 'Drives the adherence follow-up queue.',
    query: { limit: 20 },
  },
  'GET /api/v1/chronic-care/customers/:customerId/conditions': {
    name: 'Conditions for a customer',
    description: 'Active chronic conditions on record for this patient.',
    pathVars: { customerId: 'customer_id' },
  },
  'POST /api/v1/chronic-care/customers/conditions': {
    name: 'Record a patient condition',
    description: 'Both roles may write here by product decision; every write is audit-logged, which is the control that matters more than role-gating.',
    body: {
      customer_id: '{{customer_id}}', condition_id: '{{condition_id}}',
      diagnosed_date: '2024-01-15', prescribing_doctor: 'Dr. S. Menon', notes: '',
    },
    capture: { var: 'patient_condition_id', path: 'data.condition.id' },
  },
  'PATCH /api/v1/chronic-care/conditions/:id/deactivate': {
    name: 'Deactivate condition record',
    description: 'Soft-removes the condition from the patient. The record is retained.',
    pathVars: { id: 'patient_condition_id' },
  },
  'GET /api/v1/chronic-care/customers/:customerId/schedules': {
    name: 'Medication schedules for a customer',
    description: 'Refill schedules with their derived adherence status from the `medication_schedule_status` view.',
    pathVars: { customerId: 'customer_id' },
  },
  'POST /api/v1/chronic-care/schedules': {
    name: 'Create medication schedule',
    description: 'Sets the refill cadence that adherence status is derived from. Grace days widen the on-time window either side of the due date.',
    body: {
      customer_id: '{{customer_id}}', medicine_id: '{{medicine_id}}',
      condition_id: '{{condition_id}}',
      refill_cycle_days: 30, early_grace_days: 3, late_grace_days: 5,
    },
    capture: { var: 'schedule_id', path: 'data.schedule.id' },
  },
  'PATCH /api/v1/chronic-care/schedules/:id': {
    name: 'Update schedule',
    description: 'Adjust cadence or grace windows. Adherence status recomputes from the new values.',
    pathVars: { id: 'schedule_id' },
    body: { refill_cycle_days: 28, late_grace_days: 7 },
  },
  'PATCH /api/v1/chronic-care/schedules/:id/deactivate': {
    name: 'Deactivate schedule',
    description: 'Stops adherence tracking for this medicine. Past history is retained.',
    pathVars: { id: 'schedule_id' },
  },

  // â”€â”€ Module 23: Supplier invoice ingestion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/supplier-invoices': {
    name: 'List supplier invoices',
    description:
      'Staged and imported distributor invoices, newest first. Counts (`line_count`, `unmapped_count`, `blocking_error_count`) are computed by the `supplier_invoices_with_counts` view â€” nothing tallied is stored.\n\n' +
      'Both roles: staff run the goods-inward desk.',
    query: { status: ['NEEDS_REVIEW', 'NEEDS_REVIEW | IMPORTED | REJECTED'], page: 1, limit: 30 },
  },
  'GET /api/v1/supplier-invoices/match/medicines': {
    name: 'Trigram catalogue match',
    description:
      'Ranked catalogue candidates for a printed line description, via `match_medicines_trgm()` (pg_trgm). Powers the review screen\'s medicine picker.\n\n' +
      'Registered BEFORE `/:id` â€” otherwise "match" would be parsed as an invoice id.',
    query: { q: ['paracetamol 500', 'the printed product description'] },
  },
  'GET /api/v1/supplier-invoices/:id': {
    name: 'Get invoice + lines',
    description: 'The staged header with every line, its catalogue match, its `warnings` array and the model\'s `raw_extraction` for audit.',
    pathVars: { id: 'supplier_invoice_id' },
  },
  'GET /api/v1/supplier-invoices/:id/document': {
    name: 'Signed document URL',
    description:
      'A short-lived signed URL for the original PDF/photo. The `supplier-invoices` bucket is private and stays private â€” there is no public path to a distributor\'s invoice.\n\n' +
      'TTL comes from `INVOICE_SIGNED_URL_TTL` (default 900s).',
    pathVars: { id: 'supplier_invoice_id' },
  },
  'POST /api/v1/supplier-invoices': {
    name: 'Upload + read invoice',
    description:
      '**multipart/form-data, not JSON.** Field `file` â€” PDF, JPG, PNG or WebP, up to `INVOICE_MAX_UPLOAD_MB` (default 12MB). Optional field `supplier_id` when the uploader already knows the distributor; it overrides whatever the model reads off the letterhead.\n\n' +
      'Synchronous, and slow by design: the buffer goes to private storage, then to Gemini with a strict `responseSchema`, then into the staging tables as `NEEDS_REVIEW`. Expect 5â€“60s depending on page count.\n\n' +
      'Postman: use the Body â†’ form-data tab. There is no JSON equivalent.\n\n' +
      'âš ï¸ Requires `GEMINI_API_KEY` (503 `EXTRACTION_UNAVAILABLE` without it) and migration `schema-23-supplier-invoices.sql`.',
    capture: { var: 'supplier_invoice_id', path: 'data.invoice.id' },
  },
  'PATCH /api/v1/supplier-invoices/:id': {
    name: 'Correct invoice header',
    description:
      'Header corrections during review. `status` is deliberately rejected here â€” it moves only through `/approve` and `/reject`, which carry the role guard and the audit entry.\n\n' +
      'Every save re-runs the deterministic rules and returns the recomputed `validation_warnings` and `can_import`.',
    pathVars: { id: 'supplier_invoice_id' },
    body: { supplier_id: '{{supplier_id}}', invoice_no: 'INV/2026/8841', invoice_date: '2026-08-12', supplier_dl_no: 'KA-GD/1208-1/28965', taxable_total: 10000, gst_total: 1200, net_total: 11200 },
  },
  'PATCH /api/v1/supplier-invoices/:id/items/:itemId': {
    name: 'Correct invoice line',
    description:
      'Line corrections during review. Setting `medicine_id` marks the match `manual`, which clears `LOW_MATCH_CONFIDENCE` â€” confirmation is tracked here, not trusted from the client.\n\n' +
      '**Units â€” the rule this module most needs you to get right.** `qty_billed`/`qty_free` count SALEABLE units (strips, bottles, tubes, inhalers) and that IS the stock quantity: **stock taken in = qty_billed + qty_free**. The Pack column describes what is *inside* one of those units and never multiplies anything.\n\n' +
      '`"100\'S"` qty 5 is **5 strips at the printed rate each**, not 500 tablets. Verified on all 18 legible lines of two real MEDICO invoices: `qty_billed Ã— printed_rate = line_total`, every time.\n\n' +
      '**Printed vs derived.** `printed_rate`/`printed_mrp` are the figures exactly as printed, per saleable unit. `unit_cost` is `printed_rate` net of `discount_pct`; `mrp` is `printed_mrp` unchanged. `pack_raw` is parsed into the read-only `sale_unit`, `content_quantity`, `content_unit` and `sub_pack_*` fields â€” informational, shown to the reviewer, never multiplied into stock or money.\n\n' +
      'Patching `printed_rate`, `printed_mrp`, `discount_pct` or `pack_raw` recomputes the derived fields. Sending `unit_cost`, `mrp` or `selling_price` explicitly in the same request suppresses that â€” a typed value always wins.\n\n' +
      '`is_excluded: true` drops a line from the import (freight, samples) along with its warnings.',
    pathVars: { id: 'supplier_invoice_id', itemId: 'supplier_invoice_item_id' },
    body: { batch_no: 'PC-9912', exp_date: '2028-04-30', qty_billed: 5, qty_free: 0, pack_raw: "100'S", printed_rate: 103.12, printed_mrp: 150, discount_pct: 3, gst_pct: 12 },
  },
  'POST /api/v1/supplier-invoices/:id/items/:itemId/medicine': {
    name: 'Quick add to catalogue + link', role: OWNER,
    description:
      'Creates a medicine and links this line to it in one round trip, so a reviewer never ends up with a new catalogue entry and a line still pointing at nothing. Same validation as `POST /medicines`.\n\n' +
      'Owner-only: catalogue writes are owner-only everywhere else and this is not the place to make an exception. Staff leave the line unmapped for the owner to resolve at approval.',
    pathVars: { id: 'supplier_invoice_id', itemId: 'supplier_invoice_item_id' },
    body: { name: 'Paracip 500mg', generic_name: 'Paracetamol', manufacturer: 'Cipla', category_id: '{{category_id}}', unit: 'strips', default_selling_price: 11 },
  },
  'POST /api/v1/supplier-invoices/:id/approve': {
    name: 'Approve & commit â†’ stock', role: OWNER,
    description:
      'Runs `commit_supplier_invoice()` â€” **one database transaction**: creates a `received` purchase record, one `inventory_batches` row per line, the matching positive `inventory_ledger` entries (reason `purchase_receipt`), the `purchase_items` rows, and flips the invoice to `IMPORTED`. All of it commits or none of it does.\n\n' +
      'Validation is re-run first and a blocking error returns `422 VALIDATION_BLOCKED` with `details.issues` â€” every code anchored to its field and line. The RPC re-checks the same rules independently; the database is the final authority.\n\n' +
      'Owner-only: approval is the write that creates stock.\n\n' +
      'âš ï¸ Requires migration `schema-23-supplier-invoices.sql`.',
    pathVars: { id: 'supplier_invoice_id' },
  },
  'POST /api/v1/supplier-invoices/:id/reject': {
    name: 'Reject invoice',
    description:
      'Marks the document `REJECTED` with a reason. Nothing is deleted â€” the original, the model\'s raw output and the reason all stay on record, and a rejected invoice number stops blocking the correct version of the same invoice.',
    pathVars: { id: 'supplier_invoice_id' },
    body: { reason: 'Wrong document â€” this is the delivery challan, not the tax invoice.' },
  },

  // â”€â”€ Attendance (Module 26) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/attendance/today': {
    name: "Today's attendance board",
    description:
      'Every **active staff** account with today\'s record, plus a `summary` of present / checked out / absent counts.\n\n' +
      'A staff member who has not arrived has no row in `staff_attendance` at all â€” the `today_staff_attendance` view left-joins them in as `absent`, which is why the board can show the people it most needs to show.\n\n' +
      '**Role-scoped payload, not just role-scoped rendering.** The owner gets the whole board; staff get their own row and nothing else, filtered server-side (criterion A9).\n\n' +
      '"Today" is `pharmacy_today()` â€” the IST calendar date, not the UTC one the sales figures slice by. Attendance is keyed by date, so an early-morning check-in must not land on yesterday\'s row.',
  },
  'GET /api/v1/attendance/history': {
    name: 'Attendance history',
    description:
      'Paginated past records, newest first. `worked_minutes` is derived on read from the two timestamps â€” nothing about duration is stored.\n\n' +
      'The owner may pass any `userId`; a staff member asking for someone else\'s history gets `403 FORBIDDEN` rather than having the filter silently rewritten to their own.\n\n' +
      'Omit `userId` as the owner to get every staff member\'s records interleaved.',
    query: {
      userId:   ['{{user_id}}', 'omit for all staff (owner only)'],
      dateFrom: ['', 'YYYY-MM-DD'],
      dateTo:   ['', 'YYYY-MM-DD'],
      page:     1,
      limit:    50,
    },
  },
  'POST /api/v1/attendance/check-in': {
    name: 'Check in',
    description:
      'Records an arrival. **Omit `user_id` to check yourself in** â€” that is the counter-staff path. Passing another `user_id` is the owner\'s administrative override and returns `403 FORBIDDEN` for staff.\n\n' +
      'One row per person per day (unique on `user_id, attendance_date`), so a second check-in while still present is `409 ALREADY_CHECKED_IN`; two racing requests collide on the constraint and the loser gets the same answer.\n\n' +
      '**Coming back after checking out reopens the same row** rather than creating a second one: `check_out_time` clears and `status` returns to `present`. `check_in_time` is deliberately *not* rewritten â€” the board\'s job is to say when someone arrived â€” and the superseded checkout is kept in the audit entry.\n\n' +
      'The target must be an active user with role `staff`: `409 ACCOUNT_INACTIVE` or `422 NOT_STAFF` otherwise. Writes an `audit_logs` entry (`staff_check_in`) and a `STAFF_CHECK_IN` notification to the owner.',
    body: { user_id: '', notes: '' },
  },
  'POST /api/v1/attendance/check-out': {
    name: 'Check out',
    description:
      'Closes today\'s shift. Same permission rule as check-in: omit `user_id` for yourself, pass one only as the owner.\n\n' +
      '`409 NOT_CHECKED_IN` if there is no record for today, `409 ALREADY_CHECKED_OUT` if the shift is already closed. Writes an `audit_logs` entry (`staff_check_out`) and a `STAFF_CHECK_OUT` notification to the owner.',
    body: { user_id: '', notes: '' },
  },

  // â”€â”€ Stock Requisitions (Module 30) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'GET /api/v1/stock-requisitions': {
    name: 'List stock requests',
    description:
      'Paginated, newest first.\n\n' +
      '**Role-scoped payload, not just role-scoped rendering.** The owner sees every request; a staff member sees only the ones they raised, filtered server-side (criterion A9).\n\n' +
      '`estimated_total` is `SUM(qty Ã— unit_cost)` computed by the view â€” at the rates we last paid, not at MRP. `unpriced_item_count` is how many lines have no rate on record, so the owner knows a request has gaps before opening it.',
    query: {
      status:  ['', 'pending | approved | rejected | cancelled'],
      urgency: ['', 'normal | urgent'],
      page:    1,
      limit:   20,
    },
  },
  'GET /api/v1/stock-requisitions/vendor-prices': {
    name: 'Vendor prices for medicines',
    description:
      '**The criterion-A9 exception, and the only one in this module.** This is the one endpoint where Staff see what a distributor charges â€” you cannot pick the cheapest of three vendors without seeing three prices. It is a purpose-built endpoint over a purpose-built six-column view, *not* a relaxation of `/purchases`, `/purchase-items` or `/suppliers`, which stay owner-only and unchanged.\n\n' +
      'Returns an object keyed by medicine id. Per medicine: distributors we have bought that medicine from, **cheapest first** (the client pre-selects the first), then every other active distributor with `last_unit_cost: null`. A medicine never bought before is present with the roster rather than absent â€” the caller has to tell "no rate on record" apart from "not fetched yet".\n\n' +
      'Prices come from `medicine_vendor_prices`, which unions received purchase items with batches that record their supplier. Nothing maintains it, so `last_purchased_on` travels with every rate: the age of the number arrives with the number.\n\n' +
      'Batched deliberately â€” one request for a whole dialog, not one per line. Registered **before** `/:id`, or the literal path would bind to the id param and answer `422` about a malformed UUID.',
    query: { medicine_ids: ['{{medicine_id}}', 'comma-separated, 1â€“50 UUIDs'] },
  },
  'GET /api/v1/stock-requisitions/low-stock': {
    name: 'Low-stock medicines to request',
    description:
      'What is below its reorder level right now, emptiest first â€” the picker behind "add from what\'s running low", so several medicines can be ticked at once instead of searched for one at a time.\n\n' +
      'A separate endpoint from `/medicines/alerts/low-stock` on purpose: that one is `authorize(\'owner\')`, so the people who actually notice the shelf is empty cannot call it. This returns six columns and no cost, margin or vendor data.',
    query: { limit: 100 },
  },
  'GET /api/v1/stock-requisitions/:id': {
    name: 'Get stock request',
    description:
      'One request with its lines, each carrying the distributor, the rate snapshotted when it was raised, the MRP, how old that rate is, and a `line_total` derived on read.\n\n' +
      'A staff member asking for a colleague\'s request gets `403 FORBIDDEN` rather than the record â€” the list is scoped by `created_by`, so the only way to reach someone else\'s row is to ask for it by id, which is exactly what an IDOR is.\n\n' +
      '`supplier_phone` appears for the owner only, and is not even selected for a staff request.',
    pathVars: { id: 'requisition_id' },
  },
  'POST /api/v1/stock-requisitions': {
    name: 'Raise a stock request',
    description:
      'Both roles. Send **what you want and who from** â€” nothing else.\n\n' +
      '**The client never sends prices or a distributor name.** `unit_cost`, `mrp`, `price_as_of` and `supplier_name` are read from the database server-side and any values posted are dropped: the credibility of the exported order rests on the figures being ones this pharmacy actually paid, and a rate posted from a browser is a rate anybody can choose.\n\n' +
      'Those four are then **snapshotted onto the line**. That looks like a violation of "nothing stored that can be computed" and is not: they answer "what did the owner approve", a past-tense fact, exactly as `bill_items.unit_price` does. Without them, re-downloading an approved order after a price change would silently print different money under the same approval.\n\n' +
      '`supplier_id: null` is a legitimate line, not an omission â€” "we need this and I don\'t know who from" is worth telling the owner. Such lines land in the export\'s trailing "Vendor not specified" section.\n\n' +
      'Notifies the owner (`STOCK_REQUISITION_RAISED`) and writes an `audit_logs` entry. Max 50 lines; the same medicine twice is `422 DUPLICATE_MEDICINE`.',
    body: {
      urgency: 'urgent',
      note: 'Two customers turned away today.',
      items: [
        { medicine_id: '{{medicine_id}}', qty: 20, supplier_id: '{{supplier_id}}' },
        { medicine_id: '{{medicine_id}}', qty: 5, supplier_id: null, note: 'Nobody obvious to order this from.' },
      ],
    },
    capture: { var: 'requisition_id', path: 'data.requisition.id' },
  },
  'PATCH /api/v1/stock-requisitions/:id/approve': {
    name: 'Approve stock request',
    description:
      'Owner only. Marks the request approved and **unlocks the download â€” and does nothing else.**\n\n' +
      'No purchase order is created, no batch, no ledger row. The owner places the order from the exported document, and the goods come in through the receiving path like every other delivery. That absence is the design: a status meaning "ordered" would promise a purchase order nothing could verify.\n\n' +
      'Only a `pending` request can be approved (`409 INVALID_STATUS`). Notifies the raiser (`STOCK_REQUISITION_APPROVED`).',
    pathVars: { id: 'requisition_id' },
  },
  'PATCH /api/v1/stock-requisitions/:id/reject': {
    name: 'Reject stock request',
    description:
      'Owner only. **The reason is required** (5â€“500 characters) â€” a rejection with no reason is useless to the person who raised it, because they cannot fix what they were not told about. It is sent to them with the notification.',
    pathVars: { id: 'requisition_id' },
    body: { rejection_note: 'We already have three months of this on order.' },
  },
  'PATCH /api/v1/stock-requisitions/:id/cancel': {
    name: 'Withdraw stock request',
    description:
      'The **raiser** withdraws their own request â€” they found the stock at the back.\n\n' +
      'Deliberately not owner-reachable: an owner cancelling somebody\'s request is a rejection wearing the wrong word, and a cancellation arrives with nothing the staff member can act on. Anyone else gets `403` naming the alternative. Only a `pending` request can be withdrawn.',
    pathVars: { id: 'requisition_id' },
  },
  'GET /api/v1/stock-requisitions/:id/export/:format': {
    name: 'Download stock request (xlsx / pdf)',
    description:
      'Owner only. Streams a real `.xlsx` or `.pdf` with `Content-Disposition: attachment`, named after the requisition (`REQ-2026-0007.xlsx`) so two downloads of one document are not two documents.\n\n' +
      '`409 NOT_APPROVED` for anything but an approved request â€” that is what makes "Approved" mean something.\n\n' +
      'One file per request, **split by vendor inside it**: a Summary sheet/page, then one complete printable order per distributor, then any unpriced lines last. The owner orders per distributor, so the document has to be splittable, but they asked for one download.\n\n' +
      'Seven columns: Medicine, Qty, Vendor, **Rate**, MRP, Date, Total. Total is `qty Ã— rate`, never `qty Ã— MRP` â€” the order is placed at the distributor\'s rate and MRP is the sanity check beside it. XLSX money cells are numbers with a format, not strings, so the sheet can be summed and pivoted.\n\n' +
      'Everything that can fail is resolved before the first byte: past the `Content-Disposition` header an error can no longer be a JSON 500, only a truncated file the spreadsheet blames on the user. Writes a `stock_requisition_exported` audit entry â€” the moment a priced vendor list leaves the system.',
    pathVars: { id: 'requisition_id', format: 'format' },
  },
};
