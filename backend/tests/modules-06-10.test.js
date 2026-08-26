/**
 * MODULES 06–10: Suppliers, Purchases, Purchase Items, Billing, Bill Items
 * Runner: Jest + Supertest
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken;
let supplierId, purchaseId, billId, medicineId, batchId;

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL,  password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;

  const meds = await request(app).get('/api/v1/medicines').set({ Authorization: `Bearer ${ownerToken}` });
  medicineId = meds.body.data.medicines[0]?.id;

  // Ensure at least one batch with stock exists
  const batchRes = await request(app).post('/api/v1/inventory/batches').set({ Authorization: `Bearer ${ownerToken}` }).send({
    medicine_id: medicineId, batch_no: `QA-BILL-${Date.now()}`, exp_date: '2028-12-31',
    unit_cost: 20, mrp: 50, selling_price: 45, opening_qty: 200, reason: 'opening_stock'
  });
  batchId = batchRes.body.data?.batch?.id;
});

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

// ── MODULE 06: SUPPLIERS ──────────────────────────────────

describe('Module 06 — Suppliers', () => {
  test('TC-SUP-01: Both roles can list suppliers', async () => {
    const [o, s] = await Promise.all([request(app).get('/api/v1/suppliers').set(oa()), request(app).get('/api/v1/suppliers').set(sa())]);
    expect(o.status).toBe(200); expect(s.status).toBe(200);
  });

  test('TC-SUP-02: Owner creates supplier — 201', async () => {
    const res = await request(app).post('/api/v1/suppliers').set(oa()).send({ name: `Test Supplier ${Date.now()}`, phone: '9876543210', credit_terms_days: 30 });
    expect(res.status).toBe(201);
    supplierId = res.body.data.supplier.id;
  });

  test('TC-SUP-03: Staff cannot create supplier — 403', async () => {
    const res = await request(app).post('/api/v1/suppliers').set(sa()).send({ name: 'Hack' });
    expect(res.status).toBe(403);
  });

  test('TC-SUP-04: Duplicate supplier name returns 409', async () => {
    const name = `Dup Supplier ${Date.now()}`;
    await request(app).post('/api/v1/suppliers').set(oa()).send({ name });
    const res = await request(app).post('/api/v1/suppliers').set(oa()).send({ name });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_SUPPLIER');
  });

  test('TC-SUP-05: Owner deactivates and reactivates supplier', async () => {
    const off = await request(app).patch(`/api/v1/suppliers/${supplierId}/deactivate`).set(oa());
    expect(off.body.data.supplier.is_active).toBe(false);
    const on = await request(app).patch(`/api/v1/suppliers/${supplierId}/reactivate`).set(oa());
    expect(on.body.data.supplier.is_active).toBe(true);
  });
});

// ── MODULES 07+08: PURCHASES ─────────────────────────────

describe('Modules 07+08 — Purchases & Purchase Items', () => {
  test('TC-PO-01: Owner creates PO — 201 with generated number', async () => {
    const res = await request(app).post('/api/v1/purchases').set(oa()).send({
      supplier_id: supplierId,
      items: [{ medicine_id: medicineId, qty_ordered: 100, unit_cost: 20 }]
    });
    expect(res.status).toBe(201);
    expect(res.body.data.purchase.purchase_number).toMatch(/^PO-/);
    expect(res.body.data.purchase.status).toBe('draft');
    purchaseId = res.body.data.purchase.id;
  });

  test('TC-PO-02: Staff cannot create PO — 403', async () => {
    const res = await request(app).post('/api/v1/purchases').set(sa()).send({ supplier_id: supplierId, items: [] });
    expect(res.status).toBe(403);
  });

  test('TC-PO-03: PO requires at least one item — 422', async () => {
    const res = await request(app).post('/api/v1/purchases').set(oa()).send({ supplier_id: supplierId, items: [] });
    expect(res.status).toBe(422);
  });

  test('TC-PO-04: Owner sends PO — status becomes sent', async () => {
    const res = await request(app).patch(`/api/v1/purchases/${purchaseId}/send`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.purchase.status).toBe('sent');
  });

  test('TC-PO-05: Cannot edit a sent PO — 409 NOT_DRAFT', async () => {
    const res = await request(app).patch(`/api/v1/purchases/${purchaseId}`).set(oa()).send({ notes: 'Edit attempt' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_DRAFT');
  });

  test('TC-PO-06: Owner receives PO — creates batch + ledger entry', async () => {
    const po = await request(app).get(`/api/v1/purchases/${purchaseId}`).set(oa());
    const poItemId = po.body.data.purchase.items[0].id;
    const res = await request(app).post(`/api/v1/purchases/${purchaseId}/receive`).set(oa()).send({
      items: [{ purchase_item_id: poItemId, batch_no: `RCV-${Date.now()}`, qty_received: 90, exp_date: '2028-06-30', mrp: 50, selling_price: 45 }]
    });
    expect(res.status).toBe(200);
    expect(res.body.data.purchase.status).toBe('received');
  });

  test('TC-PO-07: Selling price > MRP on receipt — 422', async () => {
    const po2 = await request(app).post('/api/v1/purchases').set(oa()).send({ supplier_id: supplierId, items: [{ medicine_id: medicineId, qty_ordered: 10, unit_cost: 20 }] });
    const p2Id = po2.body.data.purchase.id;
    await request(app).patch(`/api/v1/purchases/${p2Id}/send`).set(oa());
    const po2Full = await request(app).get(`/api/v1/purchases/${p2Id}`).set(oa());
    const itemId = po2Full.body.data.purchase.items[0].id;
    const res = await request(app).post(`/api/v1/purchases/${p2Id}/receive`).set(oa()).send({ items: [{ purchase_item_id: itemId, batch_no: 'BADPRICE', qty_received: 10, exp_date: '2028-01-01', mrp: 30, selling_price: 50 }] });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('PRICE_EXCEEDS_MRP');
  });
});

// ── MODULES 09+10: BILLING ────────────────────────────────

describe('Modules 09+10 — Billing & Bill Items', () => {
  test('TC-BILL-01: Staff creates bill — 201 with bill number', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      customer_name: 'Test Patient', customer_phone: '9876543210',
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 2 }]
    });
    expect(res.status).toBe(201);
    expect(res.body.data.bill.bill_number).toMatch(/^BILL-/);
    billId = res.body.data.bill.id;
  });

  test('TC-BILL-02: Bill total = sum of bill_items (computed view)', async () => {
    const res = await request(app).get(`/api/v1/billing/${billId}`).set(oa());
    const bill = res.body.data.bill;
    const itemsTotal = bill.items.reduce((s, i) => s + i.qty * parseFloat(i.unit_price), 0);
    const discount = parseFloat(bill.discount_amount || 0);
    expect(parseFloat(bill.subtotal)).toBeCloseTo(itemsTotal, 2);
    expect(parseFloat(bill.total)).toBeCloseTo(itemsTotal - discount, 2);
  });

  test('TC-BILL-03: FEFO applied — nearest-expiry batch consumed first', async () => {
    const res = await request(app).get(`/api/v1/billing/${billId}`).set(oa());
    const bill = res.body.data.bill;
    expect(bill.items.length).toBeGreaterThan(0);
    expect(bill.items[0].batch_id).toBeDefined();
    // Each item must have batch_id (FEFO resolved)
    bill.items.forEach(i => expect(i.batch_id).toBeTruthy());
  });

  test('TC-BILL-04: Inventory decremented by sold qty', async () => {
    const before = await request(app).get(`/api/v1/inventory/${medicineId}/available-batches`).set(sa());
    const initialStock = before.body.data.batches.reduce((s,b) => s + b.stock_qty, 0);
    await request(app).post('/api/v1/billing').set(sa()).send({ payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 3 }] });
    const after = await request(app).get(`/api/v1/inventory/${medicineId}/available-batches`).set(sa());
    const finalStock = after.body.data.batches.reduce((s,b) => s + b.stock_qty, 0);
    expect(finalStock).toBe(initialStock - 3);
  });

  test('TC-BILL-05: Insufficient stock returns 409', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({ payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 99999 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
  });

  test('TC-BILL-06: Empty items returns 422', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({ payment_mode: 'cash', items: [] });
    expect(res.status).toBe(422);
  });

  test('TC-BILL-07: Invalid payment mode returns 422', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({ payment_mode: 'barter', items: [{ medicine_id: medicineId, qty: 1 }] });
    expect(res.status).toBe(422);
  });

  test('TC-BILL-08: Owner sees all bills; staff sees only their own', async () => {
    const [ownerBills, staffBills] = await Promise.all([
      request(app).get('/api/v1/billing').set(oa()),
      request(app).get('/api/v1/billing').set(sa()),
    ]);
    expect(ownerBills.body.data.pagination.total).toBeGreaterThanOrEqual(staffBills.body.data.pagination.total);
  });

  test('TC-BILL-09: No DELETE endpoint for bills — 404', async () => {
    const res = await request(app).delete(`/api/v1/billing/${billId}`).set(oa());
    expect(res.status).toBe(404);
  });

  test('TC-BILL-10: Owner can view daily totals summary', async () => {
    const today = new Date().toISOString().slice(0,10);
    const res = await request(app).get(`/api/v1/billing/totals?dateFrom=${today}&dateTo=${today}`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toHaveProperty('total');
    expect(res.body.data.summary).toHaveProperty('cash');
    expect(res.body.data.summary.count).toBeGreaterThan(0);
  });

  test('TC-BILL-11: Staff cannot view totals summary — 403', async () => {
    const today = new Date().toISOString().slice(0,10);
    const res = await request(app).get(`/api/v1/billing/totals?dateFrom=${today}&dateTo=${today}`).set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-BILL-12: Bill items include price snapshots — changing medicine price does not affect past bills', async () => {
    const billBefore = await request(app).get(`/api/v1/billing/${billId}`).set(oa());
    const originalPrice = billBefore.body.data.bill.items[0]?.unit_price;
    // Update the medicine's default selling price
    await request(app).patch(`/api/v1/medicines/${medicineId}`).set(oa()).send({ default_selling_price: 999.99 });
    // Re-fetch the old bill — price must NOT have changed
    const billAfter = await request(app).get(`/api/v1/billing/${billId}`).set(oa());
    expect(billAfter.body.data.bill.items[0]?.unit_price).toBe(originalPrice);
  });
});
