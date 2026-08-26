/**
 * AUTH — refresh identity and login rate limiting (hermetic: Supabase stubbed)
 * Runner: npx jest tests/auth-session.test.js --runInBand
 *
 * Needs backend/.env for config validation, but NO seeded users and no network.
 * Supabase Auth and the profile read are replaced with stubs, so this runs in
 * CI without secrets.
 *
 * Two defects are pinned here:
 *
 * 1. `/auth/refresh` used to return a token and nothing else. The refresh
 *    cookie is scoped to the ORIGIN, not to a browser tab, so a machine where
 *    two people have signed in has exactly one — and a tab refreshing against
 *    it can be handed a perfectly valid token belonging to the other person.
 *    Without an identity in the response the client cannot tell, adopts it, and
 *    silently records the next sale under the wrong name. That happened.
 *
 * 2. The login limiter keyed on IP and counted SUCCESSES, at max 5 per 15 min.
 *    The whole pharmacy shares one shop IP, so owner plus three staff arriving
 *    at opening could lock the building out of billing.
 */

jest.mock('../src/config/supabase', () => {
  const PROFILE = {
    id: 'user-abc', full_name: 'Asha', role: 'staff',
    is_active: true, phone: null, avatar_url: null,
  };
  const session = {
    access_token: 'new-access', refresh_token: 'new-refresh',
    expires_at: 1, expires_in: 3600, user: { id: PROFILE.id },
  };
  // Chainable enough for `.select().eq().single()` and `.insert()`.
  //
  // `table` matters for exactly one thing: utils/loginAttemptStore.js probes
  // for `login_attempts` once per process and picks its backend from the
  // answer. Answering 42P01 here selects the IN-MEMORY store, which is what
  // this suite wants — these two tests are about the limiter's POLICY (5 per
  // email+ip, 15 minutes, colleagues unaffected), and that policy is identical
  // whichever store holds the count. The shared Postgres store's own semantics
  // are covered by tests/unit/login-attempt-store.test.js.
  const chain = (table) => {
    const o = {};
    o.select = () => o; o.eq = () => o; o.order = () => o; o.limit = () => o;
    o.single = async () => ({ data: PROFILE, error: null });
    o.maybeSingle = async () => ({ data: PROFILE, error: null });
    o.insert = async () => ({ error: null });
    o.delete = () => ({ eq: async () => ({ error: null }) });
    o.then = (resolve, reject) => Promise.resolve(
      table === 'login_attempts'
        ? { data: null, error: { code: '42P01', message: 'relation "login_attempts" does not exist' } }
        : { data: [], error: null }
    ).then(resolve, reject);
    return o;
  };
  return {
    supabase: {
      from: (table) => chain(table),
      // Needed by middleware/authenticate.js so the lifecycle tests can call a
      // protected route with the token login actually issued.
      auth: {
        getUser: async (token) => (
          token === 'new-access'
            ? { data: { user: { id: PROFILE.id } }, error: null }
            : { data: { user: null }, error: { message: 'invalid JWT' } }
        ),
      },
      rpc: async () => ({ data: null, error: null }),
    },
    createAuthClient: () => ({
      auth: {
        signInWithPassword: async ({ password }) => (
          password === 'CorrectPass1'
            ? { data: { user: { id: PROFILE.id }, session }, error: null }
            : { data: null, error: { message: 'Invalid login credentials' } }
        ),
        refreshSession: async () => ({ data: { session, user: { id: PROFILE.id } }, error: null }),
        signOut: async () => ({}),
      },
    }),
  };
});

const request = require('supertest');
const app = require('../src/app');

// ── End-to-end session lifecycle ──────────────────────────────────────────
//
// The whole shape the frontend now depends on, exercised through the real
// Express app: sign in, use the token, reload (refresh from the cookie alone),
// sign out. The access token is memory-only in the browser, so the reload step
// is not a nicety — it is the ONLY way a session survives a page load, and if
// it regresses every user is signed out by pressing F5.

const cookiesFrom = (res) => res.headers['set-cookie'] || [];
const cookieValue = (res, name) => {
  const hit = cookiesFrom(res).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0].split('=')[1] : null;
};

