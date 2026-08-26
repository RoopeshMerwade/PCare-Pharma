/**
 * MODULE 23: Supplier Invoice Ingestion
 * Runner: Jest + Supertest
 *
 * Requires TEST_OWNER_* / TEST_STAFF_* in backend/.env, like every other suite
 * here, plus schema-23-supplier-invoices.sql applied to that project.
 *
 * What this suite does NOT do is call Gemini. Extraction quality is not a
 * property a test can assert against a live model, and burning API calls in CI
 * to find out that a mock invoice parsed is a poor trade. The extraction
 * boundary is covered by tests/unit/supplier-invoice-normalize.test.js and
 * -rules.test.js, which are pure and exhaustive; what is worth exercising over
 * HTTP is the contract around it: who may do what, what the guards reject, and
 * that approval is owner-only.
 *
 * Uploads therefore assert on the ingestion guards (file type, size, field
 * name) and, when GEMINI_API_KEY is absent, on the 503 the module is designed
 * to give instead of failing to boot.
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken;

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL, password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;
});

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);

// A one-pixel PNG. Enough to satisfy the mime filter; never reaches a model
// unless a key is configured, and if it does, an empty extraction is the
// correct answer for it.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('Module 23 — access control', () => {
  test('TC-SINV-01: unauthenticated requests are rejected', async () => {
    const res = await request(app).get('/api/v1/supplier-invoices');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_MISSING');
  });

  test('TC-SINV-02: both roles can list invoices — staff do the goods inward', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/supplier-invoices').set(oa()),
      request(app).get('/api/v1/supplier-invoices').set(sa()),
    ]);
    expect(o.status).toBe(200);
    expect(s.status).toBe(200);
    expect(Array.isArray(o.body.data.invoices)).toBe(true);
    expect(o.body.data.pagination).toMatchObject({ page: 1 });
  });

  test('TC-SINV-03: staff cannot approve — approval is the write that creates stock', async () => {
    const res = await request(app).post(`/api/v1/supplier-invoices/${NIL_UUID}/approve`).set(sa());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  test('TC-SINV-04: staff cannot quick-add a medicine — catalogue writes stay owner-only', async () => {
    const res = await request(app)
      .post(`/api/v1/supplier-invoices/${NIL_UUID}/items/${NIL_UUID}/medicine`)
      .set(sa())
      .send({ name: 'Test Med', category_id: NIL_UUID, unit: 'strips', default_selling_price: 10 });
    expect(res.status).toBe(403);
  });
});

describe('Module 23 — list and lookup contracts', () => {
  test('TC-SINV-05: an unknown status filter is rejected, not silently ignored', async () => {
    const res = await request(app).get('/api/v1/supplier-invoices?status=MAYBE').set(oa());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('TC-SINV-06: a non-uuid id is a validation error, not a 404 lookup', async () => {
    const res = await request(app).get('/api/v1/supplier-invoices/not-a-uuid').set(oa());
    expect(res.status).toBe(422);
  });

  test('TC-SINV-07: an unknown invoice is 404 INVOICE_NOT_FOUND', async () => {
    const res = await request(app).get(`/api/v1/supplier-invoices/${NIL_UUID}`).set(oa());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('INVOICE_NOT_FOUND');
  });

  test('TC-SINV-08: trigram medicine match answers both roles and needs a query', async () => {
    const ok = await request(app).get('/api/v1/supplier-invoices/match/medicines?q=paracetamol').set(sa());
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.data.medicines)).toBe(true);

    const missing = await request(app).get('/api/v1/supplier-invoices/match/medicines').set(sa());
    expect(missing.status).toBe(422);
  });

  test('TC-SINV-09: /match/medicines resolves before /:id despite the shared prefix', async () => {
    // Route order regression: registering /:id first would make "match" an id
    // and answer 422 for a perfectly good search.
    const res = await request(app).get('/api/v1/supplier-invoices/match/medicines?q=a').set(oa());
    expect(res.status).toBe(200);
  });
});

describe('Module 23 — upload guards', () => {
  test('TC-SINV-10: a rejected file type never reaches the model', async () => {
    const res = await request(app)
      .post('/api/v1/supplier-invoices')
      .set(sa())
      .attach('file', Buffer.from('not an invoice'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('UNSUPPORTED_FILE_TYPE');
  });

  test('TC-SINV-11: a request with no file is 422 NO_FILE', async () => {
    const res = await request(app).post('/api/v1/supplier-invoices').set(sa()).field('supplier_id', '');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('NO_FILE');
  });

  test('TC-SINV-12: the file must arrive in the "file" field', async () => {
    const res = await request(app)
      .post('/api/v1/supplier-invoices')
      .set(sa())
      .attach('invoice', TINY_PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('UNEXPECTED_FILE');
  });

  const describeIfUnconfigured = geminiConfigured ? describe.skip : describe;
  describeIfUnconfigured('without GEMINI_API_KEY', () => {
    test('TC-SINV-13: the module reports 503 rather than the API failing to boot', async () => {
      // The whole point of keeping the key out of config REQUIRED: an
      // unconfigured pharmacy still gets a working POS.
      const res = await request(app)
        .post('/api/v1/supplier-invoices')
        .set(sa())
        .attach('file', TINY_PNG, { filename: 'invoice.png', contentType: 'image/png' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('EXTRACTION_UNAVAILABLE');
    });
  });
});

describe('Module 23 — review edit guards', () => {
  test('TC-SINV-14: status cannot be moved through the generic PATCH', async () => {
    // It moves only through /approve and /reject, which carry the role guard
    // and the audit entry.
    const res = await request(app)
      .patch(`/api/v1/supplier-invoices/${NIL_UUID}`)
      .set(oa())
      .send({ status: 'IMPORTED' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('TC-SINV-15: a malformed date is rejected before it reaches the column', async () => {
    const res = await request(app)
      .patch(`/api/v1/supplier-invoices/${NIL_UUID}`)
      .set(oa())
      .send({ invoice_date: '12/08/2026' });
    expect(res.status).toBe(422);
  });

  test('TC-SINV-16: a discount above 100% is rejected — it is a misread, not a deal', async () => {
    // pack_size is deliberately absent from this API since schema-25: the Pack
    // column describes what is inside a saleable unit and never multiplies a
    // quantity, so there is no multiplier left to validate.
    const res = await request(app)
      .patch(`/api/v1/supplier-invoices/${NIL_UUID}/items/${NIL_UUID}`)
      .set(oa())
      .send({ discount_pct: 300 });
    expect(res.status).toBe(422);
  });

  test('TC-SINV-17: negative money is rejected', async () => {
    const res = await request(app)
      .patch(`/api/v1/supplier-invoices/${NIL_UUID}/items/${NIL_UUID}`)
      .set(oa())
      .send({ unit_cost: -1 });
    expect(res.status).toBe(422);
  });

  test('TC-SINV-18: editing a line on an unknown invoice is 404, not 500', async () => {
    const res = await request(app)
      .patch(`/api/v1/supplier-invoices/${NIL_UUID}/items/${NIL_UUID}`)
      .set(oa())
      .send({ batch_no: 'AB-1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('INVOICE_NOT_FOUND');
  });
});

describe('Module 23 — approval guards', () => {
  test('TC-SINV-19: approving an unknown invoice is 404, and nothing is written', async () => {
    const res = await request(app).post(`/api/v1/supplier-invoices/${NIL_UUID}/approve`).set(oa());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('INVOICE_NOT_FOUND');
  });

  test('TC-SINV-20: rejecting an unknown invoice is 404', async () => {
    const res = await request(app)
      .post(`/api/v1/supplier-invoices/${NIL_UUID}/reject`)
      .set(sa())
      .send({ reason: 'Wrong document' });
    expect(res.status).toBe(404);
  });

  test('TC-SINV-21: a rejection reason longer than the column is refused', async () => {
    const res = await request(app)
      .post(`/api/v1/supplier-invoices/${NIL_UUID}/reject`)
      .set(oa())
      .send({ reason: 'x'.repeat(400) });
    expect(res.status).toBe(422);
  });
});
