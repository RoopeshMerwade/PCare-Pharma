/**
 * F-01: createBill reads every cart medicine's batches in ONE query instead of
 * one query per medicine — without changing what is sold, from which batch, at
 * what price, or which error a cashier sees.
 *
 * Pure. Supabase is an in-memory PostgREST: it applies the eq / in / gte / gt /
 * or filters, ordering, range, column projection, an exact count, and a
 * configurable max_rows cap to a fixed set of batches, and counts requests.
 * The real billing service, repository, inventory service and FEFO module run
 * against it.
 *
 * Old-vs-new comparisons use `legacyResolve`, the pre-F-01 loop copied verbatim
 * from billing.service.js (one getAvailableBatchesFEFO call per medicine).
 * Both read the same fake rows, so any difference is the change's doing.
 */

const mockDb = {
  batches: [],
  medicines: {},
  maxRows: Infinity,     // PostgREST max_rows; Supabase defaults to 1000
  failTable: null,       // a table whose reads return an error
  failWhen: null,        // (query) => true to fail one particular batches_with_stock read
  omitCount: false,      // simulate a response without the requested count
  requests: [],
  billRpcArgs: null,
};

jest.mock('../../src/config/supabase', () => {
  const pick = (row, columns) => {
    if (!columns || columns.trim() === '*') return { ...row };
    const out = {};
    for (const col of columns.split(',').map((c) => c.trim()).filter(Boolean)) out[col] = row[col];
    return out;
  };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  const run = (q) => {
    mockDb.requests.push(q);
    if (q.table === mockDb.failTable || (q.table === 'batches_with_stock' && mockDb.failWhen?.(q))) {
      return { data: null, error: { message: 'boom', code: 'XX000' }, count: null };
    }

    if (q.table === 'batches_with_stock') {
      let rows = mockDb.batches.slice();
      for (const [op, ...args] of q.ops) {
        if (op === 'eq') rows = rows.filter((r) => r[args[0]] === args[1]);
        if (op === 'in') rows = rows.filter((r) => args[1].includes(r[args[0]]));
        if (op === 'gte') rows = rows.filter((r) => r[args[0]] >= args[1]);
        if (op === 'gt') rows = rows.filter((r) => r[args[0]] > args[1]);
        if (op === 'or') {
          const terms = args[0].split(',').map((t) => t.split('.'));
          rows = rows.filter((r) => terms.some(([col, o, v]) => o === 'gt' && Number(r[col]) > Number(v)));
        }
      }
      const orders = q.ops.filter(([op]) => op === 'order');
      rows.sort((a, b) => {
        for (const [, col, opt] of orders) {
          const c = cmp(a[col], b[col]) * (opt?.ascending === false ? -1 : 1);
          if (c) return c;
        }
        return 0;                                     // ties keep table order (stable sort)
      });
      const total = rows.length;
      const range = q.ops.find(([op]) => op === 'range');
      if (range) rows = rows.slice(range[1], range[2] + 1);
      rows = rows.slice(0, mockDb.maxRows);
      const select = q.ops.find(([op]) => op === 'select');
      const wantsCount = select?.[2]?.count === 'exact' && !mockDb.omitCount;
      return { data: rows.map((r) => pick(r, select?.[1])), error: null, count: wantsCount ? total : null };
    }

    const isSingle = q.ops.some(([op]) => op === 'single' || op === 'maybeSingle');
    if (q.table === 'medicines') {
      const id = q.ops.find(([op, col]) => op === 'eq' && col === 'id')?.[2];
      return { data: mockDb.medicines[id] ? { name: mockDb.medicines[id] } : null, error: null };
    }
    if (q.table === 'bills_with_totals') return { data: { id: 'bill-1', bill_number: 'BILL-2026-0001', created_by: 'u1' }, error: null };
    return { data: isSingle ? null : [], error: null };
  };

  const from = (table) => {
    const q = { table, ops: [] };
    const builder = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(run(q)).then(resolve, reject);
        return (...args) => { q.ops.push([prop, ...args]); return builder; };
      },
    });
    return builder;
  };
  const rpc = async (fn, args) => {
    mockDb.requests.push({ rpc: fn });
    if (fn === 'create_bill_atomic') { mockDb.billRpcArgs = args; return { data: 'bill-1', error: null }; }
    return { data: null, error: null };
  };
  return { supabase: { from, rpc }, createAuthClient: () => ({}) };
});

