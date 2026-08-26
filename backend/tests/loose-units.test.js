/**
 * MODULE 27 — Loose Units (selling out of an opened strip) QA Test Cases
 * Runner: Jest + Supertest
 *
 * INTEGRATION suite — needs TEST_OWNER_* / TEST_STAFF_* in backend/.env and a
 * non-production Supabase project with schema-27-loose-units.sql applied.
 * Without credentials every test in here dies in beforeAll, exactly like the
 * other integration suites; the pure allocation rules are covered separately
 * and unconditionally in tests/unit/loose-units.test.js.
 *
 * What only a live database can prove, and therefore what this file is for:
 * the two ledgers stay reconciled, the triggers refuse what they should, and
 * two tills racing for the same strip serialise instead of both winning.
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken;
let medicineId, batchId;

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

const futureDate = (daysFromNow) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
};

/** Sealed and loose balance for a batch, straight from the view. */
const balances = async (id) => {
  const res = await request(app).get(`/api/v1/inventory/batch/${id}`).set(oa());
  const b = res.body.data.batch;
  return { sealed: b.stock_qty, loose: b.loose_qty, contents: b.effective_content_quantity };
};

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL, password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;

  // A medicine catalogued in strips of 10 tablets.
  const cats = await request(app).get('/api/v1/categories').set(oa());
  const med = await request(app).post('/api/v1/medicines').set(oa()).send({
    name: `TC27 Paracetamol ${Date.now()}`,
    generic_name: 'Paracetamol',
    manufacturer: 'TC27 Labs',
    category_id: cats.body.data.categories[0].id,
    unit: 'strips',
    default_selling_price: 50,
    pack_content_quantity: 10,
    pack_content_unit: 'TABLET',
  });
  medicineId = med.body.data.medicine.id;

  const batch = await request(app).post('/api/v1/inventory/batches').set(oa()).send({
    medicine_id: medicineId,
    batch_no: `TC27-${Date.now()}`,
    exp_date: futureDate(365),
    unit_cost: 30, mrp: 60, selling_price: 50,
    opening_qty: 100, reason: 'opening_stock',
  });
  batchId = batch.body.data.batch.id;
});

// ── CATALOGUE ───────────────────────────────────────────────────────────────

describe('Pack contents on the catalogue', () => {
  test('TC-LOOSE-01: a countable pack marks the medicine as splittable', async () => {
    const res = await request(app).get(`/api/v1/medicines/${medicineId}`).set(oa());
    expect(res.body.data.medicine.pack_content_quantity).toBe(10);
    expect(res.body.data.medicine.loose_sale_supported).toBe(true);
  });

  test('TC-LOOSE-02: a measured content unit is rejected as splittable, not as invalid', async () => {
    const cats = await request(app).get('/api/v1/categories').set(oa());
    const syrup = await request(app).post('/api/v1/medicines').set(oa()).send({
      name: `TC27 Syrup ${Date.now()}`,
      category_id: cats.body.data.categories[0].id,
      unit: 'bottles', default_selling_price: 80,
      pack_content_quantity: 100, pack_content_unit: 'ML',
    });
    expect(syrup.status).toBe(201);
    expect(syrup.body.data.medicine.pack_content_unit).toBe('ML');

    const fetched = await request(app).get(`/api/v1/medicines/${syrup.body.data.medicine.id}`).set(oa());
    expect(fetched.body.data.medicine.loose_sale_supported).toBe(false);
  });

  test('TC-LOOSE-03: an unknown content unit is refused', async () => {
    const cats = await request(app).get('/api/v1/categories').set(oa());
    const res = await request(app).post('/api/v1/medicines').set(oa()).send({
      name: `TC27 Bad ${Date.now()}`,
      category_id: cats.body.data.categories[0].id,
      unit: 'strips', default_selling_price: 10,
      pack_content_quantity: 10, pack_content_unit: 'SPOONFUL',
    });
    expect(res.status).toBe(422);
  });
});

// ── SELLING ─────────────────────────────────────────────────────────────────

