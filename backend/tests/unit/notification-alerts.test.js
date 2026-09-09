/**
 * Unit tests — Module 36 derived alert rules. Pure: no database, no network, no
 * .env. These run with `npx jest tests/unit --runInBand` on a clean checkout.
 *
 * They pin the decisions that are invisible at a glance and expensive to get
 * wrong: that the severity tier is part of an alert's identity (which is what
 * makes escalation re-alert after a dismissal), that a missing number never
 * renders as a confident zero, and that the list order is total so it cannot
 * shuffle between polls.
 */

const {
  ALERT_PREFIX,
  EXPIRY_TIERS,
  STOCK_TIERS,
  alertKey,
  isAlertKey,
  parseAlertKey,
  buildExpiryAlerts,
  buildLowStockAlerts,
  sortAlerts,
} = require('../../src/modules/notifications/notifications.alerts');

const BATCH = 'b1000000-0000-4000-8000-000000000001';
const MED = 'm1000000-0000-4000-8000-000000000002';

/** One expiry_summary row, overridable per test. */
const expiryRow = (over = {}) => ({
  id: BATCH,
  medicine_name: 'Dolo 650',
  medicine_unit: 'strips',
  batch_no: 'B12',
  exp_date: '2026-12-01',
  stock_qty: 40,
  loose_qty: 0,
  urgency: 'critical',
  days_to_expiry: 12,
  potential_loss_value: '4124.80',
  ...over,
});

/** One medicines_with_stock row, overridable per test. */
const stockRow = (over = {}) => ({
  id: MED,
  name: 'Azithral 500',
  unit: 'strips',
  total_stock: 4,
  low_stock_threshold: 20,
  ...over,
});

// ── Keys ────────────────────────────────────────────────────────────────────

