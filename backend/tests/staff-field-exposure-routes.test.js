/**
 * Criterion A9 at the API boundary: owner-only purchase data must be absent
 * from staff RESPONSES, not merely unrendered. HERMETIC.
 *
 * No network, no credentials — but backend/.env must exist, because app.js
 * validates config at require time. Runs in CI.
 *
 * The Supabase stub answers every batch query with a row that DOES carry
 * unit_cost, supplier_id, po_id and created_by, whatever columns were asked
 * for. So a staff test passing proves the API removed them, not that a polite
 * stub never sent them — and the owner tests prove the same assertions can fail.
 */

const mockSession = { id: 'u1', role: 'staff' };
const mockQueries = [];

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: mockSession.id, full_name: 'Test User', is_active: true, role: mockSession.role };
    next();
  },
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role) ? next()
      : next(Object.assign(new Error('You do not have permission to perform this action.'), {
        statusCode: 403, code: 'FORBIDDEN', isOperational: true,
      }))
  ),
}));

jest.mock('../src/config/supabase', () => {
  const BATCH = {
    id: 'b1', medicine_id: 'm1', batch_no: 'AB1', mfg_date: null, exp_date: '2027-01-31',
    unit_cost: 12.5, supplier_id: 's1', po_id: 'p1', created_by: 'u9',
    mrp: 20, selling_price: 18, medicine_name: 'Dolo 650', medicine_unit: 'strips',
    category_name: 'Analgesics', category_color: 'mint', stock_qty: 5, expiry_status: 'ok',
    sealed_qty: 5, loose_qty: 0, effective_content_quantity: 15, effective_content_unit: 'TABLET',
    loose_sale_supported: true,
  };
  const rows = (table) => (table === 'batches_with_stock' ? [BATCH] : []);

  // Records every builder call and resolves like PostgREST. A Proxy, so a
  // service can chain any filter method without this stub having to list it.
  const from = (table) => {
    const query = { table, calls: [] };
    mockQueries.push(query);
    const builder = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve({ data: rows(table), error: null, count: 0 }).then(resolve, reject);
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve({ data: rows(table)[0] || null, error: null });
        }
        return (...args) => { query.calls.push([prop, ...args]); return builder; };
      },
    });
    return builder;
  };

  return {
    supabase: { from, rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) }, auth: {} },
    createAuthClient: () => ({}),
  };
});

const request = require('supertest');
const app = require('../src/app');

const API = '/api/v1';
const UUID = '11111111-2222-4333-8444-555555555555';
const OWNER_ONLY = ['unit_cost', 'supplier_id', 'po_id', 'created_by'];

const asRole = (role) => { mockSession.role = role; };
const selectOn = (table) => mockQueries.filter((q) => q.table === table)
  .flatMap((q) => q.calls.filter(([method]) => method === 'select').map(([, columns]) => columns));
const carries = (body, field) => JSON.stringify(body).includes(`"${field}"`);

beforeEach(() => {
  mockQueries.length = 0;
  asRole('staff');
});

describe('GET /inventory/:medicineId/batches', () => {
  test('staff: cost and supplier columns are neither selected nor returned', async () => {
    const r = await request(app).get(`${API}/inventory/${UUID}/batches`);
    expect(r.status).toBe(200);

    const [columns] = selectOn('batches_with_stock');
    expect(columns).not.toBe('*');
    for (const field of OWNER_ONLY) {
      expect(columns).not.toContain(field);
      expect(carries(r.body, field)).toBe(false);
    }
    // What the staff batch card renders is still there, loose stock included.
    expect(r.body.data.batches[0]).toMatchObject({
      batch_no: 'AB1', exp_date: '2027-01-31', mrp: 20, selling_price: 18, stock_qty: 5,
      loose_qty: 0, effective_content_unit: 'TABLET', loose_sale_supported: true,
    });
  });

  test('staff: column requests in the query string do not add them back', async () => {
    const r = await request(app)
      .get(`${API}/inventory/${UUID}/batches?select=*,unit_cost&columns=unit_cost&includeExpired=true`);
    expect(r.status).toBe(200);
    for (const field of OWNER_ONLY) expect(carries(r.body, field)).toBe(false);
  });

  test('owner: receives the whole row — the assertions above can fail', async () => {
    asRole('owner');
    const r = await request(app).get(`${API}/inventory/${UUID}/batches?includeExpired=true`);
    expect(r.status).toBe(200);
    expect(selectOn('batches_with_stock')).toEqual(['*']);
    expect(r.body.data.batches[0]).toMatchObject({ unit_cost: 12.5, supplier_id: 's1', po_id: 'p1' });
  });
});

describe('GET /inventory/batch/:batchId', () => {
  test('staff are refused before anything is read', async () => {
    const r = await request(app).get(`${API}/inventory/batch/${UUID}`);
    expect([r.status, r.body.error]).toEqual([403, 'FORBIDDEN']);
    expect(selectOn('batches_with_stock')).toEqual([]);
  });

  test('owner still reads it, cost included', async () => {
    asRole('owner');
    const r = await request(app).get(`${API}/inventory/batch/${UUID}`);
    expect(r.status).toBe(200);
    expect(r.body.data.batch.unit_cost).toBe(12.5);
  });
});

describe('GET /suppliers and /suppliers/:id', () => {
  test.each([
    ['the list', `${API}/suppliers`],
    ['a single supplier', `${API}/suppliers/${UUID}`],
  ])('staff are refused %s before anything is read', async (_label, url) => {
    const r = await request(app).get(url);
    expect([r.status, r.body.error]).toEqual([403, 'FORBIDDEN']);
    expect(mockQueries.filter((q) => ['suppliers', 'supplier_balances'].includes(q.table))).toEqual([]);
  });

  test('staff keep /suppliers/options — the Add Batch form needs it', async () => {
    const r = await request(app).get(`${API}/suppliers/options`);
    expect(r.status).toBe(200);
  });

  test('owner still lists suppliers', async () => {
    asRole('owner');
    const r = await request(app).get(`${API}/suppliers`);
    expect(r.status).toBe(200);
  });
});

describe('listBatchesForMedicine', () => {
  test('refuses to run without an actor rather than defaulting to the owner view', async () => {
    const { listBatchesForMedicine } = require('../src/modules/inventory/inventory.service');
    await expect(listBatchesForMedicine(UUID)).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
  });
});