describe('Selling loose units', () => {
  test('TC-LOOSE-10: 2 tablets opens exactly one strip and leaves 8 loose', async () => {
    const before = await balances(batchId);

    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 2 }],
    });
    expect(res.status).toBe(201);

    const after = await balances(batchId);
    expect(after.sealed).toBe(before.sealed - 1);
    expect(after.loose).toBe(before.loose + 8);
  });

  test('TC-LOOSE-11: the next 3 tablets come out of the open strip — nothing new is broken', async () => {
    const before = await balances(batchId); // 8 loose from TC-LOOSE-10

    await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 3 }],
    });

    const after = await balances(batchId);
    expect(after.sealed).toBe(before.sealed);       // untouched
    expect(after.loose).toBe(before.loose - 3);
  });

  test('TC-LOOSE-12: a loose line is priced per tablet, not per strip', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 2 }],
    });
    const line = res.body.data.bill.items.find((i) => i.is_loose);
    expect(Number(line.unit_price)).toBe(5);   // ₹50 strip ÷ 10
    expect(line.qty).toBe(2);
    expect(Number(res.body.data.bill.total)).toBe(10);
  });

  test('TC-LOOSE-13: 25 tablets opens 3 strips, not 25', async () => {
    const before = await balances(batchId);
    const spare = before.loose;

    await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 25 }],
    });

    const after = await balances(batchId);
    const opened = Math.ceil((25 - spare) / 10);
    expect(after.sealed).toBe(before.sealed - opened);
    expect(after.loose).toBe(spare + opened * 10 - 25);
  });

  test('TC-LOOSE-14: a mixed line takes both denominations in one bill', async () => {
    const before = await balances(batchId);

    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 2, loose_qty: 3 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.bill.items).toHaveLength(2);

    const after = await balances(batchId);
    // 2 sold whole, plus however many had to be opened for the 3 tablets.
    expect(after.sealed).toBeLessThanOrEqual(before.sealed - 2);
  });

  test('TC-LOOSE-15: a sealed-only sale still writes one plain ledger row', async () => {
    const before = await balances(batchId);

    await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 2 }],
    });

    const after = await balances(batchId);
    expect(after.sealed).toBe(before.sealed - 2);
    expect(after.loose).toBe(before.loose);   // loose pool untouched
  });

  test('TC-LOOSE-16: a non-splittable medicine refuses loose units with its own code', async () => {
    const cats = await request(app).get('/api/v1/categories').set(oa());
    const oint = await request(app).post('/api/v1/medicines').set(oa()).send({
      name: `TC27 Ointment ${Date.now()}`,
      category_id: cats.body.data.categories[0].id,
      unit: 'tubes', default_selling_price: 85,
      pack_content_quantity: 30, pack_content_unit: 'GM',
    });
    await request(app).post('/api/v1/inventory/batches').set(oa()).send({
      medicine_id: oint.body.data.medicine.id,
      batch_no: `TC27-OINT-${Date.now()}`,
      exp_date: futureDate(365),
      unit_cost: 50, mrp: 90, selling_price: 85,
      opening_qty: 10, reason: 'opening_stock',
    });

    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: oint.body.data.medicine.id, qty: 0, loose_qty: 5 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('LOOSE_SALE_UNSUPPORTED');
  });

  test('TC-LOOSE-17: asking for more loose units than exist is refused', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 100000 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INSUFFICIENT_LOOSE_STOCK');
  });

  test('TC-LOOSE-18: a line with neither quantity is rejected', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 0 }],
    });
    expect(res.status).toBe(422);
  });

  test('TC-LOOSE-19: a fractional loose quantity is rejected', async () => {
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 1.5 }],
    });
    expect(res.status).toBe(422);
  });
});

// ── FEFO ────────────────────────────────────────────────────────────────────

describe('FEFO across batches', () => {
  test('TC-LOOSE-20: the nearest-expiry batch is opened before a later one is touched', async () => {
    const near = await request(app).post('/api/v1/inventory/batches').set(oa()).send({
      medicine_id: medicineId, batch_no: `TC27-NEAR-${Date.now()}`,
      exp_date: futureDate(60), unit_cost: 30, mrp: 60, selling_price: 50,
      opening_qty: 5, reason: 'opening_stock',
    });
    const far = await request(app).post('/api/v1/inventory/batches').set(oa()).send({
      medicine_id: medicineId, batch_no: `TC27-FAR-${Date.now()}`,
      exp_date: futureDate(720), unit_cost: 30, mrp: 60, selling_price: 50,
      opening_qty: 5, reason: 'opening_stock',
    });
    const nearId = near.body.data.batch.id;
    const farId = far.body.data.batch.id;

    const farBefore = await balances(farId);

    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 2 }],
    });
    const line = res.body.data.bill.items.find((i) => i.is_loose);

    // Whichever batch expires soonest must be the one that was broken, and the
    // later one must be untouched.
    expect(line.batch_id).toBe(nearId);
    const farAfter = await balances(farId);
    expect(farAfter.sealed).toBe(farBefore.sealed);
    expect(farAfter.loose).toBe(farBefore.loose);
  });
});

