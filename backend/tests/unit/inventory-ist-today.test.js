/**
 * "Today", for expiry, is the pharmacy's date (IST), not UTC's.
 * Pure: Supabase and the capability probe are stubbed and the clock is fixed.
 *
 * 00:30 IST on 1 September is still 31 August in UTC. Against a UTC "today", a
 * batch that expired on 31 August stayed on sale until 05:30 IST. Invoice
 * expiries normalise to the last day of the month, so that window opened on the
 * first morning of every month, for most of the stock in the shop.
 */

const mockCalls = [];

jest.mock('../../src/config/supabase', () => {
  const from = (table) => {
    const builder = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
        }
        if (prop === 'single') {
          return () => Promise.resolve({ data: table === 'medicines' ? { id: 'm1', name: 'Dolo 650' } : null, error: null });
        }
        return (...args) => { mockCalls.push([table, prop, ...args]); return builder; };
      },
    });
    return builder;
  };
  return { supabase: { from } };
});
jest.mock('../../src/config/capabilities', () => ({ hasLooseUnits: async () => true }));
jest.mock('../../src/utils/audit', () => ({ logAudit: jest.fn() }));

const inventory = require('../../src/modules/inventory/inventory.service');

const expiryFloor = () => mockCalls
  .find(([table, method, column]) => table === 'batches_with_stock' && method === 'gte' && column === 'exp_date')?.[3];

// Only Date is of interest; the rest of the timer machinery stays real.
const at = (iso) => jest.useFakeTimers({ now: new Date(iso), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

afterEach(() => {
  jest.useRealTimers();
  mockCalls.length = 0;
});

describe('expiry is judged against the IST date', () => {
  test('at 00:30 IST on the 1st, the till no longer offers batches that expired on the 31st', async () => {
    at('2026-08-31T19:00:00Z');
    await inventory.getAvailableBatchesFEFO('m1');
    expect(expiryFloor()).toBe('2026-09-01');
  });

  test('the batch list draws the same line', async () => {
    at('2026-08-31T19:00:00Z');
    await inventory.listBatchesForMedicine('m1', { role: 'owner' });
    expect(expiryFloor()).toBe('2026-09-01');
  });

  test('23:30 IST is still the same IST day', async () => {
    at('2026-09-01T18:00:00Z');
    await inventory.getAvailableBatchesFEFO('m1');
    expect(expiryFloor()).toBe('2026-09-01');
  });

  test('a batch expiring on the 31st cannot be taken into stock at 00:30 IST on the 1st', async () => {
    at('2026-08-31T19:00:00Z');
    await expect(inventory.addBatch({
      medicine_id: 'm1', batch_no: 'ab1', exp_date: '2026-08-31',
      unit_cost: 5, mrp: 12, selling_price: 10, opening_qty: 0,
    }, 'u1')).rejects.toMatchObject({ code: 'EXPIRED_BATCH' });
  });
});