const mockCaps = { looseUnits: true };
jest.mock('../../src/config/capabilities', () => ({ hasLooseUnits: async () => mockCaps.looseUnits }));

const billing = require('../../src/modules/billing/billing.service');
const repo = require('../../src/modules/billing/billing.repository');
const inventory = require('../../src/modules/inventory/inventory.service');
const {
  mergeCartItems, allocateCartLine, looseAvailable, supportsLooseSale,
} = require('../../src/modules/billing/fefo');
const { AppError } = require('../../src/utils/AppError');

// ── The pre-F-01 loop, verbatim (billing.service.js before this change) ─────
async function legacyResolve(items) {
  const { getAvailableBatchesFEFO } = inventory;
  const cart = mergeCartItems(items);
  const resolvedItems = [];
  for (const item of cart) {
    const looseQty = Number(item.loose_qty) || 0;
    const batches = await getAvailableBatchesFEFO(item.medicine_id);

    if (looseQty > 0 && !supportsLooseSale(batches)) {
      const name = await repo.getMedicineName(item.medicine_id);
      throw new AppError(
        `"${name || item.medicine_id}" is not sold in single units — no countable pack contents are recorded for it. Sell it by the whole pack instead.`,
        422, 'LOOSE_SALE_UNSUPPORTED'
      );
    }

    const { lines, sealedShortfall, looseShortfall } = allocateCartLine(batches, { qty: item.qty, looseQty });

    if (sealedShortfall > 0) {
      const name = await repo.getMedicineName(item.medicine_id);
      throw new AppError(
        `Insufficient stock for "${name || item.medicine_id}". Available: ${item.qty - sealedShortfall}, requested: ${item.qty}.`,
        409, 'INSUFFICIENT_STOCK'
      );
    }

    if (looseShortfall > 0) {
      const name = await repo.getMedicineName(item.medicine_id);
      throw new AppError(
        `Insufficient loose units for "${name || item.medicine_id}". Available: ${looseAvailable(batches)}, requested: ${looseQty}.`,
        409, 'INSUFFICIENT_LOOSE_STOCK'
      );
    }

    resolvedItems.push(...lines.map((l) => ({ medicine_id: item.medicine_id, ...l })));
  }
  return resolvedItems;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Rows are deliberately NOT stored in expiry order, so ordering is the query's
// job. Expired and empty batches sit beside sellable ones to prove the filter.
const FUTURE = (m) => `2030-${String(m).padStart(2, '0')}-15`;
let seq = 0;
const batch = (medicine_id, exp_date, stock, extra = {}) => ({
  id: `b${String(++seq).padStart(3, '0')}`,
  medicine_id, batch_no: `BN${seq}`, exp_date, mrp: '20.00', selling_price: '18.00',
  stock_qty: stock, expiry_status: 'ok',
  sealed_qty: stock, loose_qty: 0, effective_content_quantity: null, effective_content_unit: null,
  loose_sale_supported: false,
  ...extra,
});
const loose = (content, looseQty = 0) => ({
  effective_content_quantity: content, effective_content_unit: 'TABLET', loose_sale_supported: true, loose_qty: looseQty,
});

function seed() {
  seq = 0;
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const m = `m${i}`;
    mockDb.medicines[m] = `Medicine ${i}`;
    rows.push(batch(m, FUTURE(12 - (i % 6)), 2 + (i % 3), { selling_price: `${10 + i}.00`, mrp: `${12 + i}.00` }));
    rows.push(batch(m, FUTURE(3 + (i % 4)), 1 + (i % 2), { selling_price: `${10 + i}.50`, mrp: `${12 + i}.50` }));
    rows.push(batch(m, '2020-01-01', 50));                    // expired: never offered
    rows.push(batch(m, FUTURE(1), 0));                         // nothing on hand
  }
  mockDb.medicines.tab = 'Paracetamol 650 (10s)';
  rows.push(batch('tab', FUTURE(9), 4, { selling_price: '30.00', mrp: '30.00', ...loose(10) }));
  rows.push(batch('tab', FUTURE(2), 1, { selling_price: '30.00', mrp: '30.00', ...loose(10, 3) }));
  rows.push(batch('tab', FUTURE(5), 0, { selling_price: '30.00', mrp: '30.00', sealed_qty: 0, ...loose(10, 6) })); // loose only
  mockDb.medicines.syrup = 'Cough Syrup';                      // not splittable
  rows.push(batch('syrup', FUTURE(6), 3));
  mockDb.medicines.empty = 'Never Stocked';                    // no batches at all
  mockDb.batches = rows;
}