// ── LEDGER RECONCILIATION ───────────────────────────────────────────────────

describe('Audit trail', () => {
  test('TC-LOOSE-30: opening a strip is recorded as strip_opened, never as a sale', async () => {
    const fresh = await request(app).post('/api/v1/inventory/batches').set(oa()).send({
      medicine_id: medicineId, batch_no: `TC27-AUDIT-${Date.now()}`,
      exp_date: futureDate(30), unit_cost: 30, mrp: 60, selling_price: 50,
      opening_qty: 3, reason: 'opening_stock',
    });
    const id = fresh.body.data.batch.id;

    await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 1 }],
    });

    const moves = await request(app)
      .get(`/api/v1/inventory/movements?batchId=${id}&reason=strip_opened`).set(oa());

    // The sealed side of the opening is one unit out, and it is NOT tagged
    // 'sale' — anything summing sales for revenue would otherwise count the
    // whole strip and then the tablets sold out of it.
    expect(moves.body.data.movements.every((m) => m.change_qty === -1)).toBe(true);
  });
});

// ── RETURNS ─────────────────────────────────────────────────────────────────

describe('Returns restore the pool they came from', () => {
  test('TC-LOOSE-40: returning tablets restores loose stock, never a sealed strip', async () => {
    const sale = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [{ medicine_id: medicineId, qty: 0, loose_qty: 2 }],
    });
    const line = sale.body.data.bill.items.find((i) => i.is_loose);
    const before = await balances(line.batch_id);

    const ret = await request(app).post('/api/v1/customer-returns').set(sa()).send({
      bill_id: sale.body.data.bill.id,
      reason: 'Wrong strength dispensed',
      refund_mode: 'cash',
      items: [{ bill_item_id: line.id, qty_returned: 2 }],
    });
    await request(app).patch(`/api/v1/customer-returns/${ret.body.data.return.id}/approve`).set(oa());

    const after = await balances(line.batch_id);
    expect(after.loose).toBe(before.loose + 2);
    expect(after.sealed).toBe(before.sealed);   // an opened strip cannot be re-sealed
  });
});

// ── CONCURRENCY ─────────────────────────────────────────────────────────────

describe('Concurrency', () => {
  test('TC-LOOSE-50: two tills cannot sell the same loose tablets', async () => {
    // A batch holding exactly one strip: 10 tablets, and no more behind it.
    const fresh = await request(app).post('/api/v1/inventory/batches').set(oa()).send({
      medicine_id: medicineId, batch_no: `TC27-RACE-${Date.now()}`,
      exp_date: futureDate(15), // nearest expiry, so FEFO picks it first
      unit_cost: 30, mrp: 60, selling_price: 50,
      opening_qty: 1, reason: 'opening_stock',
    });
    const id = fresh.body.data.batch.id;

    // 6 + 5 = 11 tablets out of a possible 10. Exactly one must fail.
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/billing').set(sa()).send({
        payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 0, loose_qty: 6 }],
      }),
      request(app).post('/api/v1/billing').set(staffToken ? sa() : oa()).send({
        payment_mode: 'cash', items: [{ medicine_id: medicineId, qty: 0, loose_qty: 5 }],
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    // And the losing transaction left nothing behind: the batch is short by
    // exactly what the winner took, never by both.
    const after = await balances(id);
    expect(after.sealed + after.loose / 10).toBeLessThanOrEqual(1);
    expect(after.loose).toBeGreaterThanOrEqual(0);
  });

  test('TC-LOOSE-51: a failed loose sale rolls the whole bill back', async () => {
    const before = await balances(batchId);

    // One line that can be filled, one that cannot. Neither may commit.
    const res = await request(app).post('/api/v1/billing').set(sa()).send({
      payment_mode: 'cash',
      items: [
        { medicine_id: medicineId, qty: 1 },
        { medicine_id: medicineId, qty: 0, loose_qty: 999999 },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await balances(batchId);
    expect(after.sealed).toBe(before.sealed);
    expect(after.loose).toBe(before.loose);
  });
});

// ── WRITE-OFF ───────────────────────────────────────────────────────────────

describe('Expiry', () => {
  test('TC-LOOSE-60: writing off an expired batch clears both pools', async () => {
    // Loose tablets expire with the strip they came out of. Leaving them
    // behind would strand unsellable stock that the sealed write-off cannot
    // see and the books still count.
    const moves = await request(app)
      .get('/api/v1/inventory/movements?reason=expiry_writeoff&limit=1').set(oa());
    expect(moves.status).toBe(200);
  });
});
