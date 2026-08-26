/**
 * SECURITY — authentication, role authorisation and resource-level (IDOR) checks
 * Runner: npx jest tests/authorization.test.js --runInBand
 *
 * Needs backend/.env for config validation, but NO seeded users and no network:
 * `authenticate` is replaced with a stub that injects a role, and Supabase is
 * replaced with a fake serving a fixed set of rows. Runs in CI without secrets,
 * the same arrangement tests/supplier-invoice-routes.test.js uses.
 *
 * THE DEFECT PINNED HERE
 *
 * `listBills` scoped staff to `created_by = <self>`; `getBillById` had no check
 * at all. A bill id is a UUID in the URL of every receipt, so a staff member who
 * kept a link — or simply re-used one — could read a colleague's sale: customer
 * name, phone, and every line item. `listReturns` / `getReturnById` had the
 * identical shape and the identical gap.
 *
 * Both cases fail loudly against the pre-fix code, which is what stops the fix
 * being quietly reverted.
 */

// Jest hoists jest.mock factories above every declaration in the file. The only
// out-of-scope names a factory may close over are ones prefixed `mock`, and it
// reads them lazily at call time — which is what lets a test mutate them.
const mockSession = { user: null };
const mockTouched = [];

const OWNER = { id: 'owner-1', full_name: 'Vijay', role: 'owner', is_active: true };
const ANITA = { id: 'staff-anita', full_name: 'Anita Rao', role: 'staff', is_active: true };
const RAVI  = { id: 'staff-ravi', full_name: 'Ravi Kumar', role: 'staff', is_active: true };

const ANITAS_BILL   = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const RAVIS_BILL    = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MISSING_BILL  = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const ANITAS_RETURN = 'cccccccc-3333-4333-8333-cccccccccccc';
const RAVIS_RETURN  = 'dddddddd-4444-4444-8444-dddddddddddd';

const mockRows = {
  bills_with_totals: {
    [ANITAS_BILL]: { id: ANITAS_BILL, bill_number: 'BILL-2026-0001', created_by: ANITA.id, customer_name: 'Ramesh', customer_phone: '9845011223', total: 240 },
    [RAVIS_BILL]:  { id: RAVIS_BILL,  bill_number: 'BILL-2026-0002', created_by: RAVI.id,  customer_name: 'Sunita', customer_phone: '9845099887', total: 980 },
  },
  customer_returns_with_totals: {
    [ANITAS_RETURN]: { id: ANITAS_RETURN, return_number: 'CR-2026-0001', created_by: ANITA.id, status: 'pending', customer_name: 'Ramesh' },
    [RAVIS_RETURN]:  { id: RAVIS_RETURN,  return_number: 'CR-2026-0002', created_by: RAVI.id,  status: 'pending', customer_name: 'Sunita' },
  },
};

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, res, next) => { req.user = { ...mockSession.user }; next(); },
  // Mirrors the real guard's contract exactly, so errorHandler serialises it
  // identically: { error: 'FORBIDDEN', message }.
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role)
      ? next()
      : next(Object.assign(new Error('You do not have permission to perform this action.'), {
        statusCode: 403, code: 'FORBIDDEN', isOperational: true,
      }))
  ),
}));

// Minimal PostgREST-shaped fake. `.single()` resolves the fixture for whatever
// id was filtered on; list queries resolve empty. Every table touched is
// recorded, so a test can assert that a DENIED request never reached the row.
jest.mock('../src/config/supabase', () => {
  const build = (table) => {
    const q = { _table: table, _id: null };
    const chain = () => q;
    q.select = chain; q.order = chain; q.range = chain; q.limit = chain;
    q.gte = chain; q.lte = chain; q.neq = chain; q.or = chain;
    q.eq = (col, val) => { if (col === 'id') q._id = val; return q; };
    q.single = async () => {
      const row = mockRows[q._table]?.[q._id] || null;
      return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
    };
    q.maybeSingle = q.single;
    // Awaiting the builder itself (list queries) yields an empty page.
    q.then = (resolve, reject) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    return q;
  };

  return {
    supabase: {
      from: (table) => { mockTouched.push(table); return build(table); },
      rpc: async () => ({ data: null, error: null }),
      storage: { from: () => ({}) },
      auth: {},
    },
    createAuthClient: () => ({ auth: {} }),
  };
});

const request = require('supertest');
const app = require('../src/app');

const asUser = (u) => { mockSession.user = u; };

beforeEach(() => {
  asUser(ANITA);
  mockTouched.length = 0;
});

/* ══════════════════════════ IDOR: BILLS ══════════════════════════ */

