/**
 * MODULE 04 — Medicines QA Test Cases
 * Runner: Jest + Supertest
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken, createdMedicineId, seedCategoryId;

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL,  password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;

  // Get a real category ID from seed data
  const cats = await request(app).get('/api/v1/categories').set({ Authorization: `Bearer ${ownerToken}` });
  seedCategoryId = cats.body.data.categories[0]?.id;
});

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

const newMed = (overrides = {}) => ({
  name: `Test Med ${Date.now()}`,
  generic_name: 'Test Generic',
  manufacturer: 'Test Pharma',
  category_id: seedCategoryId,
  unit: 'strips',
  default_selling_price: 50.00,
  low_stock_threshold: 20,
  ...overrides
});

// ── LIST
describe('GET /api/v1/medicines', () => {
  test('TC-MED-01: Both roles can list medicines', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/medicines').set(oa()),
      request(app).get('/api/v1/medicines').set(sa()),
    ]);
    expect(o.status).toBe(200);
    expect(s.status).toBe(200);
    expect(Array.isArray(o.body.data.medicines)).toBe(true);
  });

  test('TC-MED-02: Response includes total_stock and is_low_stock fields', async () => {
    const res = await request(app).get('/api/v1/medicines').set(oa());
    if (res.body.data.medicines.length > 0) {
      const m = res.body.data.medicines[0];
      expect(m).toHaveProperty('total_stock');
      expect(m).toHaveProperty('is_low_stock');
      expect(m).toHaveProperty('category_name');
      expect(m).toHaveProperty('category_color');
    }
  });

  test('TC-MED-03: Filter by categoryId returns only that category', async () => {
    const res = await request(app).get(`/api/v1/medicines?categoryId=${seedCategoryId}`).set(oa());
    expect(res.status).toBe(200);
    res.body.data.medicines.forEach(m => expect(m.category_id).toBe(seedCategoryId));
  });

  test('TC-MED-04: stock=low filter returns only low-stock medicines', async () => {
    const res = await request(app).get('/api/v1/medicines?stock=low').set(oa());
    expect(res.status).toBe(200);
    res.body.data.medicines.forEach(m => expect(m.is_low_stock).toBe(true));
  });

  test('TC-MED-05: Pagination works — page and limit respected', async () => {
    const res = await request(app).get('/api/v1/medicines?page=1&limit=2').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.medicines.length).toBeLessThanOrEqual(2);
    expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 2 });
  });

  test('TC-MED-06: Unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/v1/medicines');
    expect(res.status).toBe(401);
  });
});

// ── SEARCH
describe('GET /api/v1/medicines/search', () => {
  test('TC-MED-07: Search by name returns relevant results', async () => {
    const res = await request(app).get('/api/v1/medicines/search?q=metformin').set(sa());
    expect(res.status).toBe(200);
    expect(res.body.data.medicines.some(m => m.name.toLowerCase().includes('metformin'))).toBe(true);
  });

  test('TC-MED-08: Empty query returns 422', async () => {
    const res = await request(app).get('/api/v1/medicines/search').set(sa());
    expect(res.status).toBe(422);
  });

  test('TC-MED-09: Search results include total_stock for billing', async () => {
    const res = await request(app).get('/api/v1/medicines/search?q=paracetamol').set(sa());
    if (res.body.data.medicines.length > 0) {
      expect(res.body.data.medicines[0]).toHaveProperty('total_stock');
    }
  });
});

// ── CREATE
describe('POST /api/v1/medicines', () => {
  test('TC-MED-10: Owner creates medicine — 201 with all fields', async () => {
    const payload = newMed();
    const res = await request(app).post('/api/v1/medicines').set(oa()).send(payload);
    expect(res.status).toBe(201);
    expect(res.body.data.medicine).toMatchObject({ name: payload.name, unit: 'strips', is_active: true });
    createdMedicineId = res.body.data.medicine.id;
  });

  test('TC-MED-11: Staff cannot create — 403', async () => {
    const res = await request(app).post('/api/v1/medicines').set(sa()).send(newMed());
    expect(res.status).toBe(403);
  });

  test('TC-MED-12: Duplicate name+manufacturer returns 409 DUPLICATE_MEDICINE', async () => {
    const payload = newMed({ name: 'Dup Med Unique', manufacturer: 'Dup Pharma' });
    await request(app).post('/api/v1/medicines').set(oa()).send(payload);
    const res = await request(app).post('/api/v1/medicines').set(oa()).send(payload);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_MEDICINE');
  });

  test('TC-MED-13: Missing required fields returns 422', async () => {
    const res = await request(app).post('/api/v1/medicines').set(oa()).send({ name: 'No Category' });
    expect(res.status).toBe(422);
  });

  test('TC-MED-14: Invalid unit returns 422', async () => {
    const res = await request(app).post('/api/v1/medicines').set(oa()).send(newMed({ unit: 'tablets' }));
    expect(res.status).toBe(422);
  });

  test('TC-MED-15: Negative price returns 422', async () => {
    const res = await request(app).post('/api/v1/medicines').set(oa()).send(newMed({ default_selling_price: -10 }));
    expect(res.status).toBe(422);
  });

  test('TC-MED-16: Inactive category rejected — 409 CATEGORY_INACTIVE', async () => {
    // Create a category and deactivate it
    const catRes = await request(app).post('/api/v1/categories').set(oa()).send({ name: `Inactive Cat ${Date.now()}` });
    const catId = catRes.body.data.category.id;
    await request(app).patch(`/api/v1/categories/${catId}/deactivate`).set(oa());
    const res = await request(app).post('/api/v1/medicines').set(oa()).send(newMed({ category_id: catId }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CATEGORY_INACTIVE');
  });
});

// ── UPDATE
describe('PATCH /api/v1/medicines/:id', () => {
  test('TC-MED-17: Owner updates medicine fields', async () => {
    const res = await request(app).patch(`/api/v1/medicines/${createdMedicineId}`).set(oa())
      .send({ default_selling_price: 75.00, low_stock_threshold: 30 });
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.data.medicine.default_selling_price)).toBe(75.00);
    expect(res.body.data.medicine.low_stock_threshold).toBe(30);
  });

  test('TC-MED-18: Staff cannot update — 403', async () => {
    const res = await request(app).patch(`/api/v1/medicines/${createdMedicineId}`).set(sa()).send({ description: 'Hack' });
    expect(res.status).toBe(403);
  });

  test('TC-MED-19: is_active cannot be set via PATCH /:id — 422', async () => {
    const res = await request(app).patch(`/api/v1/medicines/${createdMedicineId}`).set(oa()).send({ is_active: false });
    expect(res.status).toBe(422);
  });
});

// ── DEACTIVATE / REACTIVATE
describe('PATCH /api/v1/medicines/:id/deactivate', () => {
  test('TC-MED-20: Owner deactivates medicine', async () => {
    const res = await request(app).patch(`/api/v1/medicines/${createdMedicineId}/deactivate`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.medicine.is_active).toBe(false);
  });

  test('TC-MED-21: Deactivated medicine absent from default list', async () => {
    const res = await request(app).get('/api/v1/medicines').set(sa());
    const found = res.body.data.medicines.find(m => m.id === createdMedicineId);
    expect(found).toBeUndefined();
  });

  test('TC-MED-22: Owner sees deactivated with ?includeInactive=true', async () => {
    const res = await request(app).get(`/api/v1/medicines?includeInactive=true`).set(oa());
    const found = res.body.data.medicines.find(m => m.id === createdMedicineId);
    expect(found).toBeDefined();
    expect(found.is_active).toBe(false);
  });

  test('TC-MED-23: Owner reactivates medicine', async () => {
    const res = await request(app).patch(`/api/v1/medicines/${createdMedicineId}/reactivate`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.medicine.is_active).toBe(true);
  });
});

// ── ALERTS
describe('GET /api/v1/medicines/alerts', () => {
  test('TC-MED-24: Owner can fetch low-stock alerts', async () => {
    const res = await request(app).get('/api/v1/medicines/alerts/low-stock').set(oa());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.alerts)).toBe(true);
  });

  test('TC-MED-25: Staff cannot fetch alerts — 403', async () => {
    const res = await request(app).get('/api/v1/medicines/alerts/low-stock').set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-MED-26: Owner can fetch near-expiry alerts', async () => {
    const res = await request(app).get('/api/v1/medicines/alerts/near-expiry').set(oa());
    expect(res.status).toBe(200);
  });
});

// ── SECURITY
describe('Security checks', () => {
  test('TC-MED-27: Hard DELETE route does not exist', async () => {
    const res = await request(app).delete(`/api/v1/medicines/${createdMedicineId}`).set(oa());
    expect(res.status).toBe(404);
  });

  test('TC-MED-28: total_stock is computed not stored — no stock field in medicines table', async () => {
    // Verify via /get one: if stock data is absent after no purchases, total_stock = 0
    const res = await request(app).get(`/api/v1/medicines/${createdMedicineId}`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.medicine.total_stock).toBe(0); // no batches yet
  });

  test('TC-MED-29: created_by set from JWT — not from request body', async () => {
    const payload = newMed({ created_by: '00000000-0000-0000-0000-000000000000' }); // try to spoof
    const res = await request(app).post('/api/v1/medicines').set(oa()).send(payload);
    expect(res.status).toBe(201); // succeeds
    // created_by should be the actual owner's ID, not the spoofed one
    const med = await request(app).get(`/api/v1/medicines/${res.body.data.medicine.id}`).set(oa());
    expect(med.body.data.medicine.created_by).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  test('TC-MED-30: Both roles can fetch generic alternatives for a medicine', async () => {
    if (createdMedicineId) {
      const [o, s] = await Promise.all([
        request(app).get(`/api/v1/medicines/${createdMedicineId}/alternatives`).set(oa()),
        request(app).get(`/api/v1/medicines/${createdMedicineId}/alternatives`).set(sa()),
      ]);
      expect(o.status).toBe(200);
      expect(s.status).toBe(200);
      expect(o.body.data).toHaveProperty('target');
      expect(o.body.data).toHaveProperty('alternatives');
      expect(Array.isArray(o.body.data.alternatives)).toBe(true);
    }
  });
});
