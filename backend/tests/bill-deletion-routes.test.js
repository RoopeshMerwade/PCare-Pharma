/**
 * schema-38 — owner bill deletion: routing, validation, guards and error
 * mapping. HERMETIC.
 *
 * No network, no seeded data, no credentials — but backend/.env must exist,
 * because app.js validates config at require time. Runs in CI.
 *
 * Same technique as stock-requisition-routes.test.js: `authenticate` is stubbed
 * to whatever role the test wants and `from()` THROWS, so no table is ever read.
 * `rpc` is a mock each test scripts, because every deletion path is an RPC —
 * which also lets a test prove the delete RPC was never reached.
 */

const mockSession = { id: 'owner-1', role: 'owner' };
const mockRpc = jest.fn();

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
    rpc: (...args) => mockRpc(...args),
    storage: { from: () => ({}) },
    auth: {},
  },
  createAuthClient: () => ({}),
}));

const request = require('supertest');
const app = require('../src/app');

const BASE = '/api/v1/billing';
const BILL = '11111111-2222-4333-8444-555555555555';
const RANGE = { dateFrom: '2026-09-01', dateTo: '2026-09-13' };
const REASON = 'Test bills from setup week';

const PREVIEW = {
  bill_count: 2, item_count: 3, total_amount: 250,
  sealed_units_not_restocked: 3, loose_units_not_restocked: 10, blocked: [],
};
const BLOCKED = [{ bill_id: BILL, bill_number: 'BILL-0003', return_number: 'CR-0001', return_status: 'approved' }];

// Script the RPCs by name. Anything unscripted is a test failure waiting to
// happen, so it answers with an error that maps to nothing.
function scriptRpc(handlers) {
  mockRpc.mockImplementation(async (fn, args) => {
    if (handlers[fn]) return handlers[fn](args);
    return { data: null, error: { message: `unscripted rpc ${fn}` } };
  });
}
const ok = (data) => () => ({ data, error: null });
const raises = (message) => () => ({ data: null, error: { message } });
const rpcNames = () => mockRpc.mock.calls.map(([fn]) => fn);

beforeEach(() => {
  mockSession.role = 'owner';
  mockSession.id = 'owner-1';
  mockRpc.mockReset();
});

// ── Route order ──────────────────────────────────────────────
// Registered after '/:id', the literal 'delete-preview' binds to :id, fails
// isUUID and answers 422 about a malformed identifier.

describe('literal paths are matched before /:id', () => {
  test('GET /delete-preview reaches its own handler', async () => {
    scriptRpc({ bills_in_ist_range: ok([BILL]), preview_bill_deletion: ok(PREVIEW) });
    const r = await request(app).get(`${BASE}/delete-preview`).query(RANGE);
    expect(r.status).toBe(200);
    expect(r.body.data.preview).toEqual(PREVIEW);
  });
});

// ── Owner only ───────────────────────────────────────────────

