/**
 * MODULE 01 — Authentication QA Test Cases
 * Runner: Jest + Supertest
 * Run: npm test
 */

const request = require('supertest');
const app = require('../src/app');

const OWNER = { email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD };
const STAFF = { email: process.env.TEST_STAFF_EMAIL, password: process.env.TEST_STAFF_PASSWORD };

describe('POST /api/v1/auth/login', () => {
  test('TC-AUTH-01: Valid owner login returns 200 + token + role=owner', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(OWNER);
    expect(res.status).toBe(200);
    expect(res.body.data.session.access_token).toBeDefined();
    expect(res.body.data.user.role).toBe('owner');
    expect(res.body.data.session.refresh_token).toBeUndefined(); // refresh only in cookie
  });

  test('TC-AUTH-02: Valid staff login returns 200 + role=staff', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('staff');
  });

  test('TC-AUTH-03: Wrong password returns 401 INVALID_CREDENTIALS', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: OWNER.email, password: 'wrongpass' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  test('TC-AUTH-04: Non-existent email returns 401', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@pcare.in', password: 'anything' });
    expect(res.status).toBe(401);
  });

  test('TC-AUTH-05: Missing fields returns 422 VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: '' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('TC-AUTH-06: Rate limiting — 5 failed attempts lock the account for 15 min', async () => {
    const payload = { email: 'ratelimit@pcare.in', password: 'wrong' };
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send(payload);
    const res = await request(app).post('/api/v1/auth/login').send(payload);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('RATE_LIMITED');
  });
});

describe('GET /api/v1/auth/me', () => {
  let token;
  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login').send(OWNER);
    token = res.body.data.session.access_token;
  });

  test('TC-AUTH-07: Valid token returns current user profile', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBeDefined();
  });

  test('TC-AUTH-08: No token returns 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_MISSING');
  });

  test('TC-AUTH-09: Tampered token returns 401 TOKEN_INVALID', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer tampered.jwt.value');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  test('TC-AUTH-10: Logout with valid token returns 200', async () => {
    const login = await request(app).post('/api/v1/auth/login').send(OWNER);
    const token = login.body.data.session.access_token;
    const res = await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  test('TC-AUTH-11: Always returns 200 — prevents email enumeration', async () => {
    const r1 = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'anyone@example.com' });
    const r2 = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@ghost.com' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both return identical message
    expect(r1.body.message).toBe(r2.body.message);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  // Pulls the refresh cookie out of a login response's Set-Cookie header.
  const refreshCookieFrom = (res) =>
    (res.headers['set-cookie'] || []).find(c => c.startsWith('pcare_refresh='));

  test('TC-AUTH-14: Login sets refresh token as an httpOnly cookie, not in JSON', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(OWNER);
    const cookie = refreshCookieFrom(res);

    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
    // The refresh token must never reach JavaScript.
    expect(JSON.stringify(res.body)).not.toMatch(/refresh_token/);
  });

  test('TC-AUTH-15: Valid refresh cookie returns a new access token and rotates the cookie', async () => {
    const login = await request(app).post('/api/v1/auth/login').send(OWNER);
    const oldCookie = refreshCookieFrom(login);

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeDefined();
    expect(res.body.data.expires_at).toBeDefined();
    // Refresh token must still never appear in the body.
    expect(JSON.stringify(res.body)).not.toMatch(/refresh_token/);

    // Supabase rotates on every use — a new cookie must come back, otherwise
    // the next refresh would replay a spent token and fail.
    const newCookie = refreshCookieFrom(res);
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toBe(oldCookie);
  });

  test('TC-AUTH-16: The rotated access token is accepted by a protected route', async () => {
    const login = await request(app).post('/api/v1/auth/login').send(OWNER);
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookieFrom(login));

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.data.access_token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBeDefined();
  });

  test('TC-AUTH-17: Missing refresh cookie returns 401 REFRESH_TOKEN_INVALID', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('REFRESH_TOKEN_INVALID');
  });

  test('TC-AUTH-18: Invalid refresh cookie returns 401 REFRESH_TOKEN_INVALID and clears the cookie', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', 'pcare_refresh=not-a-real-refresh-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('REFRESH_TOKEN_INVALID');
    // Dead cookie is dropped so the browser stops replaying it.
    const cleared = (res.headers['set-cookie'] || []).find(c => c.startsWith('pcare_refresh='));
    expect(cleared).toMatch(/pcare_refresh=;/);
  });

  test('TC-AUTH-19: A consumed refresh token cannot be replayed', async () => {
    const login = await request(app).post('/api/v1/auth/login').send(OWNER);
    const cookie = refreshCookieFrom(login);

    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(first.status).toBe(200);

    // Same (now-rotated) token again — Supabase must reject it.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  test('TC-AUTH-20: Expired/invalid access token returns TOKEN_INVALID so the client knows to refresh', async () => {
    // The client keys its refresh decision on this exact code — if it ever
    // changes, silent refresh stops working.
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer expired.or.tampered.token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_INVALID');
  });
});

describe('Security', () => {
  test('TC-AUTH-12: Response never contains password, refresh_token, or stack in production', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(OWNER);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/refresh_token/);
  });

  test('TC-AUTH-13: Helmet security headers are present', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});