const ids = (n) => Array.from({ length: n }, (_, i) => `m${i}`);
const cartOf = (n, qty = 1) => ids(n).map((medicine_id) => ({ medicine_id, qty }));
const batchReads = () => mockDb.requests.filter((r) => r.table === 'batches_with_stock').length;
const reset = () => { mockDb.requests = []; mockDb.billRpcArgs = null; };

// Run a cart through the new createBill and the legacy loop; return both outcomes.
async function both(items) {
  reset();
  const current = await billing.createBill({ payment_mode: 'cash', items }, 'u1')
    .then(() => ({ items: mockDb.billRpcArgs.p_items }), (e) => ({ error: { statusCode: e.statusCode, code: e.code, message: e.message } }));
  const newBatchReads = batchReads();
  const newRequests = mockDb.requests.length;
  reset();
  const legacy = await legacyResolve(items)
    .then((resolved) => ({ items: resolved }), (e) => ({ error: { statusCode: e.statusCode, code: e.code, message: e.message } }));
  return { current, legacy, newBatchReads, newRequests, legacyBatchReads: batchReads() };
}

beforeEach(() => {
  seed();
  mockDb.maxRows = Infinity;
  mockDb.failTable = null;
  mockDb.failWhen = null;
  mockDb.omitCount = false;
  mockCaps.looseUnits = true;
  reset();
});

// ── 1, 2: request counts ────────────────────────────────────────────────────
describe('createBill reads batches once per bill, not once per medicine', () => {
  test.each([1, 5, 20])('%i distinct medicines → one batch read, same p_items as before', async (n) => {
    const r = await both(cartOf(n));
    expect(r.legacyBatchReads).toBe(n);
    expect(r.newBatchReads).toBe(1);
    // batches + create_bill_atomic + bills_with_totals + bill_items + audit_logs (no phone, so no adherence read)
    expect(r.newRequests).toBe(5);
    expect(r.current).toEqual(r.legacy);
  });

  test('duplicate lines of one medicine are merged before the single read', async () => {
    const items = [{ medicine_id: 'm1', qty: 1 }, { medicine_id: 'm2', qty: 1 }, { medicine_id: 'm1', qty: 2 }];
    const r = await both(items);
    expect(r.newBatchReads).toBe(1);
    expect(r.legacyBatchReads).toBe(2);
    expect(r.current).toEqual(r.legacy);

    reset();
    await billing.createBill({ payment_mode: 'cash', items }, 'u1');
    const q = mockDb.requests.find((x) => x.table === 'batches_with_stock');
    expect(q.ops.find(([op]) => op === 'in')[2]).toEqual(['m1', 'm2']);   // each id once, cart order
  });
});

