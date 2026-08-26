/**
 * Module 30 — routing, validation and guards. HERMETIC.
 *
 * No network, no seeded data, no credentials — but backend/.env must exist,
 * because app.js validates config at require time. Runs in CI.
 *
 * The technique, copied from attendance-routes.test.js: `authenticate` is
 * stubbed to whatever role the test wants, and the Supabase client's `from()`
 * THROWS. So a 500 is a positive assertion — it means the request got all the
 * way past every guard and validator and reached the data layer. A 403 where a
 * 500 would otherwise appear is the assertion that a guard fired FIRST, before
 * anything was read.
 */

const mockSession = { id: 'u1', role: 'staff' };

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, res, next) => {
    req.user = {
      id: mockSession.id, full_name: 'Test User', is_active: true, role: mockSession.role,
    };
    next();
  },
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role) ? next()
      : next(Object.assign(new Error('You do not have permission to perform this action.'), {
        statusCode: 403, code: 'FORBIDDEN', isOperational: true,
      }))
  ),
}));

jest.mock('../src/config/supabase', () => ({
  supabase: {
    from: () => { throw new Error('unexpected db call — a guard let this through'); },
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({}) },
    auth: {},
  },
  createAuthClient: () => ({}),
}));

const request = require('supertest');
const app = require('../src/app');

const BASE = '/api/v1/stock-requisitions';
const UUID = '11111111-2222-4333-8444-555555555555';
const UUID2 = '99999999-8888-4777-8666-555555555555';

const asRole = (role, id = 'u1') => { mockSession.role = role; mockSession.id = id; };
beforeEach(() => asRole('staff'));

// ── Route order ──────────────────────────────────────────────
// The highest-value test in this file. Registered after '/:id', the literal
// path 'vendor-prices' binds to :id, fails isUUID and answers 422 about a
// malformed identifier — a routing bug that presents as a nonsense validation
// error. This fails the moment someone reorders the routes.

describe('literal paths are matched before /:id', () => {
  // INTERNAL_ERROR is the stub throwing from the data layer — i.e. the request
  // arrived at the right handler. VALIDATION_ERROR here would mean the literal
  // path had bound to :id and failed isUUID, which is the bug.
  test('/vendor-prices reaches its own handler, not the by-id route', async () => {
    const r = await request(app).get(`${BASE}/vendor-prices?medicine_ids=${UUID}`);
    expect([r.status, r.body.error]).toEqual([500, 'INTERNAL_ERROR']);
  });

  test('/low-stock reaches its own handler, not the by-id route', async () => {
    const r = await request(app).get(`${BASE}/low-stock`);
    expect([r.status, r.body.error]).toEqual([500, 'INTERNAL_ERROR']);
  });
});

// ── Validation ───────────────────────────────────────────────

