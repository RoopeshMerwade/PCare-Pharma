/**
 * MODULE 23 — route wiring, guards and validation (hermetic: auth + Supabase stubbed)
 * Runner: npx jest tests/supplier-invoice-routes.test.js --runInBand
 *
 * Needs backend/.env for config validation, but NO seeded users and no network:
 * `authenticate` is replaced with a stub that injects a role, and the Supabase
 * client is replaced with one that throws if a query is attempted. That last
 * part is the trick — a request that reaches the database means it got past the
 * guard that should have stopped it, so the stub turns "silently allowed" into
 * a loud failure.
 *
 * tests/supplier-invoices.test.js covers the same surface against a real
 * project; this suite is the one that runs in CI without secrets.
 */

// The role the stubbed `authenticate` injects, mutated per test. It must be
// named `mock*`: jest hoists the mock factory above this declaration, and the
// only out-of-scope variables it permits a factory to reference are ones with
// that prefix. Read lazily inside the middleware, so a per-test change lands.
const mockSession = { role: 'staff' };

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'u1', full_name: 'Test User', is_active: true, role: mockSession.role };
    next();
  },
  // Mirrors the real guard's contract exactly: 403 FORBIDDEN as an operational
  // AppError-shaped object, so errorHandler serialises it the same way.
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role)
      ? next()
      : next(Object.assign(new Error('You do not have permission to perform this action.'), {
        statusCode: 403, code: 'FORBIDDEN', isOperational: true,
      }))
  ),
}));

// Any query at all means a guard that should have stopped the request did not.
// Throwing here turns "silently allowed through" into a visible failure.
jest.mock('../src/config/supabase', () => ({
  supabase: {
    from: () => { throw new Error('unexpected db call — a guard let this through'); },
    rpc: async () => ({ data: [], error: null }),
    storage: { from: () => ({}) },
    auth: {},
  },
  createAuthClient: () => ({}),
}));

// This suite's whole point is running without credentials, so it cannot lean
// on backend/.env happening to have no Gemini key — a key added there for
// live testing must not flip the "unconfigured server" test into hitting the
// (stubbed, throwing) Supabase client instead. Set to '' rather than deleted:
// env.js calls dotenv.config(), which only fills in variables that are
// ABSENT — deleting it here would just have dotenv refill it from the real
// .env a line later. Empty-but-present skips that, and Boolean('') is false,
// so config.gemini.enabled comes out false either way.
process.env.GEMINI_API_KEY = '';

const request = require('supertest');
const app = require('../src/app');
const NIL = '00000000-0000-0000-0000-000000000000';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const asRole = (role) => { mockSession.role = role; };
beforeEach(() => asRole('staff'));

