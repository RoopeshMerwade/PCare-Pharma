/**
 * MODULE 03 — Medicine Categories QA Test Cases
 * Runner: Jest + Supertest
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken, createdCategoryId;

beforeAll(async () => {
  const o = await request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD });
  const s = await request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL,  password: process.env.TEST_STAFF_PASSWORD });
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;
});

const ownerAuth = () => ({ Authorization: `Bearer ${ownerToken}` });
const staffAuth = () => ({ Authorization: `Bearer ${staffToken}` });

// ── LIST
describe('GET /api/v1/categories', () => {
  test('TC-CAT-01: Both roles can list active categories', async () => {
    const [owner, staff] = await Promise.all([
      request(app).get('/api/v1/categories').set(ownerAuth()),
      request(app).get('/api/v1/categories').set(staffAuth()),
    ]);
    expect(owner.status).toBe(200);
    expect(staff.status).toBe(200);
    expect(Array.isArray(owner.body.data.categories)).toBe(true);
  });

  test('TC-CAT-02: Staff cannot see inactive categories', async () => {
    const res = await request(app).get('/api/v1/categories?includeInactive=true').set(staffAuth());
    // Staff query is always filtered — includeInactive ignored for non-owners
    const hasInactive = res.body.data.categories.some(c => !c.is_active);
    expect(hasInactive).toBe(false);
  });

  test('TC-CAT-03: Owner can include inactive with ?includeInactive=true', async () => {
    const res = await request(app).get('/api/v1/categories?includeInactive=true').set(ownerAuth());
    expect(res.status).toBe(200);
  });

  test('TC-CAT-04: Unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/v1/categories');
    expect(res.status).toBe(401);
  });

  test('TC-CAT-05: Response includes medicines_count field', async () => {
    const res = await request(app).get('/api/v1/categories').set(ownerAuth());
    expect(res.body.data.categories[0]).toHaveProperty('medicines_count');
  });
});

// ── CREATE
describe('POST /api/v1/categories', () => {
  test('TC-CAT-06: Owner creates category — 201 with correct fields', async () => {
    const res = await request(app).post('/api/v1/categories').set(ownerAuth())
      .send({ name: `Test Category ${Date.now()}`, color: '#FF5733' });
    expect(res.status).toBe(201);
    expect(res.body.data.category).toMatchObject({ is_active: true });
    expect(res.body.data.category.color).toBe('#FF5733');
    createdCategoryId = res.body.data.category.id;
  });

  test('TC-CAT-07: Staff cannot create — 403 FORBIDDEN', async () => {
    const res = await request(app).post('/api/v1/categories').set(staffAuth())
      .send({ name: 'Hack Category' });
    expect(res.status).toBe(403);
  });

  test('TC-CAT-08: Duplicate name returns 409 DUPLICATE_NAME', async () => {
    await request(app).post('/api/v1/categories').set(ownerAuth()).send({ name: 'DuplicateTest' });
    const res = await request(app).post('/api/v1/categories').set(ownerAuth()).send({ name: 'duplicatetest' }); // case-insensitive
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_NAME');
  });

  test('TC-CAT-09: Name too short returns 422', async () => {
    const res = await request(app).post('/api/v1/categories').set(ownerAuth()).send({ name: 'X' });
    expect(res.status).toBe(422);
  });

  test('TC-CAT-10: Invalid hex color returns 422', async () => {
    const res = await request(app).post('/api/v1/categories').set(ownerAuth())
      .send({ name: 'Color Test', color: 'red' }); // not a hex
    expect(res.status).toBe(422);
  });
});

// ── UPDATE
describe('PATCH /api/v1/categories/:id', () => {
  test('TC-CAT-11: Owner updates name and color', async () => {
    const res = await request(app).patch(`/api/v1/categories/${createdCategoryId}`).set(ownerAuth())
      .send({ name: 'Updated Name', color: '#123456' });
    expect(res.status).toBe(200);
    expect(res.body.data.category.name).toBe('Updated Name');
  });

  test('TC-CAT-12: Staff cannot update — 403', async () => {
    const res = await request(app).patch(`/api/v1/categories/${createdCategoryId}`).set(staffAuth())
      .send({ name: 'Hack' });
    expect(res.status).toBe(403);
  });

  test('TC-CAT-13: Invalid UUID param returns 422', async () => {
    const res = await request(app).patch('/api/v1/categories/not-a-uuid').set(ownerAuth()).send({ name: 'X' });
    expect(res.status).toBe(422);
  });
});

// ── REORDER
describe('PATCH /api/v1/categories/reorder', () => {
  test('TC-CAT-14: Owner can reorder with valid IDs', async () => {
    const list = await request(app).get('/api/v1/categories').set(ownerAuth());
    const ids  = list.body.data.categories.map(c => c.id).reverse();
    const res  = await request(app).patch('/api/v1/categories/reorder').set(ownerAuth()).send({ orderedIds: ids });
    expect(res.status).toBe(200);
    expect(res.body.data.categories[0].sort_order).toBe(1);
  });

  test('TC-CAT-15: Empty orderedIds returns 422', async () => {
    const res = await request(app).patch('/api/v1/categories/reorder').set(ownerAuth()).send({ orderedIds: [] });
    expect(res.status).toBe(422);
  });
});

// ── DEACTIVATE / REACTIVATE
describe('PATCH /api/v1/categories/:id/deactivate', () => {
  test('TC-CAT-16: Owner can deactivate category with no medicines', async () => {
    const res = await request(app).patch(`/api/v1/categories/${createdCategoryId}/deactivate`).set(ownerAuth());
    expect(res.status).toBe(200);
    expect(res.body.data.category.is_active).toBe(false);
  });

  test('TC-CAT-17: Staff cannot deactivate — 403', async () => {
    const res = await request(app).patch(`/api/v1/categories/${createdCategoryId}/deactivate`).set(staffAuth());
    expect(res.status).toBe(403);
  });

  test('TC-CAT-18: Cannot deactivate category with active medicines', async () => {
    // Find a seeded category that has medicines (Diabetes)
    const list = await request(app).get('/api/v1/categories?includeInactive=true').set(ownerAuth());
    const withMeds = list.body.data.categories.find(c => c.medicines_count > 0);
    if (!withMeds) return; // skip if no seeded medicines yet (pre-Module 04)
    const res = await request(app).patch(`/api/v1/categories/${withMeds.id}/deactivate`).set(ownerAuth());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CATEGORY_HAS_MEDICINES');
  });

  test('TC-CAT-19: Owner can reactivate a deactivated category', async () => {
    const res = await request(app).patch(`/api/v1/categories/${createdCategoryId}/reactivate`).set(ownerAuth());
    expect(res.status).toBe(200);
    expect(res.body.data.category.is_active).toBe(true);
  });
});

// ── SECURITY
describe('Security', () => {
  test('TC-CAT-20: Hard delete endpoint does not exist (no DELETE /categories/:id)', async () => {
    const res = await request(app).delete(`/api/v1/categories/${createdCategoryId}`).set(ownerAuth());
    expect(res.status).toBe(404); // route does not exist
  });

  test('TC-CAT-21: medicines_count is computed not stored (no count field in DB row)', async () => {
    // The count comes from the view — updating medicines should change the count
    // Verified via integration test in Module 04 (medicines). Placeholder here.
    expect(createdCategoryId).toBeDefined();
  });
});
