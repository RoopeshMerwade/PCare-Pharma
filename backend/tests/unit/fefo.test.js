/**
 * Unit tests — billing domain logic (pure, no database).
 * These run without TEST_* credentials or a Supabase project.
 */

const { mergeCartItems, allocateFefo, partitionWarnings } = require('../../src/modules/billing/fefo');

const batch = (id, stock, exp, price = 10, mrp = 12) =>
  ({ id, stock_qty: stock, exp_date: exp, selling_price: price, mrp });

describe('allocateFefo', () => {
  test('consumes a single batch when it covers the quantity', () => {
    const { lines, shortfall } = allocateFefo([batch('b1', 10, '2026-09-01')], 4);
    expect(shortfall).toBe(0);
    expect(lines).toEqual([{ batch_id: 'b1', qty: 4, unit_price: 10, mrp: 12 }]);
  });

  test('spills over to the next batch in expiry order', () => {
    const { lines, shortfall } = allocateFefo(
      [batch('near', 3, '2026-09-01'), batch('far', 10, '2027-01-01')], 5);
    expect(shortfall).toBe(0);
    expect(lines.map(l => [l.batch_id, l.qty])).toEqual([['near', 3], ['far', 2]]);
  });

  test('nearest-expiry batch is always consumed first (FEFO invariant)', () => {
    const { lines } = allocateFefo(
      [batch('exp-first', 100, '2026-08-20'), batch('exp-later', 100, '2026-12-31')], 1);
    expect(lines).toHaveLength(1);
    expect(lines[0].batch_id).toBe('exp-first');
  });

  test('reports shortfall when total stock is insufficient', () => {
    const { lines, shortfall } = allocateFefo(
      [batch('b1', 2, '2026-09-01'), batch('b2', 1, '2026-10-01')], 5);
    expect(shortfall).toBe(2);
    expect(lines.map(l => l.qty)).toEqual([2, 1]);
  });

  test('no batches at all → full shortfall, no lines', () => {
    const { lines, shortfall } = allocateFefo([], 3);
    expect(lines).toEqual([]);
    expect(shortfall).toBe(3);
  });

  test('prices are captured per batch (snapshot pricing)', () => {
    const { lines } = allocateFefo(
      [batch('cheap', 1, '2026-09-01', 8, 10), batch('dear', 5, '2026-10-01', 11, 15)], 3);
    expect(lines).toEqual([
      { batch_id: 'cheap', qty: 1, unit_price: 8, mrp: 10 },
      { batch_id: 'dear', qty: 2, unit_price: 11, mrp: 15 },
    ]);
  });
});

describe('mergeCartItems', () => {
  test('merges duplicate medicine lines by summing quantities', () => {
    const merged = mergeCartItems([
      { medicine_id: 'm1', qty: 2 },
      { medicine_id: 'm2', qty: 1 },
      { medicine_id: 'm1', qty: 3 },
    ]);
    expect(merged).toEqual([
      { medicine_id: 'm1', qty: 5 },
      { medicine_id: 'm2', qty: 1 },
    ]);
  });

  test('leaves distinct medicines untouched', () => {
    const items = [{ medicine_id: 'a', qty: 1 }, { medicine_id: 'b', qty: 2 }];
    expect(mergeCartItems(items)).toEqual(items);
  });
});

describe('partitionWarnings (adherence acknowledgment gate)', () => {
  const w = (id) => ({ schedule_id: id, status: 'overdue' });

  test('unacknowledged warnings are surfaced (drives the 409)', () => {
    const { unacknowledged } = partitionWarnings([w('s1'), w('s2')], [{ schedule_id: 's1' }]);
    expect(unacknowledged.map(x => x.schedule_id)).toEqual(['s2']);
  });

  test('fully acknowledged → sale proceeds (never blocks, per product decision)', () => {
    const { unacknowledged } = partitionWarnings([w('s1')], [{ schedule_id: 's1' }]);
    expect(unacknowledged).toEqual([]);
  });

  test('no acknowledgments provided → everything unacknowledged', () => {
    const { unacknowledged } = partitionWarnings([w('s1')], undefined);
    expect(unacknowledged).toHaveLength(1);
  });
});
