/**
 * Unit tests — dashboard week/month totals. Pure: the Supabase client is a
 * fake, no credentials and no network.
 *
 * The dashboard used to fetch every bill in the week and every bill in the
 * month and sum them in Node. It now asks Postgres. The RPC that does the
 * summing, get_sales_totals_summary, lives in schema-32-in-db-aggregations.sql
 * — which is NOT listed in docs/MIGRATION-ORDER.md, so a correctly-migrated
 * database may not have it.
 *
 * So the acceptance criterion is not "the RPC works". It is that both paths
 * return the SAME numbers, and that the fallback engages on every way the RPC
 * can be missing.
 */

const mockRpc = jest.fn();
const mockFrom = jest.fn();

jest.mock('../../src/config/supabase', () => ({
  supabase: {
    rpc: (...args) => mockRpc(...args),
    from: (...args) => mockFrom(...args),
  },
  createAuthClient: () => ({}),
}));

const { salesTotals } = require('../../src/modules/dashboard/dashboard.service');

/** The bills the fallback would read, and the RPC's aggregate of exactly them.
 *  Kept together so the two paths cannot drift apart in the fixture itself. */
const BILLS = [
  { total: '120.50' },
  { total: '99.99' },
  { total: '1000' },
  { total: '0.01' },
];
const EXPECTED = { bill_count: 4, total_sales: 1220.5 };

/** A chainable stand-in for the postgrest builder, resolving to `rows`. */
function billsReturning(rows) {
  const builder = {
    select: () => builder,
    gte: () => builder,
    lte: () => Promise.resolve({ data: rows, error: null }),
  };
  return builder;
}

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockFrom.mockImplementation(() => billsReturning(BILLS));
});

describe('salesTotals — the RPC path', () => {
  test('uses the aggregate and touches no table', async () => {
    mockRpc.mockResolvedValue({ data: { count: 4, total: '1220.50' }, error: null });

    await expect(salesTotals('2026-01-01', '2026-01-31')).resolves.toEqual(EXPECTED);
    expect(mockRpc).toHaveBeenCalledWith('get_sales_totals_summary', {
      p_from: '2026-01-01', p_to: '2026-01-31',
    });
    // The whole point: no bills were fetched.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('coerces the RPC\'s numeric strings', async () => {
    // json_build_object emits numerics as strings over the wire.
    mockRpc.mockResolvedValue({ data: { count: '7', total: '42.75' }, error: null });
    await expect(salesTotals('2026-01-01', '2026-01-31'))
      .resolves.toEqual({ bill_count: 7, total_sales: 42.75 });
  });

  test('an empty window is zero, not NaN', async () => {
    mockRpc.mockResolvedValue({ data: { count: 0, total: 0 }, error: null });
    await expect(salesTotals('2026-01-01', '2026-01-01'))
      .resolves.toEqual({ bill_count: 0, total_sales: 0 });
  });
});

describe('salesTotals — the fallback path', () => {
  // Each of these is a real way schema-32 can be absent or unusable.
  test.each([
    ['the function does not exist (PGRST202)', () => mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })],
    ['the RPC returns null data', () => mockRpc.mockResolvedValue({ data: null, error: null })],
    ['the RPC throws', () => mockRpc.mockRejectedValue(new Error('network down'))],
  ])('falls back when %s', async (_label, arrange) => {
    arrange();
    await expect(salesTotals('2026-01-01', '2026-01-31')).resolves.toEqual(EXPECTED);
    expect(mockFrom).toHaveBeenCalledWith('bills_with_totals');
  });

  test('THE ACCEPTANCE TEST: both paths agree exactly', async () => {
    // daily_sales_summary buckets on `created_at at time zone 'Asia/Kolkata'`
    // and sums bills_with_totals.total with no status filter, which is what the
    // fallback computes over the same IST-anchored window. If this ever fails,
    // the optimisation has changed a number a pharmacist reads.
    mockRpc.mockResolvedValue({ data: { count: 4, total: '1220.50' }, error: null });
    const viaRpc = await salesTotals('2026-01-01', '2026-01-31');

    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    const viaFallback = await salesTotals('2026-01-01', '2026-01-31');

    expect(viaRpc).toEqual(viaFallback);
  });

  test('no bills in the window is zero, not a crash', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    mockFrom.mockImplementation(() => billsReturning([]));
    await expect(salesTotals('2026-01-01', '2026-01-31'))
      .resolves.toEqual({ bill_count: 0, total_sales: 0 });
  });

  test('a failed fallback query is zero, not a thrown dashboard', async () => {
    // getOwnerDashboard runs this inside Promise.allSettled, but a throw here
    // would still lose the tile. A missing figure must not take the page down.
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    mockFrom.mockImplementation(() => ({
      select: function () { return this; },
      gte: function () { return this; },
      lte: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    }));
    await expect(salesTotals('2026-01-01', '2026-01-31'))
      .resolves.toEqual({ bill_count: 0, total_sales: 0 });
  });
});