test('unsupported file type -> 422 UNSUPPORTED_FILE_TYPE', async () => {
  const r = await request(app).post('/api/v1/supplier-invoices').attach('file', Buffer.from('x'), { filename:'a.txt', contentType:'text/plain' });
  expect([r.status, r.body.error]).toEqual([422, 'UNSUPPORTED_FILE_TYPE']);
});
test('wrong field name -> 422 UNEXPECTED_FILE', async () => {
  const r = await request(app).post('/api/v1/supplier-invoices').attach('nope', PNG, { filename:'a.png', contentType:'image/png' });
  expect([r.status, r.body.error]).toEqual([422, 'UNEXPECTED_FILE']);
});
test('no file -> 422 NO_FILE', async () => {
  const r = await request(app).post('/api/v1/supplier-invoices').field('supplier_id','');
  expect([r.status, r.body.error]).toEqual([422, 'NO_FILE']);
});
test('valid png without GEMINI key -> 503 EXTRACTION_UNAVAILABLE', async () => {
  const r = await request(app).post('/api/v1/supplier-invoices').attach('file', PNG, { filename:'a.png', contentType:'image/png' });
  expect([r.status, r.body.error]).toEqual([503, 'EXTRACTION_UNAVAILABLE']);
});
test('oversize file -> 413 FILE_TOO_LARGE', async () => {
  const big = Buffer.alloc(13 * 1024 * 1024, 1);
  const r = await request(app).post('/api/v1/supplier-invoices').attach('file', big, { filename:'a.png', contentType:'image/png' });
  expect([r.status, r.body.error]).toEqual([413, 'FILE_TOO_LARGE']);
});
test('/match/medicines resolves before /:id', async () => {
  const r = await request(app).get('/api/v1/supplier-invoices/match/medicines?q=para');
  expect(r.status).toBe(200);
  expect(r.body.data).toEqual({ medicines: [] });
});
test('/match/medicines without q -> 422', async () => {
  const r = await request(app).get('/api/v1/supplier-invoices/match/medicines');
  expect(r.status).toBe(422);
});
test('bad uuid -> 422', async () => {
  const r = await request(app).get('/api/v1/supplier-invoices/nope');
  expect(r.status).toBe(422);
});
test('status in PATCH body -> 422', async () => {
  const r = await request(app).patch(`/api/v1/supplier-invoices/${NIL}`).send({ status: 'IMPORTED' });
  expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
});
test('bad date format -> 422', async () => {
  const r = await request(app).patch(`/api/v1/supplier-invoices/${NIL}`).send({ invoice_date: '12/08/2026' });
  expect(r.status).toBe(422);
});
test('discount over 100% -> 422; a real pack string passes validation', async () => {
  // A discount above 100 is a misread, not a deal. pack_raw is free text by
  // design — the parser decides what it means and flags what it cannot read,
  // rather than the route rejecting a pack shape nobody has seen yet.
  const bad = await request(app).patch(`/api/v1/supplier-invoices/${NIL}/items/${NIL}`).send({ discount_pct: 300 });
  expect(bad.status).toBe(422);
  const ok = await request(app).patch(`/api/v1/supplier-invoices/${NIL}/items/${NIL}`).send({ pack_raw: "100'S" });
  expect(ok.status).toBe(500); // reached the service, which hit the stubbed db
});
test('negative money -> 422', async () => {
  const r = await request(app).patch(`/api/v1/supplier-invoices/${NIL}/items/${NIL}`).send({ unit_cost: -1 });
  expect(r.status).toBe(422);
});
test('staff cannot approve, and cannot quick-add to the catalogue', async () => {
  asRole('staff');
  const a = await request(app).post(`/api/v1/supplier-invoices/${NIL}/approve`);
  expect([a.status, a.body.error]).toEqual([403, 'FORBIDDEN']);
  const m = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({ name: 'X', category_id: NIL, unit: 'strips', default_selling_price: 5 });
  expect(m.status).toBe(403);
});
test('staff CAN list, read and correct drafts — that is the whole point', async () => {
  asRole('staff');
  // Reaching the service (500 off the throwing db stub) proves the guard passed.
  // A 403 here would mean staff had been locked out of the goods-inward desk.
  for (const call of [
    request(app).get('/api/v1/supplier-invoices'),
    request(app).patch(`/api/v1/supplier-invoices/${NIL}`).send({ invoice_no: 'INV-1' }),
    request(app).patch(`/api/v1/supplier-invoices/${NIL}/items/${NIL}`).send({ batch_no: 'AB-1' }),
    request(app).post(`/api/v1/supplier-invoices/${NIL}/reject`).send({ reason: 'Wrong document' }),
  ]) {
    const r = await call;
    expect(r.status).not.toBe(403);
  }
});
test('owner passes the approve guard and reaches the service', async () => {
  asRole('owner');
  const r = await request(app).post(`/api/v1/supplier-invoices/${NIL}/approve`);
  expect(r.status).not.toBe(403);
  const m = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({ name: 'Paracip 500mg', category_id: NIL, unit: 'strips', default_selling_price: 11 });
  expect(m.status).not.toBe(403);
});
test('quick-add rejects a medicine the Medicines page could not have made', async () => {
  asRole('owner');
  // Same rules as POST /medicines: a zero price and a bad unit are refused
  // before the service, so this route cannot become a back door into the
  // catalogue with weaker validation than the front one.
  const noPrice = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({ name: 'X Med', category_id: NIL, unit: 'strips', default_selling_price: 0 });
  expect(noPrice.status).toBe(422);
  const badUnit = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({ name: 'X Med', category_id: NIL, unit: 'boxes', default_selling_price: 5 });
  expect(badUnit.status).toBe(422);
});
test('quick-add validates pack content quantity and unit pairs', async () => {
  asRole('owner');
  // Valid pack contents reach the service (500 from stubbed db)
  const valid = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({
      name: 'Augmentin 625', category_id: NIL, unit: 'strips', default_selling_price: 150,
      pack_content_quantity: 10, pack_content_unit: 'TABLET',
    });
  expect(valid.status).not.toBe(403);
  expect(valid.status).not.toBe(422);

  // Missing unit when quantity provided -> 422
  const missingUnit = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({
      name: 'Augmentin 625', category_id: NIL, unit: 'strips', default_selling_price: 150,
      pack_content_quantity: 10,
    });
  expect(missingUnit.status).toBe(422);

  // Missing quantity when unit provided -> 422
  const missingQty = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({
      name: 'Augmentin 625', category_id: NIL, unit: 'strips', default_selling_price: 150,
      pack_content_unit: 'TABLET',
    });
  expect(missingQty.status).toBe(422);

  // Invalid unit value -> 422
  const badContentUnit = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({
      name: 'Augmentin 625', category_id: NIL, unit: 'strips', default_selling_price: 150,
      pack_content_quantity: 10, pack_content_unit: 'INVALID_UNIT',
    });
  expect(badContentUnit.status).toBe(422);

  // Out of range quantity -> 422
  const outOfRangeQty = await request(app).post(`/api/v1/supplier-invoices/${NIL}/items/${NIL}/medicine`)
    .send({
      name: 'Augmentin 625', category_id: NIL, unit: 'strips', default_selling_price: 150,
      pack_content_quantity: 5000, pack_content_unit: 'TABLET',
    });
  expect(outOfRangeQty.status).toBe(422);
});
test('reason over 300 chars -> 422', async () => {
  const r = await request(app).post(`/api/v1/supplier-invoices/${NIL}/reject`).send({ reason: 'x'.repeat(400) });
  expect(r.status).toBe(422);
});

