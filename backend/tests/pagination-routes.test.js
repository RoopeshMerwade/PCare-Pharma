/**
 * Pagination refactor — routing, validation and guards. HERMETIC.
 *
 * No network, no seeded data, no credentials — but backend/.env must exist,
 * because app.js validates config at require time. Runs in CI.
 *
 * Same technique as stock-requisition-routes.test.js: `authenticate` is stubbed
 * to whatever role the test wants, and the Supabase client's `from()` THROWS.
 * So a 500 is a POSITIVE assertion — the request got past every guard and
 * validator and reached the data layer. A 422 or 403 in its place is the
 * assertion that a validator or guard fired FIRST, before anything was read.
 */

const mockSession = { id: 'u1', role: 'owner' };

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

const API = '/api/v1';
const UUID = '11111111-2222-4333-8444-555555555555';

const asRole = (role, id = 'u1') => { mockSession.role = role; mockSession.id = id; };
beforeEach(() => asRole('owner'));

/** Reached the data layer — every guard and validator let it through. */
const REACHED = [500, 'INTERNAL_ERROR'];
const REJECTED = [422, 'VALIDATION_ERROR'];
const FORBIDDEN = [403, 'FORBIDDEN'];
const outcome = (r) => [r.status, r.body.error];

// ── Route order ──────────────────────────────────────────────
// The highest-value test in this file. Registered after '/:id', the literal
// path 'options' binds to :id, fails isUUID and answers 422 about a malformed
// identifier — a routing bug wearing a validation bug's clothes. This fails the
// moment someone reorders the routes.

describe('GET /suppliers/options — literal path beats /:id', () => {
  test('reaches its own handler, not the by-id route', async () => {
    // VALIDATION_ERROR here would mean 'options' had bound to :id.
    expect(outcome(await request(app).get(`${API}/suppliers/options`))).toEqual(REACHED);
  });

  test('is reachable by staff — the Add Batch form needs it', async () => {
    // Every supplier dropdown that moved to this endpoint is on a screen staff
    // can open. An owner-only guard here would empty the distributor select
    // on BatchDrawer, and POST /inventory/batches is a both-roles route.
    asRole('staff');
    expect(outcome(await request(app).get(`${API}/suppliers/options`))).toEqual(REACHED);
  });

  test('/suppliers/:id still resolves a real UUID', async () => {
    expect(outcome(await request(app).get(`${API}/suppliers/${UUID}`))).toEqual(REACHED);
  });

  test('/suppliers/:id still rejects a non-UUID', async () => {
    expect(outcome(await request(app).get(`${API}/suppliers/not-a-uuid`))).toEqual(REJECTED);
  });
});

// ── Suppliers list ───────────────────────────────────────────

describe('GET /suppliers — pagination and search', () => {
  test.each([
    ['no params', ''],
    ['page 1', '?page=1&limit=10'],
    ['page 2', '?page=2&limit=10'],
    ['a page far past the end', '?page=9999&limit=10'],
    ['search alone', '?search=medico'],
    ['search with pagination', '?search=medico&page=2&limit=10'],
    ['at the limit ceiling', '?limit=100'],
  ])('accepts %s', async (_label, qs) => {
    expect(outcome(await request(app).get(`${API}/suppliers${qs}`))).toEqual(REACHED);
  });

  test.each([
    ['page 0', '?page=0'],
    ['a negative page', '?page=-1'],
    ['limit 0', '?limit=0'],
    ['limit above the cap', '?limit=101'],
    ['a search longer than 100 chars', `?search=${'x'.repeat(101)}`],
  ])('rejects %s', async (_label, qs) => {
    expect(outcome(await request(app).get(`${API}/suppliers${qs}`))).toEqual(REJECTED);
  });
});

// ── Inventory ────────────────────────────────────────────────

