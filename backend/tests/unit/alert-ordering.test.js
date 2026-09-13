/**
 * Unit tests — the equivalence Phase 7's bounded alert list rests on. Pure, no
 * database.
 *
 * `listLiveAlerts` no longer scans every non-`ok` batch and every low-stock
 * medicine. It asks the database for the first N of each source in a SQL order
 * and sorts the result with sortAlerts as before. That is only sound if the SQL
 * order agrees with sortAlerts' order — otherwise the cut falls in the wrong
 * place and an alert that should be on the list silently is not.
 *
 * These tests are the proof. If one fails, the ORDER BY in
 * notifications.service.js is wrong, not the test.
 */

const {
  buildExpiryAlerts,
  buildLowStockAlerts,
  sortAlerts,
} = require('../../src/modules/notifications/notifications.alerts');

/** A uuid-ish id whose lexical order is deliberately UNRELATED to expiry, so a
 *  test cannot pass by accident because ids happen to sort the right way. */
const idFor = (n) => `${String((n * 7919) % 1000).padStart(3, '0')}00000-0000-4000-8000-000000000000`;

/** exp_date n days from a fixed reference — the view derives urgency from the
 *  same distance, so the two stay consistent. */
function dateIn(days) {
  return new Date(Date.UTC(2026, 0, 1) + days * 86_400_000).toISOString().slice(0, 10);
}

function urgencyFor(days) {
  if (days < 0) return 'expired';
  if (days <= 30) return 'critical';
  if (days <= 60) return 'warning';
  if (days <= 90) return 'watch';
  return 'ok';
}

/** ~40 batches spread across all four tiers, generated in a scrambled order so
 *  neither insertion order nor id order can stand in for the real one. */
function expiryRows() {
  const offsets = [];
  for (let d = -20; d <= 90; d += 3) offsets.push(d);
  return offsets.map((days, i) => ({
    id: idFor(i + 1),
    medicine_name: `Medicine ${i}`,
    medicine_unit: 'strips',
    batch_no: `B${i}`,
    exp_date: dateIn(days),
    stock_qty: 10,
    loose_qty: 0,
    urgency: urgencyFor(days),
    days_to_expiry: days,
    potential_loss_value: 100,
  })).sort((a, b) => (a.id < b.id ? -1 : 1));   // scramble relative to exp_date
}

describe('expiry alerts — SQL order reproduces sortAlerts exactly', () => {
  test('ORDER BY exp_date asc, id asc == severity desc, onset asc, id asc', () => {
    const rows = expiryRows();

    // What the code does today: fetch everything, build, sort in JS.
    const sorted = sortAlerts(buildExpiryAlerts(rows)).map((a) => a.id);

    // What the database now returns: rows already ordered by exp_date, id.
    const bySql = [...rows].sort((a, b) => (
      a.exp_date < b.exp_date ? -1 : a.exp_date > b.exp_date ? 1 : (a.id < b.id ? -1 : 1)
    ));
    const fromSql = buildExpiryAlerts(bySql).map((a) => a.id);

    expect(fromSql).toEqual(sorted);
  });

  test('and therefore any prefix of the SQL order is the true top-N', () => {
    // This is the property the LIMIT depends on, stated directly.
    const rows = expiryRows();
    const sorted = sortAlerts(buildExpiryAlerts(rows)).map((a) => a.id);
    const bySql = [...rows].sort((a, b) => (
      a.exp_date < b.exp_date ? -1 : a.exp_date > b.exp_date ? 1 : (a.id < b.id ? -1 : 1)
    ));

    for (const n of [1, 5, 12, 25]) {
      const limited = buildExpiryAlerts(bySql.slice(0, n)).map((a) => a.id);
      expect(limited).toEqual(sorted.slice(0, n));
    }
  });

  test('severity is a decreasing function of exp_date — the reason it works', () => {
    const alerts = buildExpiryAlerts(expiryRows());
    const byDate = [...alerts].sort((a, b) => (a.metadata.exp_date < b.metadata.exp_date ? -1 : 1));
    for (let i = 1; i < byDate.length; i++) {
      expect(byDate[i].severity).toBeLessThanOrEqual(byDate[i - 1].severity);
    }
  });
});

describe('low-stock alerts — SQL order matches on tier', () => {
  const stockRows = [
    { id: idFor(11), name: 'A', unit: 'strips', total_stock: 0, low_stock_threshold: 20 },
    { id: idFor(12), name: 'B', unit: 'strips', total_stock: -3, low_stock_threshold: 20 },
    { id: idFor(13), name: 'C', unit: 'strips', total_stock: 4, low_stock_threshold: 20 },
    { id: idFor(14), name: 'D', unit: 'strips', total_stock: 19, low_stock_threshold: 20 },
    { id: idFor(15), name: 'E', unit: 'strips', total_stock: 1, low_stock_threshold: 20 },
  ];

  test('total_stock asc puts every `out` ahead of every `low`, as sortAlerts does', () => {
    const bySql = [...stockRows].sort((a, b) => a.total_stock - b.total_stock);
    const severities = buildLowStockAlerts(bySql).map((a) => a.severity);
    const firstLow = severities.indexOf(1);
    if (firstLow !== -1) {
      expect(severities.slice(firstLow).every((s) => s === 1)).toBe(true);
    }
    expect(severities.slice(0, firstLow === -1 ? severities.length : firstLow)
      .every((s) => s === 2)).toBe(true);
  });

  test('within the `low` tier the order is by remaining stock, not by id', () => {
    // A DOCUMENTED, deliberate divergence. Every LOW_STOCK alert has
    // created_at: null, so sortAlerts falls through to id (medicine UUID) —
    // an arbitrary tiebreak. Ordering by remaining stock is the more
    // defensible one, and matches the dashboard's own low-stock preview
    // (.order('total_stock').limit(5)). It is observable only past the list
    // limit, and only inside the `low` tier.
    const bySql = [...stockRows].sort((a, b) => a.total_stock - b.total_stock);
    const lows = buildLowStockAlerts(bySql).filter((a) => a.severity === 1);
    const stocks = lows.map((a) => a.metadata.total_stock);
    expect(stocks).toEqual([...stocks].sort((a, b) => a - b));
  });
});

describe('narrow-column contract for liveAlertKeys', () => {
  // liveAlertKeys selects two columns per row and discards everything but the
  // key. That is only safe while the key depends on nothing else — pinned here
  // so a future field added to alertKey() fails loudly instead of silently
  // producing keys that never match a dismissal.
  test('an expiry key needs only id and urgency', () => {
    const id = idFor(3);
    const [alert] = buildExpiryAlerts([{ id, urgency: 'critical' }]);
    expect(alert.id).toBe(`alert:NEAR_EXPIRY:${id}:critical`);
  });

  test('a low-stock key needs only id and total_stock', () => {
    const id = idFor(4);
    expect(buildLowStockAlerts([{ id, total_stock: 0 }])[0].id).toBe(`alert:LOW_STOCK:${id}:out`);
    expect(buildLowStockAlerts([{ id, total_stock: 5 }])[0].id).toBe(`alert:LOW_STOCK:${id}:low`);
  });

  test('the keys from narrow rows match the keys from full rows', () => {
    const rows = expiryRows();
    const full = buildExpiryAlerts(rows).map((a) => a.id);
    const narrow = buildExpiryAlerts(rows.map((r) => ({ id: r.id, urgency: r.urgency }))).map((a) => a.id);
    expect(narrow).toEqual(full);
  });
});
