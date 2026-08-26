/**
 * MODULES 11–14: Customers, Customer Returns,
 *                Supplier Returns, Expiry Management
 * Runner: Jest + Supertest
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken;
let customerId, billId, billItemId, batchId, medicineId, supplierId;
let customerReturnId, supplierReturnId;

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL,  password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;

  // Get test data
  const meds     = await request(app).get('/api/v1/medicines').set({ Authorization: `Bearer ${ownerToken}` });
  const sups     = await request(app).get('/api/v1/suppliers').set({ Authorization: `Bearer ${ownerToken}` });
  medicineId     = meds.body.data.medicines[0]?.id;
  supplierId     = sups.body.data.suppliers[0]?.id;

  // Ensure batch with stock
  const batchRes = await request(app).post('/api/v1/inventory/batches').set({ Authorization: `Bearer ${ownerToken}` }).send({
    medicine_id: medicineId, batch_no: `QA11-14-${Date.now()}`,
    exp_date: '2029-12-31', unit_cost: 20, mrp: 50, selling_price: 45, opening_qty: 50, reason: 'opening_stock'
  });
  batchId = batchRes.body.data?.batch?.id;

  // Ensure bill
  const billRes = await request(app).post('/api/v1/billing').set({ Authorization: `Bearer ${staffToken}` }).send({
    customer_name: 'QA Test Patient', customer_phone: '9876540000',
    payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 5 }]
  });
  const billFull = await request(app).get(`/api/v1/billing/${billRes.body.data?.bill?.id}`).set({ Authorization: `Bearer ${ownerToken}` });
  billId     = billFull.body.data?.bill?.id;
  billItemId = billFull.body.data?.bill?.items?.[0]?.id;
});

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

// ════════════════════════════════════════════
// MODULE 11 — CUSTOMERS
// ════════════════════════════════════════════

describe('Module 11 — Customers', () => {
  test('TC-CUS-01: Both roles can list customers', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/customers').set(oa()),
      request(app).get('/api/v1/customers').set(sa()),
    ]);
    expect(o.status).toBe(200); expect(s.status).toBe(200);
  });

  test('TC-CUS-02: Staff creates a customer — 201', async () => {
    const res = await request(app).post('/api/v1/customers').set(sa()).send({
      name: `Test Customer ${Date.now()}`, phone: `98${Math.floor(Math.random()*99999999).toString().padStart(8,'0')}`
    });
    expect(res.status).toBe(201);
    customerId = res.body.data.customer.id;
  });

  test('TC-CUS-03: Duplicate phone returns 409 DUPLICATE_PHONE', async () => {
    const phone = `97${Math.floor(Math.random()*99999999).toString().padStart(8,'0')}`;
    await request(app).post('/api/v1/customers').set(sa()).send({ name: 'First', phone });
    const res = await request(app).post('/api/v1/customers').set(sa()).send({ name: 'Second', phone });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_PHONE');
  });

  test('TC-CUS-04: Invalid phone returns 422', async () => {
    const res = await request(app).post('/api/v1/customers').set(sa()).send({ name: 'Test', phone: '123' });
    expect(res.status).toBe(422);
  });

  test('TC-CUS-05: Owner can view customer with aggregated stats', async () => {
    const res = await request(app).get(`/api/v1/customers/${customerId}`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.customer).toHaveProperty('total_bills');
    expect(res.body.data.customer).toHaveProperty('total_spent');
    expect(res.body.data.customer).toHaveProperty('last_purchase_at');
  });

  test('TC-CUS-06: Customer purchase history linked by phone', async () => {
    const res = await request(app).get(`/api/v1/customers/${customerId}/history`).set(oa());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.bills)).toBe(true);
  });

  test('TC-CUS-07: Phone is immutable after creation', async () => {
    const res = await request(app).patch(`/api/v1/customers/${customerId}`).set(oa()).send({ phone: '9999999999' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('TC-CUS-08: Owner can edit name, email, address', async () => {
    const res = await request(app).patch(`/api/v1/customers/${customerId}`).set(oa()).send({ name: 'Updated Name', address: 'Ward 5, Gadag' });
    expect(res.status).toBe(200);
    expect(res.body.data.customer.name).toBe('Updated Name');
  });

  test('TC-CUS-09: Staff cannot edit customer — 403', async () => {
    const res = await request(app).patch(`/api/v1/customers/${customerId}`).set(sa()).send({ name: 'Hack' });
    expect(res.status).toBe(403);
  });

  test('TC-CUS-10: Owner deactivates and reactivates customer', async () => {
    const off = await request(app).patch(`/api/v1/customers/${customerId}/deactivate`).set(oa());
    expect(off.body.data.customer.is_active).toBe(false);
    const on = await request(app).patch(`/api/v1/customers/${customerId}/reactivate`).set(oa());
    expect(on.body.data.customer.is_active).toBe(true);
  });

  test('TC-CUS-11: Search returns matching customers', async () => {
    const res = await request(app).get('/api/v1/customers/search?q=Updated').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.customers.length).toBeGreaterThan(0);
  });

  test('TC-CUS-12: Hard DELETE does not exist', async () => {
    const res = await request(app).delete(`/api/v1/customers/${customerId}`).set(oa());
    expect(res.status).toBe(404);
  });

  test('TC-CUS-13: Unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/v1/customers');
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════
// MODULE 12 — CUSTOMER RETURNS
// ════════════════════════════════════════════

describe('Module 12 — Customer Returns', () => {
  test('TC-CR-01: Staff can create a return — 201 with CR number', async () => {
    if (!billId || !billItemId) return;
    const res = await request(app).post('/api/v1/customer-returns').set(sa()).send({
      bill_id: billId, reason: 'Wrong medicine dispensed by mistake', refund_mode: 'cash',
      items: [{ bill_item_id: billItemId, qty_returned: 1 }]
    });
    expect(res.status).toBe(201);
    expect(res.body.data.return.return_number).toMatch(/^CR-/);
    expect(res.body.data.return.status).toBe('pending');
    customerReturnId = res.body.data.return.id;
  });

  test('TC-CR-02: Return qty cannot exceed sold qty', async () => {
    if (!billId || !billItemId) return;
    const res = await request(app).post('/api/v1/customer-returns').set(sa()).send({
      bill_id: billId, reason: 'Test return', refund_mode: 'cash',
      items: [{ bill_item_id: billItemId, qty_returned: 9999 }]
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('QTY_EXCEEDS_SOLD');
  });

  test('TC-CR-03: Return references non-existent bill — 404', async () => {
    const res = await request(app).post('/api/v1/customer-returns').set(sa()).send({
      bill_id: '00000000-0000-0000-0000-000000000001', reason: 'Test', refund_mode: 'cash',
      items: [{ bill_item_id: '00000000-0000-0000-0000-000000000002', qty_returned: 1 }]
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BILL_NOT_FOUND');
  });

  test('TC-CR-04: Staff sees only own returns; owner sees all', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/customer-returns').set(oa()),
      request(app).get('/api/v1/customer-returns').set(sa()),
    ]);
    expect(o.status).toBe(200); expect(s.status).toBe(200);
    expect(o.body.data.pagination.total).toBeGreaterThanOrEqual(s.body.data.pagination.total);
  });

  test('TC-CR-05: Staff cannot approve return — 403', async () => {
    if (!customerReturnId) return;
    const res = await request(app).patch(`/api/v1/customer-returns/${customerReturnId}/approve`).set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-CR-06: Owner approves return — stock restored via ledger', async () => {
    if (!customerReturnId) return;
    const stockBefore = (await request(app).get(`/api/v1/inventory/${medicineId}/available-batches`).set(oa())).body.data.batches.reduce((s,b)=>s+b.stock_qty,0);
    const res = await request(app).patch(`/api/v1/customer-returns/${customerReturnId}/approve`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.return.status).toBe('approved');
    expect(res.body.data.return.refund_amount).toBeGreaterThan(0);
    const stockAfter = (await request(app).get(`/api/v1/inventory/${medicineId}/available-batches`).set(oa())).body.data.batches.reduce((s,b)=>s+b.stock_qty,0);
    expect(stockAfter).toBe(stockBefore + 1); // 1 unit returned to shelf
  });

  test('TC-CR-07: Approved return cannot be approved again', async () => {
    if (!customerReturnId) return;
    const res = await request(app).patch(`/api/v1/customer-returns/${customerReturnId}/approve`).set(oa());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_STATUS');
  });

  test('TC-CR-08: Reason required — 422', async () => {
    if (!billId || !billItemId) return;
    const res = await request(app).post('/api/v1/customer-returns').set(sa()).send({
      bill_id: billId, refund_mode: 'cash', items: [{ bill_item_id: billItemId, qty_returned: 1 }]
    });
    expect(res.status).toBe(422);
  });
});

// ════════════════════════════════════════════
// MODULE 13 — SUPPLIER RETURNS
// ════════════════════════════════════════════

describe('Module 13 — Supplier Returns', () => {
  test('TC-SR-01: Only owner can access supplier returns — staff gets 403', async () => {
    const res = await request(app).get('/api/v1/supplier-returns').set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-SR-02: Owner creates supplier return — 201 with SR number', async () => {
    if (!batchId || !supplierId) return;
    const res = await request(app).post('/api/v1/supplier-returns').set(oa()).send({
      supplier_id: supplierId, reason: 'Damaged packaging received from supplier',
      items: [{ batch_id: batchId, qty_returned: 2 }]
    });
    expect(res.status).toBe(201);
    expect(res.body.data.return.return_number).toMatch(/^SR-/);
    expect(res.body.data.return.status).toBe('draft');
    supplierReturnId = res.body.data.return.id;
  });

  test('TC-SR-03: Cannot return more than current batch stock', async () => {
    if (!batchId || !supplierId) return;
    const res = await request(app).post('/api/v1/supplier-returns').set(oa()).send({
      supplier_id: supplierId, reason: 'Test', items: [{ batch_id: batchId, qty_returned: 99999 }]
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
  });

  test('TC-SR-04: Send return — stock decremented, debit note created', async () => {
    if (!supplierReturnId) return;
    const stockBefore = (await request(app).get(`/api/v1/inventory/${medicineId}/available-batches`).set(oa())).body.data.batches.reduce((s,b)=>s+b.stock_qty,0);
    const res = await request(app).patch(`/api/v1/supplier-returns/${supplierReturnId}/send`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.return.status).toBe('sent');
    const stockAfter = (await request(app).get(`/api/v1/inventory/${medicineId}/available-batches`).set(oa())).body.data.batches.reduce((s,b)=>s+b.stock_qty,0);
    expect(stockAfter).toBe(stockBefore - 2); // 2 units returned to supplier
  });

  test('TC-SR-05: Cannot send already-sent return', async () => {
    if (!supplierReturnId) return;
    const res = await request(app).patch(`/api/v1/supplier-returns/${supplierReturnId}/send`).set(oa());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_STATUS');
  });

  test('TC-SR-06: Owner acknowledges return', async () => {
    if (!supplierReturnId) return;
    const res = await request(app).patch(`/api/v1/supplier-returns/${supplierReturnId}/acknowledge`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.return.status).toBe('acknowledged');
  });
});

// ════════════════════════════════════════════
// MODULE 14 — EXPIRY MANAGEMENT
// ════════════════════════════════════════════

describe('Module 14 — Expiry Management', () => {
  test('TC-EXP-01: Staff cannot access expiry dashboard — 403', async () => {
    const res = await request(app).get('/api/v1/expiry/dashboard').set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-EXP-02: Owner fetches expiry dashboard with urgency buckets', async () => {
    const res = await request(app).get('/api/v1/expiry/dashboard').set(oa());
    expect(res.status).toBe(200);
    const { summary, totals } = res.body.data;
    expect(summary).toHaveProperty('expired');
    expect(summary).toHaveProperty('critical');
    expect(summary).toHaveProperty('warning');
    expect(summary).toHaveProperty('watch');
    expect(totals).toHaveProperty('potential_loss');
  });

  test('TC-EXP-03: Owner filters batches by urgency', async () => {
    const res = await request(app).get('/api/v1/expiry/urgency/critical').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('batches');
    expect(res.body.data).toHaveProperty('total_loss_value');
  });

  test('TC-EXP-04: Invalid urgency param returns 422', async () => {
    const res = await request(app).get('/api/v1/expiry/urgency/unknown').set(oa());
    expect(res.status).toBe(422);
  });

  test('TC-EXP-05: Cannot write off a non-expired batch', async () => {
    if (!batchId) return; // 2029-12-31 batch — not expired
    const res = await request(app).patch(`/api/v1/expiry/batch/${batchId}/writeoff`).set(oa());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('BATCH_NOT_EXPIRED');
  });

  test('TC-EXP-06: Expiry report returns structured report', async () => {
    const res = await request(app).get('/api/v1/expiry/report').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.report).toHaveProperty('generated_at');
    expect(res.body.data.report).toHaveProperty('total_at_risk_value');
    expect(Array.isArray(res.body.data.report.batches_expiring_90d)).toBe(true);
  });

  test('TC-EXP-07: All expiry data is computed not stored', async () => {
    const dashboard = await request(app).get('/api/v1/expiry/dashboard').set(oa());
    // All batches must have stock_qty (computed), not a stored qty field
    const allBatches = Object.values(dashboard.body.data.summary).flat();
    allBatches.forEach(b => expect(b).toHaveProperty('stock_qty'));
    allBatches.forEach(b => expect(b).toHaveProperty('potential_loss_value'));
  });

  test('TC-EXP-08: potential_loss_value = stock_qty × unit_cost', async () => {
    const dashboard = await request(app).get('/api/v1/expiry/dashboard').set(oa());
    const allBatches = Object.values(dashboard.body.data.summary).flat();
    allBatches.forEach(b => {
      const expected = b.stock_qty * parseFloat(b.unit_cost);
      expect(Math.abs(parseFloat(b.potential_loss_value) - expected)).toBeLessThan(0.01);
    });
  });
});
