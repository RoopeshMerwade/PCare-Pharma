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