describe('alert keys', () => {
  test('carry type, entity and tier', () => {
    expect(alertKey('NEAR_EXPIRY', BATCH, 'critical'))
      .toBe(`${ALERT_PREFIX}NEAR_EXPIRY:${BATCH}:critical`);
  });

  test('isAlertKey separates alert keys from notification UUIDs', () => {
    expect(isAlertKey(alertKey('LOW_STOCK', MED, 'out'))).toBe(true);
    expect(isAlertKey('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isAlertKey('')).toBe(false);
    expect(isAlertKey(null)).toBe(false);
    expect(isAlertKey(undefined)).toBe(false);
    expect(isAlertKey(42)).toBe(false);
  });

  test('parseAlertKey round-trips a UUID entity id', () => {
    expect(parseAlertKey(alertKey('NEAR_EXPIRY', BATCH, 'watch')))
      .toEqual({ type: 'NEAR_EXPIRY', entityId: BATCH, tier: 'watch' });
  });

  test('parseAlertKey rejects malformed input rather than guessing', () => {
    expect(parseAlertKey('not-a-key')).toBeNull();
    expect(parseAlertKey('alert:NEAR_EXPIRY:only-two')).toBeNull();
    expect(parseAlertKey('alert:A:B:C:D')).toBeNull();
    expect(parseAlertKey('alert:::')).toBeNull();
    expect(parseAlertKey(null)).toBeNull();
  });
});

// ── Expiry tiers ────────────────────────────────────────────────────────────

describe('buildExpiryAlerts — tiers', () => {
  test.each([
    ['expired', 4],
    ['critical', 3],
    ['warning', 2],
    ['watch', 1],
  ])('%s maps to severity %i and keys on that tier', (urgency, rank) => {
    const [a] = buildExpiryAlerts([expiryRow({ urgency })]);
    expect(a.severity).toBe(rank);
    expect(a.id).toBe(alertKey('NEAR_EXPIRY', BATCH, urgency));
    expect(a.metadata.urgency).toBe(urgency);
  });

  test("urgency 'ok' raises nothing — a healthy batch is not an alert", () => {
    expect(buildExpiryAlerts([expiryRow({ urgency: 'ok' })])).toEqual([]);
  });

  test('an unrecognised urgency is dropped, not defaulted into a tier', () => {
    expect(buildExpiryAlerts([expiryRow({ urgency: 'nearly' })])).toEqual([]);
    expect(buildExpiryAlerts([expiryRow({ urgency: null })])).toEqual([]);
  });

  test('a row with no batch id is dropped — it could not be dismissed', () => {
    expect(buildExpiryAlerts([expiryRow({ id: null })])).toEqual([]);
  });

  test('every tier the view can emit has an entry here', () => {
    // Guards against schema-27's CASE growing a bucket this file does not know,
    // which would silently drop that whole class of alert.
    expect(EXPIRY_TIERS.map((t) => t.urgency).sort())
      .toEqual(['critical', 'expired', 'warning', 'watch']);
  });
});

describe('buildExpiryAlerts — escalation', () => {
  test('THE GUARANTEE: dismissing one tier cannot silence a nearer one', () => {
    // The service silences by key equality. If a batch's key did not change as
    // it decays, a dismissal at 90 days would mute the day it expires.
    const keys = ['watch', 'warning', 'critical', 'expired']
      .map((u) => buildExpiryAlerts([expiryRow({ urgency: u })])[0].id);

    expect(new Set(keys).size).toBe(4);

    const dismissed = new Set([keys[0]]);          // owner dismissed at 'watch'
    expect(keys.slice(1).some((k) => dismissed.has(k))).toBe(false);
  });

  test('onset dates the moment the tier began, not now', () => {
    const at = (urgency) => buildExpiryAlerts([expiryRow({ urgency })])[0].created_at;
    expect(at('watch')).toBe('2026-09-02');     // exp_date − 90d
    expect(at('warning')).toBe('2026-10-02');   // exp_date − 60d
    expect(at('critical')).toBe('2026-11-01');  // exp_date − 30d
    expect(at('expired')).toBe('2026-12-01');   // exp_date itself
  });

  test('an unparseable exp_date yields a null onset rather than a wrong date', () => {
    expect(buildExpiryAlerts([expiryRow({ exp_date: null })])[0].created_at).toBeNull();
    expect(buildExpiryAlerts([expiryRow({ exp_date: 'soon' })])[0].created_at).toBeNull();
  });
});

describe('buildExpiryAlerts — wording and guards', () => {
  test('counts down in days, singular at one', () => {
    expect(buildExpiryAlerts([expiryRow({ days_to_expiry: 12 })])[0].context)
      .toBe('Expires in 12 days');
    expect(buildExpiryAlerts([expiryRow({ days_to_expiry: 1 })])[0].context)
      .toBe('Expires in 1 day');
  });

  test('the day of expiry reads "today", in both directions', () => {
    expect(buildExpiryAlerts([expiryRow({ days_to_expiry: 0 })])[0].context)
      .toBe('Expires today');
    expect(buildExpiryAlerts([expiryRow({ urgency: 'expired', days_to_expiry: 0 })])[0].context)
      .toBe('Expired today');
  });

  test('an expired batch counts up, without a minus sign', () => {
    const a = buildExpiryAlerts([expiryRow({ urgency: 'expired', days_to_expiry: -5 })])[0];
    expect(a.context).toBe('Expired 5 days ago');
    expect(a.context).not.toMatch(/-/);
  });

  test('a MISSING day count says so rather than reading "0 days"', () => {
    // Number(null) is 0 and 0 is finite — the guard finiteOrNull exists for.
    // "Expires in 0 days" is a number a reader acts on; a blank is one they
    // cannot miss.
    for (const bad of [null, undefined, '', 'n/a']) {
      const a = buildExpiryAlerts([expiryRow({ days_to_expiry: bad })])[0];
      expect(a.context).toBe('Expiry date unreadable');
      expect(a.metadata.days_to_expiry).toBeNull();
    }
  });

  test('sealed and loose stock are both reported, and neither is invented', () => {
    expect(buildExpiryAlerts([expiryRow({ stock_qty: 40, loose_qty: 0 })])[0].message)
      .toBe('Batch B12 · 40 strips');
    expect(buildExpiryAlerts([expiryRow({ stock_qty: 40, loose_qty: 6 })])[0].message)
      .toBe('Batch B12 · 40 strips + 6 loose');
    expect(buildExpiryAlerts([expiryRow({ stock_qty: 0, loose_qty: 6 })])[0].message)
      .toBe('Batch B12 · 6 loose');
    expect(buildExpiryAlerts([expiryRow({ stock_qty: 0, loose_qty: 0 })])[0].message)
      .toBe('Batch B12 · no stock on hand');
  });

  test('missing name, unit and batch number degrade without throwing', () => {
    const a = buildExpiryAlerts([
      expiryRow({ medicine_name: null, medicine_unit: null, batch_no: null }),
    ])[0];
    expect(a.title).toContain('Unnamed medicine');
    expect(a.message).toBe('Batch — · 40 units');
  });

  test('money reaches metadata unformatted — no ₹ is composed on the server', () => {
    const a = buildExpiryAlerts([expiryRow()])[0];
    expect(a.metadata.potential_loss_value).toBe(4124.8);
    expect(`${a.title}${a.message}${a.context}`).not.toContain('₹');
  });

  test('an alert is shaped like a stored notification, plus its own markers', () => {
    const a = buildExpiryAlerts([expiryRow()])[0];
    expect(a).toMatchObject({ type: 'NEAR_EXPIRY', is_read: false, derived: true });
    expect(typeof a.title).toBe('string');
    expect(typeof a.message).toBe('string');
  });
});

// ── Low stock ───────────────────────────────────────────────────────────────

describe('buildLowStockAlerts', () => {
  test('below threshold is "low"; zero is "out"', () => {
    const low = buildLowStockAlerts([stockRow({ total_stock: 4 })])[0];
    expect(low.id).toBe(alertKey('LOW_STOCK', MED, 'low'));
    expect(low.severity).toBe(STOCK_TIERS.low);
    expect(low.context).toBe('4 of 20 left');
    expect(low.title).toBe('Azithral 500 is running low');

    const out = buildLowStockAlerts([stockRow({ total_stock: 0 })])[0];
    expect(out.id).toBe(alertKey('LOW_STOCK', MED, 'out'));
    expect(out.severity).toBe(STOCK_TIERS.out);
    expect(out.context).toBe('Out of stock');
    expect(out.title).toBe('Azithral 500 is out of stock');
  });

  test('running out escalates to a NEW key, so a dismissal does not carry over', () => {
    const low = buildLowStockAlerts([stockRow({ total_stock: 4 })])[0].id;
    const out = buildLowStockAlerts([stockRow({ total_stock: 0 })])[0].id;
    expect(low).not.toBe(out);
  });

  test('negative stock is treated as out, never as a negative count', () => {
    // The ledger's prevent_negative_stock trigger should make this impossible;
    // if it ever happens the bell must still read sensibly.
    const a = buildLowStockAlerts([stockRow({ total_stock: -3 })])[0];
    expect(a.context).toBe('Out of stock');
    expect(a.metadata.tier).toBe('out');
  });

  test('carries no timestamp — onset is not derivable, and now() would lie', () => {
    expect(buildLowStockAlerts([stockRow()])[0].created_at).toBeNull();
  });

  test('a missing threshold reports the count alone rather than "of 0"', () => {
    const a = buildLowStockAlerts([stockRow({ low_stock_threshold: null })])[0];
    expect(a.context).toBe('4 strips left');
    expect(a.message).toBe('4 strips on hand.');
    expect(a.metadata.low_stock_threshold).toBeNull();
  });

  test('the unit is rendered verbatim and never pluralised', () => {
    // medicines.unit is stored ALREADY plural — its CHECK allows only
    // 'strips','vials','bottles','tubes','packs','pcs'. Appending an 's' here
    // produced "stripss"; every other screen prints the column as it stands.
    expect(buildLowStockAlerts([stockRow({ total_stock: 1, unit: 'bottles' })])[0].message)
      .toBe('1 bottles on hand · reorder level 20.');
    expect(buildLowStockAlerts([stockRow({ total_stock: 4 })])[0].message)
      .toBe('4 strips on hand · reorder level 20.');
    expect(buildExpiryAlerts([expiryRow({ stock_qty: 1 })])[0].message)
      .toBe('Batch B12 · 1 strips');
  });

  test('a row with no medicine id is dropped', () => {
    expect(buildLowStockAlerts([stockRow({ id: null })])).toEqual([]);
  });
});

// ── Ordering and input hygiene ──────────────────────────────────────────────

describe('sortAlerts', () => {
  test('worst first, then the longest-standing instance of it', () => {
    const alerts = sortAlerts([
      ...buildExpiryAlerts([
        expiryRow({ id: 'b-watch', urgency: 'watch' }),
        expiryRow({ id: 'b-exp', urgency: 'expired' }),
        expiryRow({ id: 'b-crit-new', urgency: 'critical', exp_date: '2026-12-20' }),
        expiryRow({ id: 'b-crit-old', urgency: 'critical', exp_date: '2026-12-01' }),
      ]),
      ...buildLowStockAlerts([stockRow({ id: 'm-out', total_stock: 0 })]),
    ]);

    expect(alerts.map((a) => a.metadata.batch_id ?? a.metadata.medicine_id)).toEqual([
      'b-exp',        // severity 4
      'b-crit-old',   // severity 3, entered the window first
      'b-crit-new',   // severity 3
      'm-out',        // severity 2
      'b-watch',      // severity 1
    ]);
  });

  test('undated alerts sort after dated ones of the same severity', () => {
    // A null onset is an absence of data, not urgency. Treating it as the epoch
    // would float every low-stock alert to the top of its band.
    const sorted = sortAlerts([
      ...buildLowStockAlerts([stockRow({ id: 'm-low', total_stock: 4 })]),          // sev 1, null
      ...buildExpiryAlerts([expiryRow({ id: 'b-watch', urgency: 'watch' })]),       // sev 1, dated
    ]);
    expect(sorted[0].metadata.batch_id).toBe('b-watch');
    expect(sorted[1].metadata.medicine_id).toBe('m-low');
  });

  test('is total and stable — the list cannot reshuffle between polls', () => {
    const rows = [
      expiryRow({ id: 'b-b', urgency: 'critical' }),
      expiryRow({ id: 'b-a', urgency: 'critical' }),
    ];
    const once = sortAlerts(buildExpiryAlerts(rows)).map((a) => a.id);
    const twice = sortAlerts(buildExpiryAlerts([...rows].reverse())).map((a) => a.id);
    expect(once).toEqual(twice);
  });

  test('does not mutate its input', () => {
    const input = buildExpiryAlerts([
      expiryRow({ id: 'b1', urgency: 'watch' }),
      expiryRow({ id: 'b2', urgency: 'expired' }),
    ]);
    const before = input.map((a) => a.id);
    sortAlerts(input);
    expect(input.map((a) => a.id)).toEqual(before);
  });
});

describe('input hygiene', () => {
  test('both builders tolerate empty, null and non-array input', () => {
    for (const bad of [[], null, undefined, 'rows', {}]) {
      expect(buildExpiryAlerts(bad)).toEqual([]);
      expect(buildLowStockAlerts(bad)).toEqual([]);
    }
  });

  test('a null row inside a good array does not take the batch down', () => {
    expect(buildExpiryAlerts([null, expiryRow(), undefined])).toHaveLength(1);
    expect(buildLowStockAlerts([null, stockRow(), undefined])).toHaveLength(1);
  });
});