describe('GET /inventory — pagination, filters and stats', () => {
  test.each([
    ['no params', ''],
    ['page 1', '?page=1&limit=10'],
    ['page 2', '?page=2&limit=10'],
    ['a page far past the end', '?page=9999&limit=10'],
    ['the low filter', '?stock=low'],
    ['the out filter', '?stock=out'],
    ['the near_expiry filter', '?stock=near_expiry'],
    ['an empty stock filter', '?stock='],
    ['a category', `?categoryId=${UUID}`],
    ['search + filter + pagination together', `?search=amox&categoryId=${UUID}&stock=low&page=2&limit=50`],
  ])('accepts %s', async (_label, qs) => {
    expect(outcome(await request(app).get(`${API}/inventory${qs}`))).toEqual(REACHED);
  });

  test.each([
    ['page 0', '?page=0'],
    ['limit above the cap', '?limit=101'],
    ['an unknown stock filter', '?stock=bogus'],
    ["the 'ok' stock filter this endpoint does not serve", '?stock=ok'],
    ['a malformed categoryId', '?categoryId=not-a-uuid'],
  ])('rejects %s', async (_label, qs) => {
    expect(outcome(await request(app).get(`${API}/inventory${qs}`))).toEqual(REJECTED);
  });

  test('is reachable by staff — the counter reads stock levels', async () => {
    asRole('staff');
    expect(outcome(await request(app).get(`${API}/inventory?page=1&limit=10`))).toEqual(REACHED);
  });
});

// ── Medicines ────────────────────────────────────────────────

describe('GET /medicines — already paginated, now carries stats', () => {
  test.each([
    ['page 1 at the page size the UI asks for', '?page=1&limit=15'],
    ['page 2', '?page=2&limit=15'],
    ['search + filter + pagination', `?search=amox&categoryId=${UUID}&stock=low&page=2&limit=15`],
  ])('accepts %s', async (_label, qs) => {
    expect(outcome(await request(app).get(`${API}/medicines${qs}`))).toEqual(REACHED);
  });

  test('rejects a limit above the cap', async () => {
    expect(outcome(await request(app).get(`${API}/medicines?limit=101`))).toEqual(REJECTED);
  });
});

// ── Expiry ───────────────────────────────────────────────────

describe('GET /expiry/batches — the new paged rows endpoint', () => {
  test.each([
    ['expired', '?urgency=expired'],
    ['critical with paging', '?urgency=critical&page=2&limit=10'],
    ['warning', '?urgency=warning'],
    ['watch', '?urgency=watch'],
    ['a page far past the end', '?urgency=expired&page=9999&limit=10'],
  ])('accepts %s', async (_label, qs) => {
    expect(outcome(await request(app).get(`${API}/expiry/batches${qs}`))).toEqual(REACHED);
  });

  test.each([
    ['a missing urgency — it is required here, unlike the :urgency route', ''],
    ["urgency=ok, which is not a bucket the dashboard offers", '?urgency=ok'],
    ['an unknown urgency', '?urgency=bogus'],
    ['page 0', '?urgency=expired&page=0'],
    ['limit above the cap', '?urgency=expired&limit=101'],
  ])('rejects %s', async (_label, qs) => {
    expect(outcome(await request(app).get(`${API}/expiry/batches${qs}`))).toEqual(REJECTED);
  });

  test('stays owner-only, and the guard fires before any read', async () => {
    asRole('staff');
    expect(outcome(await request(app).get(`${API}/expiry/batches?urgency=expired`))).toEqual(FORBIDDEN);
  });

  test('the legacy /expiry/urgency/:urgency route still answers', async () => {
    // Kept deliberately: it is a documented route in the generated Postman
    // collection, and getBatchesByUrgency is now a thin wrapper over the paged
    // function rather than a second implementation.
    expect(outcome(await request(app).get(`${API}/expiry/urgency/critical`))).toEqual(REACHED);
  });

  test('/expiry/dashboard still answers, and stays owner-only', async () => {
    expect(outcome(await request(app).get(`${API}/expiry/dashboard`))).toEqual(REACHED);
    asRole('staff');
    expect(outcome(await request(app).get(`${API}/expiry/dashboard`))).toEqual(FORBIDDEN);
  });
});

// ── Reports ──────────────────────────────────────────────────

describe('reports still route as before', () => {
  test('/reports/inventory reaches its handler', async () => {
    expect(outcome(await request(app).get(`${API}/reports/inventory`))).toEqual(REACHED);
  });

  test('/reports/purchases reaches its handler', async () => {
    expect(outcome(await request(app).get(`${API}/reports/purchases`))).toEqual(REACHED);
  });

  test('both stay owner-only', async () => {
    asRole('staff');
    expect(outcome(await request(app).get(`${API}/reports/inventory`))).toEqual(FORBIDDEN);
    expect(outcome(await request(app).get(`${API}/reports/purchases`))).toEqual(FORBIDDEN);
  });
});