describe('staff cannot preview or delete', () => {
  beforeEach(() => { mockSession.role = 'staff'; scriptRpc({}); });

  test.each([
    ['GET', `${BASE}/delete-preview?dateFrom=2026-09-01&dateTo=2026-09-13`, undefined],
    ['POST', `${BASE}/delete-range`, { ...RANGE, reason: REASON, expected_count: 2, expected_total: 250 }],
    ['GET', `${BASE}/${BILL}/delete-preview`, undefined],
    ['POST', `${BASE}/${BILL}/delete`, { reason: REASON }],
  ])('%s %s answers 403 before anything is read', async (method, url, body) => {
    const call = method === 'GET' ? request(app).get(url) : request(app).post(url).send(body);
    const r = await call;
    expect([r.status, r.body.error]).toEqual([403, 'FORBIDDEN']);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── Validation ───────────────────────────────────────────────

describe('validation', () => {
  beforeEach(() => scriptRpc({}));

  test.each([
    ['no reason', {}],
    ['a reason under 5 characters', { reason: ' abcd ' }],
    ['a reason that is not text', { reason: 12345 }],
  ])('single delete refuses %s', async (_, body) => {
    const r = await request(app).post(`${BASE}/${BILL}/delete`).send(body);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('a malformed bill id is refused', async () => {
    const r = await request(app).post(`${BASE}/not-a-uuid/delete`).send({ reason: REASON });
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test.each([
    ['a missing date', { dateTo: '2026-09-13' }],
    ['a date in the wrong format', { dateFrom: '13/09/2026', dateTo: '2026-09-13' }],
    ['an impossible date', { dateFrom: '2026-02-30', dateTo: '2026-09-13' }],
  ])('range preview refuses %s', async (_, q) => {
    const r = await request(app).get(`${BASE}/delete-preview`).query(q);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });

  test.each([
    ['no expected_count', { ...RANGE, reason: REASON, expected_total: 250 }],
    ['expected_count 0', { ...RANGE, reason: REASON, expected_count: 0, expected_total: 250 }],
    ['no expected_total', { ...RANGE, reason: REASON, expected_count: 2 }],
    ['no reason', { ...RANGE, expected_count: 2, expected_total: 250 }],
  ])('range delete refuses %s', async (_, body) => {
    const r = await request(app).post(`${BASE}/delete-range`).send(body);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('a start date after the end date is refused before any RPC', async () => {
    const r = await request(app).get(`${BASE}/delete-preview`).query({ dateFrom: '2026-09-13', dateTo: '2026-09-01' });
    expect([r.status, r.body.error]).toEqual([422, 'INVALID_DATE_RANGE']);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── Service rules ────────────────────────────────────────────

describe('single bill', () => {
  test('preview of a bill that does not exist is 404', async () => {
    scriptRpc({ preview_bill_deletion: ok({ ...PREVIEW, bill_count: 0 }) });
    const r = await request(app).get(`${BASE}/${BILL}/delete-preview`);
    expect([r.status, r.body.error]).toEqual([404, 'BILL_NOT_FOUND']);
  });

  test('a bill with a return is refused with the return named, and the delete RPC is never called', async () => {
    scriptRpc({ preview_bill_deletion: ok({ ...PREVIEW, bill_count: 1, blocked: BLOCKED }) });
    const r = await request(app).post(`${BASE}/${BILL}/delete`).send({ reason: REASON });
    expect([r.status, r.body.error]).toEqual([409, 'BILL_HAS_RETURNS']);
    expect(r.body.details.blocked).toEqual(BLOCKED);
    expect(rpcNames()).not.toContain('delete_bill_atomic');
  });

  test('deletes with the actor from the session, never from the body', async () => {
    scriptRpc({
      preview_bill_deletion: ok({ ...PREVIEW, bill_count: 1 }),
      delete_bill_atomic: ok({ deleted_bills: 1, deleted_items: 2, total_amount: 120, bill_numbers: ['BILL-0009'] }),
    });
    const r = await request(app).post(`${BASE}/${BILL}/delete`)
      .send({ reason: `  ${REASON}  `, p_actor_id: 'someone-else', actor_id: 'someone-else' });

    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Deleted BILL-0009. Stock was not returned.');
    const [, args] = mockRpc.mock.calls.find(([fn]) => fn === 'delete_bill_atomic');
    expect(args).toMatchObject({ p_bill_id: BILL, p_actor_id: 'owner-1', p_reason: REASON });
  });

  test.each([
    ['BILL_HAS_RETURNS: raced', 409, 'BILL_HAS_RETURNS'],
    ['BILL_NOT_FOUND: raced', 404, 'BILL_NOT_FOUND'],
    ['FORBIDDEN: owner deactivated mid-request', 403, 'FORBIDDEN'],
    ['REASON_REQUIRED: whitespace', 422, 'REASON_REQUIRED'],
    ['something the map does not know', 500, 'DB_ERROR'],
  ])('an RPC raising "%s" answers %i %s', async (message, status, code) => {
    scriptRpc({ preview_bill_deletion: ok({ ...PREVIEW, bill_count: 1 }), delete_bill_atomic: raises(message) });
    const r = await request(app).post(`${BASE}/${BILL}/delete`).send({ reason: REASON });
    expect([r.status, r.body.error]).toEqual([status, code]);
  });
});

describe('date range', () => {
  const body = { ...RANGE, reason: REASON, expected_count: 2, expected_total: 250 };

  test('an empty range is 404 and the delete RPC is never called', async () => {
    scriptRpc({ bills_in_ist_range: ok([]), preview_bill_deletion: ok({ ...PREVIEW, bill_count: 0 }) });
    const r = await request(app).post(`${BASE}/delete-range`).send(body);
    expect([r.status, r.body.error]).toEqual([404, 'NO_BILLS_IN_RANGE']);
    expect(rpcNames()).not.toContain('delete_bills_in_range_atomic');
  });

  test('a range containing a returned bill is refused with the return named', async () => {
    scriptRpc({ bills_in_ist_range: ok([BILL]), preview_bill_deletion: ok({ ...PREVIEW, blocked: BLOCKED }) });
    const r = await request(app).post(`${BASE}/delete-range`).send(body);
    expect([r.status, r.body.error]).toEqual([409, 'BILL_HAS_RETURNS']);
    expect(r.body.details.blocked).toEqual(BLOCKED);
    expect(rpcNames()).not.toContain('delete_bills_in_range_atomic');
  });

  test('passes the confirmed count and total through to the RPC', async () => {
    scriptRpc({
      bills_in_ist_range: ok([BILL]),
      preview_bill_deletion: ok(PREVIEW),
      delete_bills_in_range_atomic: ok({ deleted_bills: 2, deleted_items: 3, total_amount: 250, bill_numbers: ['BILL-0001', 'BILL-0002'] }),
    });
    const r = await request(app).post(`${BASE}/delete-range`).send(body);

    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Deleted 2 bills. Stock was not returned.');
    const [, args] = mockRpc.mock.calls.find(([fn]) => fn === 'delete_bills_in_range_atomic');
    expect(args).toMatchObject({
      p_from: RANGE.dateFrom, p_to: RANGE.dateTo, p_actor_id: 'owner-1',
      p_reason: REASON, p_expected_count: 2, p_expected_total: 250,
    });
  });

  test.each([
    ['RANGE_CHANGED: a bill was rung up', 409, 'RANGE_CHANGED'],
    ['RANGE_TOO_LARGE: 1500 bills', 422, 'RANGE_TOO_LARGE'],
    ['NO_BILLS_IN_RANGE: all deleted meanwhile', 404, 'NO_BILLS_IN_RANGE'],
  ])('an RPC raising "%s" answers %i %s', async (message, status, code) => {
    scriptRpc({
      bills_in_ist_range: ok([BILL]),
      preview_bill_deletion: ok(PREVIEW),
      delete_bills_in_range_atomic: raises(message),
    });
    const r = await request(app).post(`${BASE}/delete-range`).send(body);
    expect([r.status, r.body.error]).toEqual([status, code]);
  });
});