/* ── schema-37: tax, party and document detail ─────────────────────────────
 *
 * Same hermetic contract as everything above — a 422 means the route's
 * validator rejected the body, and a 500 means it passed and reached the
 * throwing Supabase stub. "Not 422" is therefore the assertion for a body that
 * SHOULD be accepted; the service layer is covered by tests/unit/. */

const patchInvoice = (body) => request(app).patch(`/api/v1/supplier-invoices/${NIL}`).send(body);
const patchItem = (body) => request(app).patch(`/api/v1/supplier-invoices/${NIL}/items/${NIL}`).send(body);

test('invoice_type accepts only the three document types', async () => {
  for (const type of ['TAX_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE']) {
    expect((await patchInvoice({ invoice_type: type })).status).not.toBe(422);
  }
  expect((await patchInvoice({ invoice_type: 'CREDIT' })).status).toBe(422);
  expect((await patchInvoice({ invoice_type: 'invoice' })).status).toBe(422);
  // NOT NULL in the schema, so it cannot be cleared — there is no such thing
  // as a document with no type.
  expect((await patchInvoice({ invoice_type: null })).status).toBe(422);
});

test('payment_type is a separate axis and does not accept a document type', async () => {
  for (const type of ['CASH', 'CREDIT']) {
    expect((await patchInvoice({ payment_type: type })).status).not.toBe(422);
  }
  // The distinction this whole pair exists for: "CREDIT" is payment terms.
  expect((await patchInvoice({ payment_type: 'CREDIT_NOTE' })).status).toBe(422);
  expect((await patchInvoice({ payment_type: null })).status).not.toBe(422);
});

test('round_off and adjustment_amount accept negatives; other money does not', async () => {
  // A round-off is negative more often than positive — see schema-37 §37.1.
  expect((await patchInvoice({ round_off: -0.21 })).status).not.toBe(422);
  expect((await patchInvoice({ adjustment_amount: -30 })).status).not.toBe(422);
  // Everything else keeps the non-negative rule the rest of the schema uses.
  expect((await patchInvoice({ subtotal: -1 })).status).toBe(422);
  expect((await patchInvoice({ total_cgst: -1 })).status).toBe(422);
  expect((await patchInvoice({ additional_amount: -1 })).status).toBe(422);
});

test('invoice_time accepts printed shapes and rejects nonsense', async () => {
  expect((await patchInvoice({ invoice_time: '14:35' })).status).not.toBe(422);
  expect((await patchInvoice({ invoice_time: '02:35 PM' })).status).not.toBe(422);
  expect((await patchInvoice({ invoice_time: 'lunchtime' })).status).toBe(422);
});