describe('GET /billing/:id — resource-level authorisation', () => {
  test('owner can read any bill, including one a staff member created', async () => {
    asUser(OWNER);
    const r = await request(app).get(`/api/v1/billing/${RAVIS_BILL}`);
    expect(r.status).toBe(200);
    expect(r.body.data.bill.bill_number).toBe('BILL-2026-0002');
  });

  test('staff can read their OWN bill', async () => {
    asUser(ANITA);
    const r = await request(app).get(`/api/v1/billing/${ANITAS_BILL}`);
    expect(r.status).toBe(200);
    expect(r.body.data.bill.bill_number).toBe('BILL-2026-0001');
  });

  test("staff CANNOT read another user's bill by UUID — this is the IDOR", async () => {
    asUser(ANITA);
    const r = await request(app).get(`/api/v1/billing/${RAVIS_BILL}`);

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('FORBIDDEN');

    // The denial must not leak any part of the row it refused to serve.
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('Sunita');
    expect(body).not.toContain('9845099887');
    expect(body).not.toContain('BILL-2026-0002');
  });

  test('a bill that does not exist is 404, for owner and staff alike', async () => {
    asUser(OWNER);
    const r = await request(app).get(`/api/v1/billing/${MISSING_BILL}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('BILL_NOT_FOUND');
  });

  test('a malformed id is rejected by validation before any database lookup', async () => {
    asUser(ANITA);
    const r = await request(app).get('/api/v1/billing/not-a-uuid');
    expect(r.status).toBe(422);
    expect(mockTouched).not.toContain('bills_with_totals');
  });
});

/* ══════════════════════ IDOR: CUSTOMER RETURNS ══════════════════════ */

describe('GET /customer-returns/:id — the same gap, the same fix', () => {
  test('owner can read any return', async () => {
    asUser(OWNER);
    const r = await request(app).get(`/api/v1/customer-returns/${RAVIS_RETURN}`);
    expect(r.status).toBe(200);
    expect(r.body.data.return.return_number).toBe('CR-2026-0002');
  });

  test('staff can read their own return', async () => {
    asUser(ANITA);
    const r = await request(app).get(`/api/v1/customer-returns/${ANITAS_RETURN}`);
    expect(r.status).toBe(200);
  });

  test("staff CANNOT read another user's return", async () => {
    asUser(ANITA);
    const r = await request(app).get(`/api/v1/customer-returns/${RAVIS_RETURN}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('FORBIDDEN');
    expect(JSON.stringify(r.body)).not.toContain('CR-2026-0002');
  });
});

/* ═══════════════════ ROLE AUTHORISATION — owner-only ═══════════════════ */

describe('owner-only surfaces reject staff', () => {
  // One per router carrying an owner guard, so a refactor that drops
  // `router.use(authorize('owner'))` from any of them fails here.
  const OWNER_ONLY = [
    '/api/v1/audit-logs',
    '/api/v1/purchases',
    '/api/v1/supplier-returns',
    '/api/v1/expiry/dashboard',
    '/api/v1/dashboard/owner',
    '/api/v1/users',
    '/api/v1/billing/totals',
    '/api/v1/inventory/expired',
    '/api/v1/medicines/alerts/low-stock',
  ];

  test.each(OWNER_ONLY)('staff gets 403 on GET %s', async (path) => {
    asUser(ANITA);
    const r = await request(app).get(path);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('FORBIDDEN');
    // A guard that let the request through would have queried the fake database.
    expect(mockTouched).toHaveLength(0);
  });

  test('owner reaches the same surface (the guard is not blanket-denying)', async () => {
    asUser(OWNER);
    const r = await request(app).get('/api/v1/audit-logs');
    expect(r.status).not.toBe(403);
  });
});

/* ═════════════════ ROLE AUTHORISATION — staff-permitted ═════════════════ */

describe('staff keep the access they are supposed to have', () => {
  const STAFF_ALLOWED = [
    '/api/v1/billing',
    '/api/v1/customer-returns',
    '/api/v1/medicines',
    '/api/v1/inventory',
    '/api/v1/customers',
    '/api/v1/notifications',
    '/api/v1/supplier-invoices',
    '/api/v1/dashboard/staff',
  ];

  test.each(STAFF_ALLOWED)('staff is not forbidden from GET %s', async (path) => {
    asUser(ANITA);
    const r = await request(app).get(path);
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });
});

/* ══════════════ SERVER-DERIVED IDENTITY — no client override ══════════════ */

describe('the authorisation subject comes from the token, never the request', () => {
  test('a created_by in the query string does not widen what staff can read', async () => {
    asUser(ANITA);
    const r = await request(app).get(`/api/v1/billing/${RAVIS_BILL}?created_by=${RAVI.id}`);
    expect(r.status).toBe(403);
  });

  test('a spoofed user id header does not widen what staff can read', async () => {
    asUser(ANITA);
    const r = await request(app)
      .get(`/api/v1/billing/${RAVIS_BILL}`)
      .set('X-User-Id', RAVI.id)
      .set('X-Role', 'owner');
    expect(r.status).toBe(403);
  });
});
