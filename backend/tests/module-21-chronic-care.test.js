/**
 * MODULE 21 — Chronic Medication Adherence Monitoring
 * Runner: Jest + Supertest
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken;
let customerId, medicineId, scheduleId, conditionId;

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL,  password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;

  const meds = await request(app).get('/api/v1/medicines').set({ Authorization: `Bearer ${ownerToken}` });
  medicineId = meds.body.data.medicines[0]?.id;

  const custRes = await request(app).post('/api/v1/customers').set({ Authorization: `Bearer ${staffToken}` }).send({
    name: `Chronic Care QA ${Date.now()}`, phone: `91${Math.floor(Math.random()*99999999).toString().padStart(8,'0')}`
  });
  customerId = custRes.body.data.customer.id;

  // Ensure stock exists for billing tests
  await request(app).post('/api/v1/inventory/batches').set({ Authorization: `Bearer ${ownerToken}` }).send({
    medicine_id: medicineId, batch_no: `QA21-${Date.now()}`, exp_date: '2029-12-31',
    unit_cost: 10, mrp: 30, selling_price: 25, opening_qty: 100, reason: 'opening_stock'
  });
});

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

describe('Module 21 — Condition options (fixed list)', () => {
  test('TC-CC-01: Returns a fixed, non-empty list of chronic conditions', async () => {
    const res = await request(app).get('/api/v1/chronic-care/condition-options').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.conditions.length).toBeGreaterThan(0);
    conditionId = res.body.data.conditions[0].id;
  });

  test('TC-CC-02: Both roles can read the condition list', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/chronic-care/condition-options').set(oa()),
      request(app).get('/api/v1/chronic-care/condition-options').set(sa()),
    ]);
    expect(o.status).toBe(200); expect(s.status).toBe(200);
  });
});

describe('Module 21 — Patient conditions', () => {
  test('TC-CC-03: Staff can record a diagnosis for a customer', async () => {
    const res = await request(app).post('/api/v1/chronic-care/customers/conditions').set(sa()).send({
      customer_id: customerId, condition_id: conditionId, diagnosed_date: '2025-01-15',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.condition.customer_id).toBe(customerId);
  });

  test('TC-CC-04: Condition must come from the fixed list — invalid UUID rejected', async () => {
    const res = await request(app).post('/api/v1/chronic-care/customers/conditions').set(sa()).send({
      customer_id: customerId, condition_id: 'not-a-real-uuid',
    });
    expect(res.status).toBe(422);
  });

  test('TC-CC-05: Listing conditions for a customer returns joined condition name', async () => {
    const res = await request(app).get(`/api/v1/chronic-care/customers/${customerId}/conditions`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.conditions.length).toBeGreaterThan(0);
    expect(res.body.data.conditions[0]).toHaveProperty('chronic_conditions');
  });
});

describe('Module 21 — Medication schedules', () => {
  test('TC-CC-06: Staff can create a medication schedule (both roles allowed)', async () => {
    const res = await request(app).post('/api/v1/chronic-care/schedules').set(sa()).send({
      customer_id: customerId, medicine_id: medicineId, condition_id: conditionId, refill_cycle_days: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.schedule.refill_cycle_days).toBe(30);
    scheduleId = res.body.data.schedule.id;
  });

  test('TC-CC-07: Duplicate active schedule for same customer+medicine is rejected', async () => {
    const res = await request(app).post('/api/v1/chronic-care/schedules').set(oa()).send({
      customer_id: customerId, medicine_id: medicineId, refill_cycle_days: 30,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_SCHEDULE');
  });

  test('TC-CC-08: refill_cycle_days must be positive', async () => {
    const res = await request(app).post('/api/v1/chronic-care/schedules').set(oa()).send({
      customer_id: customerId, medicine_id: medicineId, refill_cycle_days: 0,
    });
    expect(res.status).toBe(422);
  });

  test('TC-CC-09: Listing schedules returns computed status (never stored)', async () => {
    const res = await request(app).get(`/api/v1/chronic-care/customers/${customerId}/schedules`).set(oa());
    expect(res.status).toBe(200);
    const schedule = res.body.data.schedules.find(s => s.schedule_id === scheduleId);
    expect(schedule).toBeDefined();
    expect(schedule).toHaveProperty('status');
    expect(schedule).toHaveProperty('days_since_last_purchase');
    // No purchase has happened yet for this fresh customer+medicine pairing
    expect(['no_purchase_yet', 'on_track', 'early_refill', 'overdue', 'due_soon']).toContain(schedule.status);
  });

  test('TC-CC-10: Owner can update grace-day settings', async () => {
    const res = await request(app).patch(`/api/v1/chronic-care/schedules/${scheduleId}`).set(oa()).send({ early_grace_days: 5, late_grace_days: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data.schedule.early_grace_days).toBe(5);
    expect(res.body.data.schedule.late_grace_days).toBe(10);
  });
});

describe('Module 21 — Point-of-sale adherence gate (the core requirement)', () => {
  let customerPhone;

  beforeAll(async () => {
    const c = await request(app).get(`/api/v1/customers/${customerId}`).set(oa());
    customerPhone = c.body.data.customer.phone;
  });

  test('TC-CC-11: First purchase for a tracked medicine succeeds with no warning (no purchase history yet)', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      customer_phone: customerPhone, payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 1 }],
    });
    // no_purchase_yet is not in the warning set (early_refill/overdue only), so this should succeed
    expect(res.status).toBe(201);
  });

  test('TC-CC-12: Immediate repeat purchase on a 30-day cycle triggers ADHERENCE_ACK_REQUIRED', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      customer_phone: customerPhone, payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ADHERENCE_ACK_REQUIRED');
    expect(res.body.details).toBeDefined();
    expect(res.body.details.warnings.length).toBeGreaterThan(0);
    expect(res.body.details.warnings[0].status).toBe('early_refill');
  });

  test('TC-CC-13: Sale is NEVER blocked outright — submitting acknowledged_warnings completes it', async () => {
    // Reproduce the warning first
    const attempt = await request(app).post('/api/v1/billing').set(sa()).send({
      customer_phone: customerPhone, payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 1 }],
    });
    expect(attempt.status).toBe(409);
    const warnings = attempt.body.details.warnings;

    // Resubmit with acknowledgment
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      customer_phone: customerPhone, payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 1 }],
      acknowledged_warnings: warnings.map(w => ({ schedule_id: w.schedule_id })),
    });
    expect(res.status).toBe(201);
  });

  test('TC-CC-14: Acknowledged sale is recorded in the audit trail', async () => {
    const res = await request(app).get('/api/v1/audit-logs?action=adherence_warning_acknowledged&limit=5').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBeGreaterThan(0);
  });

  test('TC-CC-15: A bill for a customer with no tracked schedule has no gate at all', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      customer_phone: '9999999999', payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 1 }],
    });
    // Different phone, no schedule exists — should succeed with no adherence check triggered
    expect(res.status).toBe(201);
  });
});

describe('Module 21 — Dashboard integration', () => {
  test('TC-CC-16: Owner dashboard includes overdue_refills in alerts', async () => {
    const res = await request(app).get('/api/v1/dashboard/owner').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.dashboard.alerts).toHaveProperty('overdue_refills');
    expect(Array.isArray(res.body.data.dashboard.alerts.overdue_refills)).toBe(true);
  });

  test('TC-CC-17: /chronic-care/overdue returns schedules needing attention', async () => {
    const res = await request(app).get('/api/v1/chronic-care/overdue').set(oa());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.schedules)).toBe(true);
  });
});

describe('Module 21 — Deactivation', () => {
  test('TC-CC-18: Deactivating a schedule removes it from active tracking', async () => {
    const res = await request(app).patch(`/api/v1/chronic-care/schedules/${scheduleId}/deactivate`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.schedule.is_active).toBe(false);

    const list = await request(app).get(`/api/v1/chronic-care/customers/${customerId}/schedules`).set(oa());
    expect(list.body.data.schedules.find(s => s.schedule_id === scheduleId)).toBeUndefined();
  });

  test('TC-CC-19: After deactivation, buying the same medicine triggers no warning', async () => {
    const c = await request(app).get(`/api/v1/customers/${customerId}`).set(oa());
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      customer_phone: c.body.data.customer.phone, payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 1 }],
    });
    expect(res.status).toBe(201); // no gate anymore
  });
});