describe('vendor-prices validation', () => {
  test('no medicine_ids is refused', async () => {
    const r = await request(app).get(`${BASE}/vendor-prices`);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a non-UUID anywhere in the list is refused', async () => {
    const r = await request(app).get(`${BASE}/vendor-prices?medicine_ids=${UUID},banana`);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('more than 50 ids is refused', async () => {
    const ids = Array.from({ length: 51 }, () => UUID).join(',');
    const r = await request(app).get(`${BASE}/vendor-prices?medicine_ids=${ids}`);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a valid list of two gets through to the service', async () => {
    const r = await request(app).get(`${BASE}/vendor-prices?medicine_ids=${UUID},${UUID2}`);
    expect(r.status).toBe(500);
  });
});

describe('create validation', () => {
  const post = (body) => request(app).post(BASE).send(body);

  test('an empty items array is refused', async () => {
    const r = await post({ items: [] });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a missing items array is refused', async () => {
    const r = await post({ urgency: 'urgent' });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a non-UUID medicine_id is refused', async () => {
    const r = await post({ items: [{ medicine_id: 'nope', qty: 1 }] });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a quantity of zero is refused', async () => {
    const r = await post({ items: [{ medicine_id: UUID, qty: 0 }] });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('more than 50 lines is refused', async () => {
    const items = Array.from({ length: 51 }, () => ({ medicine_id: UUID, qty: 1 }));
    const r = await post({ items });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('an invalid urgency is refused', async () => {
    const r = await post({ urgency: 'yesterday', items: [{ medicine_id: UUID, qty: 1 }] });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a valid line reaches the service', async () => {
    const r = await post({ items: [{ medicine_id: UUID, qty: 5, supplier_id: UUID2 }] });
    expect(r.status).toBe(500);
  });

  test('a client-supplied unit_cost is IGNORED, not rejected', async () => {
    // The validator has no rule for it, so it passes validation and is dropped
    // by snapshotVendors, which reads every figure from the database. If this
    // ever becomes a 422, someone has added a rule that makes the field look
    // legitimate — which is the first step to honouring it.
    const r = await post({
      items: [{ medicine_id: UUID, qty: 5, unit_cost: 1.0, mrp: 999, supplier_name: 'Forged Pharma' }],
    });
    expect(r.status).toBe(500);
  });

  test('a note over 500 characters is refused', async () => {
    const r = await post({ note: 'x'.repeat(501), items: [{ medicine_id: UUID, qty: 1 }] });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });
});

describe('reject validation', () => {
  beforeEach(() => asRole('owner'));

  test('a rejection with no reason is refused', async () => {
    const r = await request(app).patch(`${BASE}/${UUID}/reject`).send({});
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a four-character reason is refused', async () => {
    const r = await request(app).patch(`${BASE}/${UUID}/reject`).send({ rejection_note: 'nope' });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('a real reason gets through', async () => {
    const r = await request(app).patch(`${BASE}/${UUID}/reject`)
      .send({ rejection_note: 'We already have three months of this on order.' });
    expect(r.status).toBe(500);
  });
});

describe('export validation', () => {
  beforeEach(() => asRole('owner'));

  test('an unsupported format is refused', async () => {
    const r = await request(app).get(`${BASE}/${UUID}/export/csv`);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test('xlsx and pdf both get through', async () => {
    for (const format of ['xlsx', 'pdf']) {
      const r = await request(app).get(`${BASE}/${UUID}/export/${format}`);
      expect([format, r.status]).toEqual([format, 500]);
    }
  });
});

// ── Reachability ─────────────────────────────────────────────

describe('staff reach the routes that are theirs', () => {
  test.each([
    ['get',   `${BASE}`],
    ['get',   `${BASE}/${UUID}`],
    ['get',   `${BASE}/low-stock`],
    ['get',   `${BASE}/vendor-prices?medicine_ids=${UUID}`],
  ])('%s %s is not refused', async (method, path) => {
    const r = await request(app)[method](path);
    expect([path, r.status]).toEqual([path, 500]);
  });

  test('staff may raise a request', async () => {
    const r = await request(app).post(BASE).send({ items: [{ medicine_id: UUID, qty: 1 }] });
    expect(r.status).toBe(500);
  });

  test('staff may withdraw — the ownership check is in the service, not the route', async () => {
    // A route-level authorize() here could only say "owner only", which would
    // lock a staff member out of withdrawing their own request. The 500 proves
    // the route let them through to the check that can actually see whose it is.
    const r = await request(app).patch(`${BASE}/${UUID}/cancel`);
    expect(r.status).toBe(500);
  });
});

describe('owner-only actions refuse staff BEFORE any data is read', () => {
  test.each([
    ['patch', `${BASE}/${UUID}/approve`],
    ['patch', `${BASE}/${UUID}/reject`],
    ['get',   `${BASE}/${UUID}/export/xlsx`],
    ['get',   `${BASE}/${UUID}/export/pdf`],
  ])('%s %s is 403 for staff', async (method, path) => {
    // 403 rather than 500 is the whole assertion: a 500 would mean a staff
    // session had reached the data layer of an owner-only export.
    const r = await request(app)[method](path).send({ rejection_note: 'a valid reason here' });
    expect([path, r.status, r.body.error]).toEqual([path, 403, 'FORBIDDEN']);
  });

  test.each([
    ['patch', `${BASE}/${UUID}/approve`],
    ['get',   `${BASE}/${UUID}/export/xlsx`],
  ])('%s %s is reachable for the owner', async (method, path) => {
    asRole('owner');
    const r = await request(app)[method](path);
    expect([path, r.status]).toEqual([path, 500]);
  });
});

test('an unknown stock-requisition path still 404s rather than falling through', async () => {
  const r = await request(app).get(`${BASE}/${UUID}/nonsense`);
  expect([r.status, r.body.error]).toEqual([404, 'NOT_FOUND']);
});