describe('session lifecycle, end to end', () => {
  test('login issues an access token in the body and a refresh cookie only in the header', async () => {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'anita@pcare.test', password: 'CorrectPass1' });

    expect(r.status).toBe(200);
    expect(r.body.data.session.access_token).toBe('new-access');

    // The refresh token must NEVER appear in a body the frontend can read —
    // that is the entire reason it is safe from XSS.
    expect(JSON.stringify(r.body)).not.toContain('new-refresh');
    expect(r.body.data.session.refresh_token).toBeUndefined();

    const cookie = cookiesFrom(r).join(';');
    expect(cookie).toContain('pcare_refresh=new-refresh');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/auth');
  });

  test('the access token from login authenticates a protected request', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'anita@pcare.test', password: 'CorrectPass1' });

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.data.session.access_token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBe('user-abc');
  });

  test('a reload recovers a session from the cookie alone, with no bearer token', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'anita@pcare.test', password: 'CorrectPass1' });
    const refreshCookie = cookieValue(login, 'pcare_refresh');

    // Deliberately NO Authorization header: this is a fresh page load, and the
    // browser has nothing but the httpOnly cookie.
    const reload = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`pcare_refresh=${refreshCookie}`]);

    expect(reload.status).toBe(200);
    expect(reload.body.data.access_token).toBe('new-access');
    expect(reload.body.data.user_id).toBe('user-abc');

    // …and that recovered token works.
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${reload.body.data.access_token}`);
    expect(me.status).toBe(200);
  });

  test('logout clears the refresh cookie', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'anita@pcare.test', password: 'CorrectPass1' });

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${login.body.data.session.access_token}`);

    expect(out.status).toBe(200);
    const cleared = cookiesFrom(out).find((c) => c.startsWith('pcare_refresh='));
    // Express clearCookie emits the name with an empty value and a past expiry.
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/pcare_refresh=;/);
    expect(cleared).toContain('Path=/api/v1/auth');
  });

  test('concurrent refreshes are each answered independently — no shared-state race', async () => {
    // The client collapses these into one call (single-flight, covered in
    // frontend/src/lib/api.test.js). The server must still be correct if two
    // ever do arrive: each gets a complete, identity-bearing answer, and
    // neither returns a token belonging to the other caller.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/api/v1/auth/refresh').set('Cookie', ['pcare_refresh=some-refresh-token'])
      )
    );

    results.forEach((r) => {
      expect(r.status).toBe(200);
      expect(r.body.data.access_token).toBe('new-access');
      expect(r.body.data.user_id).toBe('user-abc');
      expect(cookiesFrom(r).join(';')).toContain('pcare_refresh=new-refresh');
    });
  });
});

// ── Refresh carries an identity ───────────────────────────────────────────

test('refresh returns WHOSE token it is, not just a token', async () => {
  const r = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Cookie', ['pcare_refresh=some-refresh-token']);

  expect(r.status).toBe(200);
  expect(r.body.data.access_token).toBe('new-access');
  // The field the client compares against the identity its tab believes it is.
  expect(r.body.data.user_id).toBe('user-abc');
});

test('refresh rotates the cookie so the next one does not fail', async () => {
  const r = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Cookie', ['pcare_refresh=some-refresh-token']);

  const setCookie = (r.headers['set-cookie'] || []).join(';');
  expect(setCookie).toContain('pcare_refresh=new-refresh');
  expect(setCookie).toContain('HttpOnly');
});

test('refresh without the cookie is 401, not a crash', async () => {
  const r = await request(app).post('/api/v1/auth/refresh');
  expect([r.status, r.body.error]).toEqual([401, 'REFRESH_TOKEN_INVALID']);
});

// ── Login rate limiting ───────────────────────────────────────────────────

test('a shift change does not exhaust the login budget', async () => {
  // Ten successful sign-ins in a row from one shop IP. Under the old
  // max:5-counting-successes limiter the sixth was a 429 and nobody could bill.
  for (let i = 0; i < 10; i++) {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `staff${i}@pcare.test`, password: 'CorrectPass1' });
    expect([i, r.status]).toEqual([i, 200]);
  }
});

test('one account locking itself out does not lock out the rest of the shop', async () => {
  // The per-account limiter in auth.service.js (email:ip, 5 attempts) is the
  // real brute-force control, and it is what should fire here.
  let locked = null;
  for (let i = 0; i < 6; i++) {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'butterfingers@pcare.test', password: 'WrongPass1' });
    if (r.status === 429) { locked = r.body; break; }
  }
  expect(locked).not.toBeNull();
  expect(locked.error).toBe('RATE_LIMITED');
  // Per-account, so it names a wait — the shop-wide backstop says something else.
  expect(locked.message).toMatch(/Too many failed attempts/);

  // The colleague standing next to them signs in perfectly normally.
  const other = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'colleague@pcare.test', password: 'CorrectPass1' });
  expect(other.status).toBe(200);
});

// ── The counter is no longer in this process, so it can now fail ──────────
//
// Moving the count into shared storage introduced a failure mode a Map never
// had. The `clear` call runs AFTER a correct password, so an unhandled throw
// there turns a SUCCESSFUL login into a 500 — the till stops for a problem that
// has nothing to do with the person standing at it.
//
// Fail-open is the right posture and is safe: nginx's login zone, the
// 40-per-15-minutes IP backstop in app.js and Supabase Auth itself all still
// stand. Fail-closed would mean a database blip locks the whole pharmacy out.

const attemptStore = require('../src/utils/loginAttemptStore');

const throwingStore = {
  name: 'broken',
  async read() { throw new Error('connection reset by peer'); },
  async increment() { throw new Error('connection reset by peer'); },
  async clear() { throw new Error('connection reset by peer'); },
};

describe('a broken login-attempt store fails open', () => {
  afterEach(() => attemptStore.setStore(null));

  test('a correct password still signs in when the store throws', async () => {
    attemptStore.setStore(throwingStore);
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'anita@pcare.test', password: 'CorrectPass1' });
    expect(r.status).toBe(200);
  });

  test('a wrong password is still rejected — 401, not 500', async () => {
    attemptStore.setStore(throwingStore);
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'anita@pcare.test', password: 'WrongPass1' });
    expect([r.status, r.body.error]).toEqual([401, 'INVALID_CREDENTIALS']);
  });
});