// ── 3, 4: grouping and order ────────────────────────────────────────────────
describe('getAvailableBatchesFEFOForMedicines', () => {
  test('every requested medicine gets a group, holding only its own sellable batches', async () => {
    const groups = await inventory.getAvailableBatchesFEFOForMedicines(['m3', 'empty', 'm7', 'm3']);
    expect([...groups.keys()]).toEqual(['m3', 'empty', 'm7']);
    expect(groups.get('empty')).toEqual([]);
    for (const [medicineId, rows] of groups) {
      for (const row of rows) {
        expect(row.medicine_id).toBe(medicineId);
        expect(row.exp_date >= '2026-01-01').toBe(true);     // the expired batch is gone
        expect(row.stock_qty > 0 || row.loose_qty > 0).toBe(true);
      }
    }
  });

  test('each group is in ascending expiry order and equals the single-medicine lookup', async () => {
    const all = [...ids(20), 'tab', 'syrup'];
    const groups = await inventory.getAvailableBatchesFEFOForMedicines(all);
    for (const id of all) {
      const rows = groups.get(id);
      const dates = rows.map((r) => r.exp_date);
      expect(dates).toEqual([...dates].sort());
      const single = await inventory.getAvailableBatchesFEFO(id);
      expect(rows.map(({ medicine_id, ...rest }) => rest)).toEqual(single);
    }
  });

  test('loose-only batches stay in the pool when loose units are migrated', async () => {
    const groups = await inventory.getAvailableBatchesFEFOForMedicines(['tab']);
    expect(groups.get('tab').map((r) => r.exp_date)).toEqual([FUTURE(2), FUTURE(5), FUTURE(9)]);
  });

  test('without the loose-unit migration: sealed stock only, no loose columns, same as before', async () => {
    mockCaps.looseUnits = false;
    const groups = await inventory.getAvailableBatchesFEFOForMedicines(['tab', 'm1']);
    expect(groups.get('tab').map((r) => r.exp_date)).toEqual([FUTURE(2), FUTURE(9)]);
    expect(groups.get('tab')[0]).not.toHaveProperty('loose_qty');
    expect(groups.get('tab').map(({ medicine_id, ...rest }) => rest)).toEqual(await inventory.getAvailableBatchesFEFO('tab'));
    const q = mockDb.requests.find((x) => x.table === 'batches_with_stock');
    expect(q.ops.some(([op, col]) => op === 'gt' && col === 'stock_qty')).toBe(true);
    expect(q.ops.some(([op]) => op === 'or')).toBe(false);
  });

  test('uses the IST date as "today", like the single lookup', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-31T19:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      await inventory.getAvailableBatchesFEFOForMedicines(['m1']);
      const q = mockDb.requests.find((x) => x.table === 'batches_with_stock');
      expect(q.ops.find(([op, col]) => op === 'gte' && col === 'exp_date')[2]).toBe('2026-09-01');
    } finally {
      jest.useRealTimers();
    }
  });

  test('an empty list makes no request', async () => {
    const groups = await inventory.getAvailableBatchesFEFOForMedicines([]);
    expect(groups.size).toBe(0);
    expect(mockDb.requests).toHaveLength(0);
  });

  test('a very large cart is split into URL-safe chunks and still returns every group', async () => {
    const many = Array.from({ length: 150 }, (_, i) => `x${i}`).concat(['m1']);
    const groups = await inventory.getAvailableBatchesFEFOForMedicines(many);
    expect(batchReads()).toBe(2);
    expect(groups.size).toBe(151);
    expect(groups.get('m1').length).toBeGreaterThan(0);
  });
});

// ── 5, 6: allocation unchanged ──────────────────────────────────────────────
describe('allocation is identical to the per-medicine lookup', () => {
  test('multi-batch spill-over across several medicines', async () => {
    // m0 holds 1 + 2 units, m5 2 + 4, m11 2 + 4 (nearest expiry listed first)
    const items = [{ medicine_id: 'm0', qty: 3 }, { medicine_id: 'm5', qty: 5 }, { medicine_id: 'm11', qty: 5 }];
    const r = await both(items);
    expect(r.current.error).toBeUndefined();
    expect(r.current).toEqual(r.legacy);
    for (const id of ['m0', 'm5', 'm11']) {
      expect(r.current.items.filter((l) => l.medicine_id === id)).toHaveLength(2);    // spilled into a second batch
    }
  });

  test('sealed, loose and mixed lines, including a loose-only batch', async () => {
    for (const items of [
      [{ medicine_id: 'tab', qty: 2 }],                                   // sealed only
      [{ medicine_id: 'tab', qty: 0, loose_qty: 7 }],                     // loose: existing loose first, then open
      [{ medicine_id: 'tab', qty: 3, loose_qty: 25 }],                    // mixed, opens packs
      [{ medicine_id: 'tab', qty: 1, loose_qty: 4 }, { medicine_id: 'm2', qty: 2 }, { medicine_id: 'tab', qty: 1 }],
    ]) {
      const r = await both(items);
      expect(r.current).toEqual(r.legacy);
      expect(r.current.items).toBeDefined();
    }
  });

  test('the same allocation without the loose-unit migration', async () => {
    mockCaps.looseUnits = false;
    const r = await both([{ medicine_id: 'tab', qty: 5 }, { medicine_id: 'm9', qty: 2 }]);
    expect(r.current.error).toBeUndefined();
    expect(r.current).toEqual(r.legacy);
  });
});