test('the tax summary must be an array of distinct, valid rate bands', async () => {
  const ok = await patchInvoice({
    tax_summary: [
      { tax_rate: 5, taxable_amount: 100, cgst_amount: 2.5, sgst_amount: 2.5 },
      { tax_rate: 12, taxable_amount: 200, cgst_amount: 12, sgst_amount: 12 },
      { tax_rate: 18, taxable_amount: 300, igst_amount: 54 },
    ],
  });
  expect(ok.status).not.toBe(422);

  // A band with no rate has no identity — the rate IS the key.
  expect((await patchInvoice({ tax_summary: [{ taxable_amount: 100 }] })).status).toBe(422);
  // Two bands at one rate would break the unique index AFTER the delete half
  // of the replace had already run, so it is refused at the door.
  expect((await patchInvoice({ tax_summary: [{ tax_rate: 12 }, { tax_rate: 12 }] })).status).toBe(422);
  expect((await patchInvoice({ tax_summary: [{ tax_rate: 120 }] })).status).toBe(422);
  expect((await patchInvoice({ tax_summary: [{ tax_rate: 12, taxable_amount: -5 }] })).status).toBe(422);
  expect((await patchInvoice({ tax_summary: 'none' })).status).toBe(422);
  // Zero is a real band — exempt goods.
  expect((await patchInvoice({ tax_summary: [{ tax_rate: 0, taxable_amount: 500 }] })).status).not.toBe(422);
});

test('line tax components validate independently — CGST/SGST or IGST, never required together', async () => {
  expect((await patchItem({ cgst_pct: 6, cgst_amount: 60, sgst_pct: 6, sgst_amount: 60 })).status).not.toBe(422);
  expect((await patchItem({ igst_pct: 12, igst_amount: 120 })).status).not.toBe(422);
  expect((await patchItem({ cess_pct: 1, cess_amount: 10 })).status).not.toBe(422);

  expect((await patchItem({ cgst_pct: 300 })).status).toBe(422);
  expect((await patchItem({ igst_amount: -1 })).status).toBe(422);
  expect((await patchItem({ cess_pct: -2 })).status).toBe(422);
});

test('trade price, discount amount and HSN reach the service as their own fields', async () => {
  // Three distinct prices on one line is legitimate, not a conflict to reject.
  const r = await patchItem({
    hsn_code: '30049099', trade_price: 24, printed_rate: 20.22, printed_mrp: 28.31,
    discount_amount: 15.47, taxable_amount: 500.13, net_amount: 560.15,
  });
  expect(r.status).not.toBe(422);

  expect((await patchItem({ trade_price: -1 })).status).toBe(422);
  expect((await patchItem({ discount_amount: -1 })).status).toBe(422);
  expect((await patchItem({ hsn_code: 'x'.repeat(30) })).status).toBe(422);
});

test('paid and free quantity are validated as two independent non-negative counts', async () => {
  expect((await patchItem({ qty_billed: 10, qty_free: 5 })).status).not.toBe(422);
  expect((await patchItem({ qty_billed: 0, qty_free: 12 })).status).not.toBe(422);
  expect((await patchItem({ qty_billed: -1 })).status).toBe(422);
  expect((await patchItem({ qty_free: -1 })).status).toBe(422);
  expect((await patchItem({ qty_billed: 2.5 })).status).toBe(422);
});

test('party snapshot fields are accepted and length-bounded', async () => {
  const r = await patchInvoice({
    supplier_address: 'Station Road, Gadag', supplier_state: 'Karnataka', supplier_state_code: '29',
    buyer_name: 'P. Care Pharma', buyer_gstin: '29ABCDE1234F1Z5', buyer_state_code: '29',
  });
  expect(r.status).not.toBe(422);
  expect((await patchInvoice({ supplier_state_code: '2900' })).status).toBe(422);
  expect((await patchInvoice({ buyer_address: 'x'.repeat(500) })).status).toBe(422);
});

test('status is still refused in the body, alongside every new field', async () => {
  const r = await patchInvoice({ invoice_type: 'TAX_INVOICE', status: 'IMPORTED' });
  expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
});

