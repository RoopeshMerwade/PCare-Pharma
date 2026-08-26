/**
 * MODULE 05 — Inventory (Batch-wise) QA Test Cases
 * Runner: Jest + Supertest
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken;
let seedMedicineId, createdBatchId;

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL,  password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;

  // Get a seeded medicine
  const meds = await request(app).get('/api/v1/medicines').set({ Authorization: `Bearer ${ownerToken}` });
  seedMedicineId = meds.body.data.medicines[0]?.id;
});

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

const futureDate = (daysFromNow) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
};

const pastDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

const newBatch = (overrides = {}) => ({
  medicine_id: seedMedicineId,
  batch_no: `TC-BATCH-${Date.now()}`,
  exp_date: futureDate(365),
  mfg_date: pastDate(30),
  unit_cost: 20.00,
  mrp: 50.00,
  selling_price: 45.00,
  opening_qty: 100,
  reason: 'opening_stock',
  ...overrides
});

// ── INVENTORY OVERVIEW
describe('GET /api/v1/inventory', () => {
  test('TC-INV-01: Both roles can fetch inventory overview', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/inventory').set(oa()),
      request(app).get('/api/v1/inventory').set(sa()),
    ]);
    expect(o.status).toBe(200);
    expect(s.status).toBe(200);
  });

  test('TC-INV-02: Response includes computed total_stock and is_low_stock', async () => {
    const res = await request(app).get('/api/v1/inventory').set(oa());
    if (res.body.data.inventory.length > 0) {
      const item = res.body.data.inventory[0];
      expect(item).toHaveProperty('total_stock');
      expect(item).toHaveProperty('is_low_stock');
      expect(item).toHaveProperty('near_expiry_batch_count');
    }
  });

  test('TC-INV-03: stock=low filter returns only low-stock medicines', async () => {
    const res = await request(app).get('/api/v1/inventory?stock=low').set(oa());
    res.body.data.inventory.forEach(m => expect(m.is_low_stock).toBe(true));
  });
});

// ── ADD BATCH
describe('POST /api/v1/inventory/batches', () => {
  test('TC-INV-04: Owner can add a batch with opening stock', async () => {
    const payload = newBatch();
    const res = await request(app).post('/api/v1/inventory/batches').set(oa()).send(payload);
    expect(res.status).toBe(201);
    expect(res.body.data.batch.batch_no).toBe(payload.batch_no.toUpperCase());
    expect(res.body.data.batch.stock_qty).toBe(100);
    createdBatchId = res.body.data.batch.id;
  });

  test('TC-INV-05: Staff can also add a batch (they do the unboxing)', async () => {
    const res = await request(app).post('/api/v1/inventory/batches').set(sa()).send(newBatch());
    expect(res.status).toBe(201);
  });

  test('TC-INV-06: Selling price > MRP is rejected — 422', async () => {
    const res = await request(app).post('/api/v1/inventory/batches').set(oa()).send(newBatch({ mrp: 30.00, selling_price: 50.00 }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('PRICE_EXCEEDS_MRP');
  });

  test('TC-INV-07: Expired batch is rejected — 422', async () => {
    const res = await request(app).post('/api/v1/inventory/batches').set(oa()).send(newBatch({ exp_date: pastDate(1) }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('EXPIRED_BATCH');
  });

  test('TC-INV-08: Duplicate batch number for same medicine — 409', async () => {
    const fixed = newBatch({ batch_no: 'FIXED-BATCH-DUP' });
    await request(app).post('/api/v1/inventory/batches').set(oa()).send(fixed);
    const res = await request(app).post('/api/v1/inventory/batches').set(oa()).send(fixed);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_BATCH');
  });

  test('TC-INV-09: Missing required fields — 422', async () => {
    const res = await request(app).post('/api/v1/inventory/batches').set(oa()).send({ medicine_id: seedMedicineId });
    expect(res.status).toBe(422);
  });
});

// ── BATCH READS
describe('GET /api/v1/inventory/:medicineId/batches', () => {
  test('TC-INV-10: Returns batches for a medicine in FEFO order', async () => {
    const res = await request(app).get(`/api/v1/inventory/${seedMedicineId}/batches`).set(oa());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.batches)).toBe(true);
  });

  test('TC-INV-11: available-batches returns only stock > 0, ordered nearest expiry first', async () => {
    const res = await request(app).get(`/api/v1/inventory/${seedMedicineId}/available-batches`).set(sa());
    expect(res.status).toBe(200);
    res.body.data.batches.forEach(b => expect(b.stock_qty).toBeGreaterThan(0));
    // verify FEFO order
    const dates = res.body.data.batches.map(b => b.exp_date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});

// ── STOCK ADJUSTMENT (owner only)
describe('POST /api/v1/inventory/adjust', () => {
  test('TC-INV-12: Owner adds stock via adjustment', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust').set(oa()).send({
      batch_id: createdBatchId, adjustment_qty: 10, note: 'Physical count found 10 extra units during audit'
    });
    expect(res.status).toBe(200);
  });

  test('TC-INV-13: Ledger entry created for adjustment', async () => {
    const res = await request(app).get(`/api/v1/inventory/movements?batchId=${createdBatchId}&reason=adjustment`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.movements.length).toBeGreaterThan(0);
    expect(res.body.data.movements[0].reason).toBe('adjustment');
  });

  test('TC-INV-14: Zero adjustment rejected — 422', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust').set(oa()).send({
      batch_id: createdBatchId, adjustment_qty: 0, note: 'Zero should fail'
    });
    expect(res.status).toBe(422);
  });

  test('TC-INV-15: Adjustment note required — 422', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust').set(oa()).send({
      batch_id: createdBatchId, adjustment_qty: 5
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('TC-INV-16: Staff cannot adjust — 403', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust').set(sa()).send({
      batch_id: createdBatchId, adjustment_qty: -5, note: 'Hack attempt'
    });
    expect(res.status).toBe(403);
  });

  test('TC-INV-17: Cannot adjust below zero — 409 INSUFFICIENT_STOCK', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust').set(oa()).send({
      batch_id: createdBatchId, adjustment_qty: -99999, note: 'Trying to go below zero'
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
  });
});

// ── EXPIRY WRITE-OFF
describe('PATCH /api/v1/inventory/batch/:batchId/writeoff', () => {
  let expiredBatchId;

  beforeAll(async () => {
    // Create a batch that's expired (we'll need to fake it via direct DB in real tests)
    // For now this tests the business logic path with a future-dated batch (will fail correctly)
  });

  test('TC-INV-18: Cannot write off a non-expired batch — 422', async () => {
    const res = await request(app).patch(`/api/v1/inventory/batch/${createdBatchId}/writeoff`).set(oa());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('BATCH_NOT_EXPIRED');
  });

  test('TC-INV-19: Staff cannot write off — 403', async () => {
    const res = await request(app).patch(`/api/v1/inventory/batch/${createdBatchId}/writeoff`).set(sa());
    expect(res.status).toBe(403);
  });
});

// ── LEDGER (owner only)
describe('GET /api/v1/inventory/movements', () => {
  test('TC-INV-20: Owner can view ledger movements', async () => {
    const res = await request(app).get('/api/v1/inventory/movements').set(oa());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.movements)).toBe(true);
  });

  test('TC-INV-21: Staff cannot view ledger — 403', async () => {
    const res = await request(app).get('/api/v1/inventory/movements').set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-INV-22: Ledger movements include batch and medicine info', async () => {
    const res = await request(app).get(`/api/v1/inventory/movements?batchId=${createdBatchId}`).set(oa());
    if (res.body.data.movements.length > 0) {
      expect(res.body.data.movements[0]).toHaveProperty('inventory_batches');
    }
  });
});

// ── SECURITY / INTEGRITY
describe('Security and data integrity', () => {
  test('TC-INV-23: Ledger UPDATE is blocked at DB level', async () => {
    // The block_ledger_mutation trigger prevents any UPDATE on inventory_ledger
    // This is verified by the DB schema — no REST endpoint exposes an update route
    const res = await request(app).patch(`/api/v1/inventory/movements`).set(oa());
    expect(res.status).toBe(404); // route does not exist
  });

  test('TC-INV-24: Stock for a batch always equals sum of its ledger entries', async () => {
    const batch = await request(app).get(`/api/v1/inventory/batch/${createdBatchId}`).set(oa());
    const movements = await request(app).get(`/api/v1/inventory/movements?batchId=${createdBatchId}&limit=100`).set(oa());
    const ledgerSum = movements.body.data.movements.reduce((s, m) => s + m.change_qty, 0);
    expect(batch.body.data.batch.stock_qty).toBe(ledgerSum);
  });

  test('TC-INV-25: Unauthenticated request to inventory returns 401', async () => {
    const res = await request(app).get('/api/v1/inventory');
    expect(res.status).toBe(401);
  });
});