// ── 7, 8: errors unchanged ──────────────────────────────────────────────────
describe('errors are the same as before, and the first failing line wins', () => {
  test('insufficient sealed stock', async () => {
    const r = await both([{ medicine_id: 'm4', qty: 999 }]);
    expect(r.current).toEqual(r.legacy);
    expect(r.current.error).toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    expect(r.current.error.message).toMatch(/^Insufficient stock for "Medicine 4"\. Available: \d+, requested: 999\.$/);
  });

  test('a medicine with no batches at all', async () => {
    const r = await both([{ medicine_id: 'empty', qty: 1 }]);
    expect(r.current).toEqual(r.legacy);
    expect(r.current.error.message).toBe('Insufficient stock for "Never Stocked". Available: 0, requested: 1.');
  });

  test('insufficient loose units, and loose units of an unsplittable medicine', async () => {
    for (const items of [
      [{ medicine_id: 'tab', qty: 0, loose_qty: 999 }],
      [{ medicine_id: 'syrup', qty: 0, loose_qty: 2 }],
    ]) {
      const r = await both(items);
      expect(r.current).toEqual(r.legacy);
    }
    expect((await both([{ medicine_id: 'syrup', qty: 0, loose_qty: 2 }])).current.error.code).toBe('LOOSE_SALE_UNSUPPORTED');
  });

  test('with several short lines, the first one in cart order is reported', async () => {
    const items = [
      { medicine_id: 'm1', qty: 1 },
      { medicine_id: 'm8', qty: 500 },          // first failure
      { medicine_id: 'tab', qty: 0, loose_qty: 999 },
      { medicine_id: 'm3', qty: 500 },
    ];
    const r = await both(items);
    expect(r.current).toEqual(r.legacy);
    expect(r.current.error.message).toContain('"Medicine 8"');
    expect(mockDb.billRpcArgs).toBeNull();
  });

  test('a failed batch query is the same 500, and nothing is written', async () => {
    mockDb.failTable = 'batches_with_stock';
    const r = await both(cartOf(3));
    expect(r.current).toEqual(r.legacy);
    expect(r.current.error).toEqual({ statusCode: 500, code: 'DB_ERROR', message: 'Failed to fetch available batches.' });
    reset();
    await billing.createBill({ payment_mode: 'cash', items: cartOf(3) }, 'u1').catch(() => {});
    expect(mockDb.requests.some((x) => x.rpc)).toBe(false);
  });

  test('a response that cannot report its row count is refused rather than trusted', async () => {
    mockDb.omitCount = true;
    await expect(inventory.getAvailableBatchesFEFOForMedicines(['m1']))
      .rejects.toMatchObject({ statusCode: 500, code: 'DB_ERROR' });
  });
});

// ── 10: no silent truncation ────────────────────────────────────────────────
describe('a server row cap never truncates the batch list', () => {
  test('rows withheld by max_rows are paged in, and the bill is unchanged', async () => {
    const unlimited = await both(cartOf(20, 2));
    mockDb.maxRows = 7;                                   // 20 medicines × 2 sellable batches = 40 rows
    reset();
    const groups = await inventory.getAvailableBatchesFEFOForMedicines(ids(20));
    expect([...groups.values()].reduce((s, g) => s + g.length, 0)).toBe(40);
    for (const rows of groups.values()) {
      const dates = rows.map((r) => r.exp_date);
      expect(dates).toEqual([...dates].sort());
    }
    // The counted read is page one (7 rows) of the same total order; reading
    // continues after it: ceil(40 / 7) = 6 reads in all, nothing read twice.
    expect(batchReads()).toBe(6);

    reset();
    await billing.createBill({ payment_mode: 'cash', items: cartOf(20, 2) }, 'u1');
    expect(mockDb.billRpcArgs.p_items).toEqual(unlimited.current.items);
  });

  test('a count that is an exact multiple of the page size stops without an extra request', async () => {
    mockDb.maxRows = 8;                                   // 40 rows = 5 full pages
    await inventory.getAvailableBatchesFEFOForMedicines(ids(20));
    expect(batchReads()).toBe(5);                        // page one plus four more, no empty probe
  });

  test('a result too large to page safely is an error, never a short list', async () => {
    mockDb.maxRows = 1;                                   // one row per page…
    const big = [];
    for (let i = 0; i < 60; i++) big.push(batch('huge', FUTURE(1 + (i % 12)), 1));
    mockDb.batches.push(...big);                          // …so 60 rows need 60 pages, over the 50-page guard
    await expect(inventory.getAvailableBatchesFEFOForMedicines(['huge']))
      .rejects.toMatchObject({ statusCode: 500, code: 'DB_ERROR' });
  });
});

