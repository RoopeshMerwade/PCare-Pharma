/**
 * SECURITY — the authenticate middleware itself (hermetic: Supabase stubbed)
 * Runner: npx jest tests/authentication.test.js --runInBand
 *
 * Needs backend/.env for config validation, but NO seeded users and no network.
 *
 * Unlike tests/authorization.test.js, this suite deliberately does NOT stub
 * `authenticate` — it is the thing under test. Only Supabase is replaced, so
 * every branch of middleware/authenticate.js is exercised for real: the header
 * parse, `auth.getUser()`, and the fresh profile read that catches an account
 * suspended mid-session.
 *
 * That fresh read is the branch most worth pinning. A JWT stays cryptographically
 * valid for its full hour, so without re-reading `is_active` on every request a
 * staff member deactivated at 10:05 keeps billing until 11:00.
 */

const VALID   = 'valid-token';
const EXPIRED = 'expired-token';
const GARBAGE = 'garbage-token';
const SUSPENDED_USER = 'suspended-token';

const mockProfiles = {
  'user-active':    { id: 'user-active', full_name: 'Anita Rao', role: 'staff', is_active: true },
  'user-suspended': { id: 'user-suspended', full_name: 'Ex Staff', role: 'staff', is_active: false },
};

jest.mock('../src/config/supabase', () => {
  const tokenToUser = {
    'valid-token': 'user-active',
    'suspended-token': 'user-suspended',
  };

  const build = () => {
    const q = { _id: null };
    const chain = () => q;
    q.select = chain; q.order = chain; q.limit = chain; q.or = chain;
    q.eq = (col, val) => { if (col === 'id') q._id = val; return q; };
    q.single = async () => {
      const row = mockProfiles[q._id] || null;
      return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
    };
    q.maybeSingle = q.single;
    q.then = (resolve, reject) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    return q;
  };

  return {
    supabase: {
      from: () => build(),
      rpc: async () => ({ data: null, error: null }),
      storage: { from: () => ({}) },
      auth: {
        // Mirrors supabase-js: an unrecognised or expired JWT resolves with an
        // error rather than throwing.
        getUser: async (token) => {
          const id = tokenToUser[token];
          if (!id) return { data: { user: null }, error: { message: 'invalid JWT' } };
          return { data: { user: { id } }, error: null };
        },
      },
    },
    createAuthClient: () => ({ auth: {} }),
  };
});

const request = require('supertest');
const app = require('../src/app');

// /auth/me is the smallest protected surface: `authenticate` and nothing else.
const PROTECTED = '/api/v1/auth/me';

describe('missing or malformed credentials', () => {
  test('no Authorization header → 401 TOKEN_MISSING', async () => {
    const r = await request(app).get(PROTECTED);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('TOKEN_MISSING');
  });

  test('a non-Bearer scheme → 401 TOKEN_MISSING', async () => {
    const r = await request(app).get(PROTECTED).set('Authorization', `Basic ${VALID}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('TOKEN_MISSING');
  });

  test('the literal word Bearer with no token → 401', async () => {
    const r = await request(app).get(PROTECTED).set('Authorization', 'Bearer ');
    expect(r.status).toBe(401);
  });
});

describe('invalid and expired tokens', () => {
  test('a token Supabase does not recognise → 401 TOKEN_INVALID', async () => {
    const r = await request(app).get(PROTECTED).set('Authorization', `Bearer ${GARBAGE}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('TOKEN_INVALID');
  });

  test('an expired token → 401 TOKEN_INVALID', async () => {
    const r = await request(app).get(PROTECTED).set('Authorization', `Bearer ${EXPIRED}`);
    expect(r.status).toBe(401);
    // The exact code matters: frontend/src/lib/api.js triggers its silent
    // refresh on `401 && error === 'TOKEN_INVALID'` and on nothing else.
    // Renaming this breaks automatic re-authentication for every user.
    expect(r.body.error).toBe('TOKEN_INVALID');
  });
});

describe('account suspended mid-session', () => {
  test('a cryptographically valid token for a deactivated account → 403 ACCOUNT_SUSPENDED', async () => {
    const r = await request(app).get(PROTECTED).set('Authorization', `Bearer ${SUSPENDED_USER}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ACCOUNT_SUSPENDED');
  });

  test('an active account passes', async () => {
    const r = await request(app).get(PROTECTED).set('Authorization', `Bearer ${VALID}`);
    expect(r.status).toBe(200);
    expect(r.body.data.user.id).toBe('user-active');
  });
});

describe('every protected router is actually behind authenticate', () => {
  // If a router loses `router.use(authenticate)`, its handlers start seeing an
  // undefined req.user — which is exactly the state utils/authz.js fails closed
  // on, but only for the two services that call it. This catches the rest.
  const PROTECTED_ROOTS = [
    '/api/v1/billing',
    '/api/v1/customer-returns',
    '/api/v1/medicines',
    '/api/v1/inventory',
    '/api/v1/customers',
    '/api/v1/notifications',
    '/api/v1/supplier-invoices',
    '/api/v1/users',
    '/api/v1/purchases',
    '/api/v1/suppliers',
    '/api/v1/categories',
    '/api/v1/settings',
    '/api/v1/audit-logs',
    '/api/v1/attendance/today',
    '/api/v1/expiry/dashboard',
    '/api/v1/reports/margins',
    '/api/v1/dashboard/staff',
    '/api/v1/supplier-returns',
    '/api/v1/chronic-care/overdue',
  ];

  test.each(PROTECTED_ROOTS)('GET %s without a token → 401', async (path) => {
    const r = await request(app).get(path);
    expect(r.status).toBe(401);
  });
});

describe('public auth endpoints stay reachable without a token', () => {
  test.each([
    ['/api/v1/auth/login'],
    ['/api/v1/auth/refresh'],
    ['/api/v1/auth/forgot-password'],
  ])('POST %s is not 401', async (path) => {
    const r = await request(app).post(path).send({});
    // They may answer 422 (nothing in the body) or 401 (bad credentials) —
    // the point is only that `authenticate` did not reject them outright.
    expect(r.body.error).not.toBe('TOKEN_MISSING');
  });

  test('/health needs no credentials at all', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
  });
});
