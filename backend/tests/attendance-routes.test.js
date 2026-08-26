/**
 * MODULE 26 — route wiring, guards and validation (hermetic: auth + Supabase stubbed)
 * Runner: npx jest tests/attendance-routes.test.js --runInBand
 *
 * Needs backend/.env for config validation, but NO seeded users and no network.
 * Same technique as tests/supplier-invoice-routes.test.js: `authenticate` is
 * replaced with a stub that injects a role, and the Supabase client is replaced
 * with one whose `.from()` throws. That last part is what makes the suite worth
 * running — a request that reaches the database got past a guard that should
 * have stopped it, so "silently allowed" becomes a loud 500 instead of a pass.
 *
 * Attendance has no route-level `authorize('owner')` anywhere, by design: every
 * endpoint is legitimately reachable by staff for themselves, and the owner's
 * override is a wider scope on the same route. That makes the permission model
 * invisible to a route-shape test — so the checks below pin the two things that
 * ARE observable here: validation, and that no route silently became
 * owner-only. The self/other split itself lives in attendance.service.js.
 */

const mockSession = { id: 'u1', role: 'staff' };

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: mockSession.id, full_name: 'Test User', is_active: true, role: mockSession.role };
    next();
  },
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role)
      ? next()
      : next(Object.assign(new Error('You do not have permission to perform this action.'), {
        statusCode: 403, code: 'FORBIDDEN', isOperational: true,
      }))
  ),
}));

jest.mock('../src/config/supabase', () => ({
  supabase: {
    from: () => { throw new Error('unexpected db call — a guard let this through'); },
    rpc: async () => ({ data: [], error: null }),
    storage: { from: () => ({}) },
    auth: {},
  },
  createAuthClient: () => ({}),
}));

const request = require('supertest');
const app = require('../src/app');

const NIL = '00000000-0000-0000-0000-000000000000';
const asRole = (role, id = 'u1') => { mockSession.role = role; mockSession.id = id; };

beforeEach(() => asRole('staff'));

// ── Validation ────────────────────────────────────────────────────────────

test('check-in with a non-uuid user_id -> 422', async () => {
  const r = await request(app).post('/api/v1/attendance/check-in').send({ user_id: 'not-a-uuid' });
  expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
});

test('notes over 300 chars -> 422, on both write routes', async () => {
  const notes = 'x'.repeat(301);
  for (const path of ['/api/v1/attendance/check-in', '/api/v1/attendance/check-out']) {
    const r = await request(app).post(path).send({ notes });
    expect([path, r.status]).toEqual([path, 422]);
  }
});

test('an empty user_id is "me", not a validation failure', async () => {
  // The self-service widget posts user_id: '' rather than omitting the key.
  // A bare .optional() only skips `undefined`, so this is the exact shape that
  // would 422 if the rule ever loses `{ values: 'falsy' }` — the same trap the
  // Add staff form hit with a blank phone number.
  const r = await request(app).post('/api/v1/attendance/check-in').send({ user_id: '', notes: '' });
  expect(r.status).toBe(500); // reached the service, which hit the throwing db stub
});

test('history rejects a malformed date and a bad page', async () => {
  const badDate = await request(app).get('/api/v1/attendance/history?dateFrom=12/08/2026');
  expect(badDate.status).toBe(422);
  const badPage = await request(app).get('/api/v1/attendance/history?page=0');
  expect(badPage.status).toBe(422);
  const badLimit = await request(app).get('/api/v1/attendance/history?limit=500');
  expect(badLimit.status).toBe(422);
});

test('history accepts YYYY-MM-DD and reaches the service', async () => {
  const r = await request(app).get('/api/v1/attendance/history?dateFrom=2026-08-01&dateTo=2026-08-23&page=2&limit=10');
  expect(r.status).toBe(500);
});

// ── Reachability ──────────────────────────────────────────────────────────

test('staff reach every attendance route — none of them is owner-only', async () => {
  // A 403 on any of these would mean staff had been locked out of their own
  // check-in button, which is the whole feature.
  asRole('staff');
  for (const call of [
    request(app).get('/api/v1/attendance/today'),
    request(app).get('/api/v1/attendance/history'),
    request(app).post('/api/v1/attendance/check-in').send({}),
    request(app).post('/api/v1/attendance/check-out').send({}),
  ]) {
    const r = await call;
    expect(r.status).not.toBe(403);
  }
});

test('owner reaches them too, including with an explicit target', async () => {
  asRole('owner');
  for (const call of [
    request(app).get('/api/v1/attendance/today'),
    request(app).get(`/api/v1/attendance/history?userId=${NIL}`),
    request(app).post('/api/v1/attendance/check-in').send({ user_id: NIL }),
    request(app).post('/api/v1/attendance/check-out').send({ user_id: NIL }),
  ]) {
    const r = await call;
    expect(r.status).not.toBe(403);
  }
});

test('staff targeting somebody else is refused before any database call', async () => {
  // 403 rather than 500 is the assertion that matters: the throwing stub means
  // a 500 would prove the request had already reached the data layer with a
  // target the caller has no business writing to.
  asRole('staff', 'u1');
  for (const path of ['/api/v1/attendance/check-in', '/api/v1/attendance/check-out']) {
    const r = await request(app).post(path).send({ user_id: NIL });
    expect([path, r.status, r.body.error]).toEqual([path, 403, 'FORBIDDEN']);
  }
});

test("staff asking for a colleague's history is refused, not silently rescoped", async () => {
  asRole('staff', 'u1');
  const r = await request(app).get(`/api/v1/attendance/history?userId=${NIL}`);
  expect([r.status, r.body.error]).toEqual([403, 'FORBIDDEN']);
});

test('unknown attendance path still 404s rather than falling through', async () => {
  const r = await request(app).get('/api/v1/attendance/nope');
  expect([r.status, r.body.error]).toEqual([404, 'NOT_FOUND']);
});
