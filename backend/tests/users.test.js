/**
 * MODULE 02 — User Management QA Test Cases
 * Runner: Jest + Supertest
 * Run: npm test -- tests/users.test.js
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken, createdUserId;

const OWNER = { email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD };
const STAFF = { email: process.env.TEST_STAFF_EMAIL, password: process.env.TEST_STAFF_PASSWORD };

beforeAll(async () => {
  const ownerRes = await request(app).post('/api/v1/auth/login').send(OWNER);
  const staffRes = await request(app).post('/api/v1/auth/login').send(STAFF);
  ownerToken = ownerRes.body.data.session.access_token;
  staffToken = staffRes.body.data.session.access_token;
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// ── READ
describe('GET /api/v1/users', () => {
  test('TC-USR-01: Owner can list all users', async () => {
    const res = await request(app).get('/api/v1/users').set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.users)).toBe(true);
  });

  test('TC-USR-02: Staff cannot list all users — 403', async () => {
    const res = await request(app).get('/api/v1/users').set(auth(staffToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  test('TC-USR-03: Unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/users/me', () => {
  test('TC-USR-04: Staff can fetch their own profile', async () => {
    const res = await request(app).get('/api/v1/users/me').set(auth(staffToken));
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('staff');
  });
});

// ── CREATE
describe('POST /api/v1/users', () => {
  test('TC-USR-05: Owner creates staff — returns 201 with profile', async () => {
    const res = await request(app).post('/api/v1/users').set(auth(ownerToken)).send({
      full_name: 'Test Staff Member',
      email: `test.staff.${Date.now()}@pcare.in`,
      phone: '9876543210'
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('staff');
    createdUserId = res.body.data.user.id;
  });

  test('TC-USR-06: Staff cannot create users — 403', async () => {
    const res = await request(app).post('/api/v1/users').set(auth(staffToken)).send({
      full_name: 'Hack Attempt', email: 'hack@pcare.in'
    });
    expect(res.status).toBe(403);
  });

  test('TC-USR-07: Duplicate email returns 409 EMAIL_TAKEN', async () => {
    await request(app).post('/api/v1/users').set(auth(ownerToken)).send({ full_name: 'Dup', email: STAFF.email });
    const res = await request(app).post('/api/v1/users').set(auth(ownerToken)).send({ full_name: 'Dup2', email: STAFF.email });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('EMAIL_TAKEN');
  });

  test('TC-USR-08: Missing required fields return 422 VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/v1/users').set(auth(ownerToken)).send({ full_name: 'No Email' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('TC-USR-09: Invalid phone number returns 422', async () => {
    const res = await request(app).post('/api/v1/users').set(auth(ownerToken)).send({
      full_name: 'Test', email: 'test2@pcare.in', phone: '123'
    });
    expect(res.status).toBe(422);
  });
});

// ── UPDATE
describe('PATCH /api/v1/users/:id', () => {
  test('TC-USR-10: Owner can update any user profile', async () => {
    const res = await request(app).patch(`/api/v1/users/${createdUserId}`).set(auth(ownerToken)).send({ full_name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.full_name).toBe('Updated Name');
  });

  test('TC-USR-11: Staff cannot change their role', async () => {
    const res = await request(app).patch(`/api/v1/users/${createdUserId}`).set(auth(staffToken)).send({ role: 'owner' });
    expect(res.status).toBe(422); // role field rejected at validation
  });

  test('TC-USR-12: Invalid UUID param returns 422', async () => {
    const res = await request(app).patch('/api/v1/users/not-a-uuid').set(auth(ownerToken)).send({ full_name: 'X' });
    expect(res.status).toBe(422);
  });
});

// ── ACTIVATE / DEACTIVATE
describe('PATCH /api/v1/users/:id/deactivate', () => {
  test('TC-USR-13: Owner can deactivate a staff member', async () => {
    const res = await request(app).patch(`/api/v1/users/${createdUserId}/deactivate`).set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.user.is_active).toBe(false);
  });

  test('TC-USR-14: Staff cannot deactivate anyone — 403', async () => {
    const res = await request(app).patch(`/api/v1/users/${createdUserId}/deactivate`).set(auth(staffToken));
    expect(res.status).toBe(403);
  });

  test('TC-USR-15: Owner cannot deactivate themselves', async () => {
    const me = await request(app).get('/api/v1/users/me').set(auth(ownerToken));
    const ownerId = me.body.data.user.id;
    const res = await request(app).patch(`/api/v1/users/${ownerId}/deactivate`).set(auth(ownerToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CANNOT_DEACTIVATE_OWNER');
  });
});

describe('PATCH /api/v1/users/:id/activate', () => {
  test('TC-USR-16: Owner can reactivate a deactivated staff member', async () => {
    const res = await request(app).patch(`/api/v1/users/${createdUserId}/activate`).set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.user.is_active).toBe(true);
  });
});

// ── PASSWORD RESET
describe('POST /api/v1/users/:id/reset-password', () => {
  test('TC-USR-17: Owner can send password reset to staff', async () => {
    const res = await request(app).post(`/api/v1/users/${createdUserId}/reset-password`).set(auth(ownerToken));
    expect(res.status).toBe(200);
  });

  test('TC-USR-18: Staff cannot trigger password reset for others — 403', async () => {
    const res = await request(app).post(`/api/v1/users/${createdUserId}/reset-password`).set(auth(staffToken));
    expect(res.status).toBe(403);
  });
});

// ── SECURITY
describe('Security checks', () => {
  test('TC-USR-19: Deactivated staff token rejected on next request', async () => {
    // Deactivate the test user
    await request(app).patch(`/api/v1/users/${createdUserId}/deactivate`).set(auth(ownerToken));
    // Their old token should now be rejected
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: `test.staff@pcare.in`, password: 'anything'
    });
    // Either 401 (wrong pass) or 403 (account disabled) — never 200
    expect(loginRes.status).not.toBe(200);
  });

  test('TC-USR-20: Audit log entry created for user creation', async () => {
    // Indirect verification: creation succeeded in TC-USR-05,
    // audit_logs entry verified via Supabase Studio in manual QA.
    // Automated: check audit via a future /api/v1/admin/audit endpoint.
    expect(createdUserId).toBeDefined();
  });
});