// ── Review: same-expiry batches ─────────────────────────────────────────────
// Invoice import puts every expiry on the last day of its month, so batches of
// one medicine often share an exp_date, at different prices. Ordered by expiry
// alone their order was the query plan's choice, and the single and the bulk
// query disagreed on it in PostgreSQL. Ties now go to the batch entered first.
describe('same-expiry batches are sold in a fixed order on every path', () => {
  const TIE = FUTURE(8);
  const seedTies = () => {
    mockDb.medicines.tie = 'Tied Tablets';
    // Stored newest-first, so neither table order nor id order gives the answer.
    mockDb.batches.push(
      batch('tie', TIE, 2, { id: 'tie-a', created_at: '2026-06-02T10:00:00Z', selling_price: '25.00', mrp: '30.00' }),
      batch('tie', TIE, 2, { id: 'tie-c', created_at: '2026-05-01T10:00:00Z', selling_price: '21.00', mrp: '30.00' }),
      batch('tie', TIE, 2, { id: 'tie-b', created_at: '2026-05-01T10:00:00Z', selling_price: '22.00', mrp: '30.00' }),
      batch('tie', FUTURE(7), 1, { id: 'tie-early', created_at: '2026-07-01T10:00:00Z', selling_price: '19.00', mrp: '30.00' }),
    );
  };
  const expected = ['tie-early', 'tie-b', 'tie-c', 'tie-a'];   // expiry, then entered first, then id

  test('both lookups ask for expiry, then entered-first, then id', async () => {
    await inventory.getAvailableBatchesFEFO('m1');
    await inventory.getAvailableBatchesFEFOForMedicines(['m1']);
    for (const q of mockDb.requests.filter((r) => r.table === 'batches_with_stock')) {
      expect(q.ops.filter(([op]) => op === 'order').map(([, col, opt]) => [col, opt.ascending]))
        .toEqual([['exp_date', true], ['created_at', true], ['id', true]]);
    }
  });

  test('single, bulk and paged lookups agree on the order', async () => {
    seedTies();
    const single = (await inventory.getAvailableBatchesFEFO('tie')).map((r) => r.id);
    const bulk = (await inventory.getAvailableBatchesFEFOForMedicines(['m2', 'tie', 'm9'])).get('tie').map((r) => r.id);
    mockDb.maxRows = 2;
    const paged = (await inventory.getAvailableBatchesFEFOForMedicines(['m2', 'tie', 'm9'])).get('tie').map((r) => r.id);
    expect(single).toEqual(expected);
    expect(bulk).toEqual(expected);
    expect(paged).toEqual(expected);
  });

  test('a bill takes the earlier-expiring batch first, then the tied batch entered first, at its own price', async () => {
    seedTies();
    reset();
    await billing.createBill({ payment_mode: 'cash', items: [{ medicine_id: 'tie', qty: 3 }] }, 'u1');
    expect(mockDb.billRpcArgs.p_items.map((l) => [l.batch_id, l.qty, l.unit_price])).toEqual([
      ['tie-early', 1, 19],   // expiry still comes first, whenever a batch was entered
      ['tie-b', 2, 22],       // same expiry and same receipt time as tie-c: id decides
    ]);
  });

  test('the allocation is the same through the bulk read and through the per-medicine fallback', async () => {
    seedTies();
    const items = [{ medicine_id: 'tie', qty: 5 }, { medicine_id: 'm4', qty: 1 }];
    reset();
    await billing.createBill({ payment_mode: 'cash', items }, 'u1');
    const viaBulk = mockDb.billRpcArgs.p_items;
    mockDb.failWhen = (q) => (q.ops.find(([op]) => op === 'in')?.[2] || []).length > 1;   // bulk read only
    reset();
    await billing.createBill({ payment_mode: 'cash', items }, 'u1');
    expect(mockDb.billRpcArgs.p_items).toEqual(viaBulk);
  });

  // ── Equal expiry, different prices: what the bill actually charges ──────
  // `created_at` is when a batch row was entered, not when goods arrived (see
  // fefoOrder). These pin the full allocation sent to create_bill_atomic:
  // which batch, how many, at which selling price and MRP, and for loose lines
  // the per-unit prices, contents and packs opened. Rows are stored newest-first
  // so the order cannot come from storage order.
  describe('equal-expiry batches at different prices', () => {
    const LOOSE = { effective_content_quantity: 10, effective_content_unit: 'TABLET', loose_sale_supported: true };
    const priced = (id, created_at, price, mrp, sealed, extra = {}) =>
      batch('pr', TIE, sealed, { id, created_at, selling_price: price, mrp, ...extra });
    const sell = async (item) => {
      mockDb.medicines.pr = 'Priced Tablets';
      reset();
      await billing.createBill({ payment_mode: 'cash', customer_name: 'Asha', items: [item] }, 'u1');
      return mockDb.billRpcArgs;
    };

    test('created_at decides: the batch entered first is sold, though it is the dearer one', async () => {
      mockDb.batches.push(
        priced('pr-newer', '2026-06-01T09:00:00Z', '18.00', '24.00', 5),
        priced('pr-older', '2026-05-01T09:00:00Z', '22.00', '28.00', 5),
      );
      const { p_items: items } = await sell({ medicine_id: 'pr', qty: 1 });
      expect(items).toEqual([
        { medicine_id: 'pr', batch_id: 'pr-older', qty: 1, unit_price: 22, mrp: 28, is_loose: false },
      ]);
    });

    test('a sale that spills across the tie charges each batch its own price and MRP', async () => {
      mockDb.batches.push(
        priced('pr-newer', '2026-06-01T09:00:00Z', '18.00', '24.00', 5),
        priced('pr-older', '2026-05-01T09:00:00Z', '22.00', '28.00', 2),
      );
      const { p_items: items } = await sell({ medicine_id: 'pr', qty: 3 });
      expect(items).toEqual([
        { medicine_id: 'pr', batch_id: 'pr-older', qty: 2, unit_price: 22, mrp: 28, is_loose: false },
        { medicine_id: 'pr', batch_id: 'pr-newer', qty: 1, unit_price: 18, mrp: 24, is_loose: false },
      ]);
    });

    test('the complete payload for a mixed sealed + loose line across tied batches', async () => {
      mockDb.batches.push(
        priced('pr-newer', '2026-06-01T09:00:00Z', '20.00', '25.00', 4, LOOSE),
        priced('pr-older', '2026-05-01T09:00:00Z', '30.00', '35.00', 2, LOOSE),
      );
      const args = await sell({ medicine_id: 'pr', qty: 3, loose_qty: 5 });
      // Sealed: the entered-first batch's 2 packs, then 1 from the next.
      // Loose: the entered-first batch has no pack left to open, so one pack of
      // the next is opened — 5 of its 10 tablets at its own per-tablet price.
      expect(args.p_items).toEqual([
        { medicine_id: 'pr', batch_id: 'pr-older', qty: 2, unit_price: 30, mrp: 35, is_loose: false },
        { medicine_id: 'pr', batch_id: 'pr-newer', qty: 1, unit_price: 20, mrp: 25, is_loose: false },
        {
          medicine_id: 'pr', batch_id: 'pr-newer', qty: 5, unit_price: 2, mrp: 2.5,
          is_loose: true, content_quantity: 10, strips_to_open: 1,
        },
      ]);
      expect(args.p_bill).toEqual({ customer_name: 'Asha', payment_mode: 'cash', created_by: 'u1' });
      expect(batchReads()).toBe(1);
      expect(mockDb.requests.filter((r) => r.rpc === 'create_bill_atomic')).toHaveLength(1);
    });

    test('loose units come from the batch entered first, even when a later one has loose tablets ready', async () => {
      mockDb.batches.push(
        priced('pr-newer', '2026-06-01T09:00:00Z', '20.00', '25.00', 4, { ...LOOSE, loose_qty: 6 }),
        priced('pr-older', '2026-05-01T09:00:00Z', '30.00', '35.00', 4, { ...LOOSE, loose_qty: 3 }),
      );
      const { p_items: items } = await sell({ medicine_id: 'pr', qty: 0, loose_qty: 5 });
      // 3 already-loose tablets plus 2 from one newly opened pack, all from the
      // entered-first batch, priced from ITS pack: 30.00 / 10 and 35.00 / 10.
      expect(items).toEqual([
        {
          medicine_id: 'pr', batch_id: 'pr-older', qty: 5, unit_price: 3, mrp: 3.5,
          is_loose: true, content_quantity: 10, strips_to_open: 1,
        },
      ]);
    });

    test('the same allocation comes back through the per-medicine fallback', async () => {
      mockDb.batches.push(
        priced('pr-newer', '2026-06-01T09:00:00Z', '20.00', '25.00', 4, LOOSE),
        priced('pr-older', '2026-05-01T09:00:00Z', '30.00', '35.00', 2, LOOSE),
      );
      const viaBulk = (await sell({ medicine_id: 'pr', qty: 3, loose_qty: 5 })).p_items;
      mockDb.failWhen = (q) => (q.ops.find(([op]) => op === 'in')?.[2] || []).length > 1;
      const warn = jest.spyOn(require('../../src/utils/logger'), 'warn').mockImplementation(() => {});
      try {
        // A second medicine makes the cart's first read a multi-id (bulk) read.
        mockDb.medicines.pr = 'Priced Tablets';
        reset();
        await billing.createBill({ payment_mode: 'cash', customer_name: 'Asha', items: [{ medicine_id: 'pr', qty: 3, loose_qty: 5 }, { medicine_id: 'm4', qty: 1 }] }, 'u1');
        expect(batchReads()).toBe(1 + 2);   // failed bulk read, then one per medicine
        expect(mockDb.billRpcArgs.p_items.filter((l) => l.medicine_id === 'pr')).toEqual(viaBulk);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

// ── Review: which error wins when the bulk read itself fails ────────────────
describe('a failed bulk read keeps the old error precedence, and never hides the failure', () => {
  const idsIn = (q) => q.ops.find(([op]) => op === 'in')?.[2] || [q.ops.find(([op, col]) => op === 'eq' && col === 'medicine_id')?.[2]];
  const failBulk = (q) => idsIn(q).length > 1;
  const failFor = (id) => (q) => idsIn(q).length === 1 && idsIn(q)[0] === id;
  const logger = require('../../src/utils/logger');
  let warn;
  beforeEach(() => { warn = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  test('a short line ahead of the failure is reported, as the per-medicine loop reported it', async () => {
    mockDb.failWhen = failBulk;
    const items = [{ medicine_id: 'm1', qty: 999 }, { medicine_id: 'm2', qty: 1 }];
    const r = await both(items);
    expect(r.current).toEqual(r.legacy);
    expect(r.current.error).toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'boom', code: 'XX000', medicines: 2 }),
      'Bulk FEFO lookup failed; resolving the cart one medicine at a time'
    );
  });

  test('a failure on a later line still loses to a short line before it', async () => {
    mockDb.failWhen = (q) => failBulk(q) || failFor('m3')(q);
    const r = await both([{ medicine_id: 'm1', qty: 999 }, { medicine_id: 'm3', qty: 1 }]);
    expect(r.current).toEqual(r.legacy);
    expect(r.current.error.code).toBe('INSUFFICIENT_STOCK');
  });

  test('a failure reached before any short line is the 500 it always was', async () => {
    mockDb.failWhen = (q) => failBulk(q) || failFor('m1')(q);
    const r = await both([{ medicine_id: 'm1', qty: 1 }, { medicine_id: 'm3', qty: 999 }]);
    expect(r.current).toEqual(r.legacy);
    expect(r.current.error).toEqual({ statusCode: 500, code: 'DB_ERROR', message: 'Failed to fetch available batches.' });
  });

  test('a transient bulk failure that the per-medicine reads get past still produces the same bill', async () => {
    const items = cartOf(5, 2);
    const clean = await both(items);
    mockDb.failWhen = failBulk;
    reset();
    await billing.createBill({ payment_mode: 'cash', items }, 'u1');
    expect(mockDb.billRpcArgs.p_items).toEqual(clean.current.items);
    // the failed bulk read, then one read per medicine
    expect(batchReads()).toBe(1 + 5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('when the database is down, the bill fails after two reads, not one per medicine', async () => {
    mockDb.failTable = 'batches_with_stock';
    reset();
    await expect(billing.createBill({ payment_mode: 'cash', items: cartOf(20) }, 'u1'))
      .rejects.toMatchObject({ statusCode: 500, code: 'DB_ERROR' });
    expect(batchReads()).toBe(2);
    expect(mockDb.requests.some((x) => x.rpc)).toBe(false);
  });

  test('a response that cannot vouch for itself is refused outright, not retried around the guard', async () => {
    mockDb.omitCount = true;
    reset();
    await expect(billing.createBill({ payment_mode: 'cash', items: cartOf(3) }, 'u1'))
      .rejects.toMatchObject({ statusCode: 500, code: 'DB_ERROR' });
    expect(batchReads()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('the database error stays out of the HTTP response', async () => {
    mockDb.failTable = 'batches_with_stock';
    const { errorHandler } = require('../../src/middleware/errorHandler');
    const err = await billing.createBill({ payment_mode: 'cash', items: cartOf(1) }, 'u1').catch((e) => e);
    expect(err.fefoQueryError).toMatchObject({ message: 'boom' });
    const res = { status: jest.fn(() => res), json: jest.fn() };
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    errorHandler(err, { originalUrl: '/api/v1/billing', method: 'POST' }, res, () => {});
    error.mockRestore();
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({ error: 'DB_ERROR', message: 'Failed to fetch available batches.' });
    expect(JSON.stringify(body)).not.toContain('boom');
  });
});
