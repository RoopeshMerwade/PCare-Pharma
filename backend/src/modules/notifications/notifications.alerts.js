// ── Module 16: Notifications — derived alert rules
//
// Pure functions. No Supabase, no config, no clock — the same discipline
// supplier-invoices.normalize.js and stock-requisitions.export.js follow, and
// what makes tests/unit/notification-alerts.test.js runnable with no
// environment at all. This file owns the RULES; the service owns the queries.
//
// WHY DERIVED AT ALL. An attendance check-in is a fact about a moment and is
// correctly stored in `notifications`. "This batch is 12 days from expiry" is
// not — it is a statement about the world right now, and a stored copy of it
// survives the batch being written off, leaving the bell asserting something
// that stopped being true. So expiry and low stock are computed from
// expiry_summary and medicines_with_stock on every request and nothing is
// inserted. A sold or written-off batch drops out of those views and its alert
// vanishes with no cleanup, because there was never anything to go stale.
//
// WHY THE TIER IS PART OF THE KEY. Dismissing writes the alert's key into
// notification_dismissals. Because the key carries the severity tier,
// silencing a batch at 90 days silences only `watch`; when it crosses 60 the
// key becomes `…:warning`, which has no dismissal, and it speaks again. The
// escalation rule is implemented by string identity, not by comparison logic
// that could drift from the keys it compares.

const { finiteOrNull } = require('../../utils/money');

/**
 * Prefix that distinguishes a derived alert id from a notifications.id UUID.
 *
 * Deliberately a PREFIX and not a regex over the whole shape: PATCH /:id/read
 * serves both kinds through one path, and a prefix test can never be satisfied
 * by a UUID, however the key format is extended later.
 */
const ALERT_PREFIX = 'alert:';

/**
 * Expiry tiers, worst first.
 *
 * `days` is the window edge expiry_summary buckets on — its CASE reads
 * `exp_date <= current_date + interval 'N days'` (db/schema-27-loose-units.sql
 * :433-439). Kept here as data rather than re-derived, because the onset date
 * of a tier is `exp_date - N days` and the bucket boundary and the onset are
 * necessarily the same number.
 */
const EXPIRY_TIERS = [
  { urgency: 'expired',  rank: 4, days: 0  },
  { urgency: 'critical', rank: 3, days: 30 },
  { urgency: 'warning',  rank: 2, days: 60 },
  { urgency: 'watch',    rank: 1, days: 90 },
];

const EXPIRY_TIER_BY_URGENCY = Object.fromEntries(EXPIRY_TIERS.map((t) => [t.urgency, t]));

/**
 * Low-stock tiers. Mirrors the split OwnerDashboard.jsx already draws in its
 * "Running low" card, which badges zero stock as critical and anything else
 * below the threshold as low. One rule, not two that can disagree.
 */
const STOCK_TIERS = { out: 2, low: 1 };

// ── Keys ────────────────────────────────────────────────────────────────────

/** `alertKey('NEAR_EXPIRY', batchId, 'critical')` → 'alert:NEAR_EXPIRY:<id>:critical' */
function alertKey(type, entityId, tier) {
  return `${ALERT_PREFIX}${type}:${entityId}:${tier}`;
}

/** Whether an identifier addresses a derived alert rather than a stored row. */
function isAlertKey(id) {
  return typeof id === 'string' && id.startsWith(ALERT_PREFIX);
}

/**
 * Inverse of alertKey. Returns null for anything that is not a well-formed key.
 *
 * Splits on ':' with a fixed field count rather than a greedy match, so a UUID
 * entity id (which contains no colon) round-trips exactly.
 */
function parseAlertKey(key) {
  if (!isAlertKey(key)) return null;
  const parts = key.slice(ALERT_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const [type, entityId, tier] = parts;
  if (!type || !entityId || !tier) return null;
  return { type, entityId, tier };
}

// ── Small helpers ───────────────────────────────────────────────────────────

/**
 * `YYYY-MM-DD` shifted by n calendar days. Used only to date a tier's onset.
 *
 * UTC arithmetic on a bare date string: exp_date is a Postgres `date` with no
 * time or zone, so there is no instant to place in IST and nothing here can
 * drift by an hour the way a timestamptz would.
 */
function shiftDate(dateStr, deltaDays) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(t)) return null;
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/** '1 day' / '3 days'. For English words only — see qtyWithUnit for units. */
function plural(n, word) {
  return `${n} ${word}${Math.abs(n) === 1 ? '' : 's'}`;
}

/**
 * '4 strips'. Deliberately does NOT pluralise: medicines.unit is stored already
 * plural — its CHECK allows only 'strips','vials','bottles','tubes','packs','pcs'
 * (modules/medicines/medicines.sql:13, restated in schema-25) — so adding an 's'
 * yields "stripss". Every other screen renders the column verbatim; so does this.
 */
function qtyWithUnit(n, unit) {
  return `${n} ${unit}`;
}

/** Integer or null. Guards with finiteOrNull because Number(null) is 0, and 0
 *  is finite — the trap that would render a missing count as "0 days". */
function intOrNull(value) {
  const n = finiteOrNull(value);
  return n === null ? null : Math.trunc(n);
}

// ── Builders ────────────────────────────────────────────────────────────────

/**
 * expiry_summary rows → alerts. Rows whose urgency is 'ok' (or unrecognised)
 * are ignored: the caller filters them out in SQL, and this is the second gate.
 */
function buildExpiryAlerts(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.reduce((acc, row) => {
    const tier = EXPIRY_TIER_BY_URGENCY[row?.urgency];
    if (!tier || !row.id) return acc;

    const days = intOrNull(row.days_to_expiry);
    const sealed = intOrNull(row.stock_qty) ?? 0;
    const loose = intOrNull(row.loose_qty) ?? 0;
    const unit = row.medicine_unit || 'units';
    const name = row.medicine_name || 'Unnamed medicine';

    // days is null only if the view returned something unreadable. Say so
    // rather than inventing a number — the same rule Module 23 applies to an
    // unreadable field: it must reach a human, not be guessed at.
    let context;
    if (days === null) context = 'Expiry date unreadable';
    else if (tier.urgency === 'expired') {
      context = days === 0 ? 'Expired today' : `Expired ${plural(Math.abs(days), 'day')} ago`;
    } else {
      context = days === 0 ? 'Expires today' : `Expires in ${plural(days, 'day')}`;
    }

    const held = [
      sealed > 0 ? qtyWithUnit(sealed, unit) : null,
      loose > 0 ? `${loose} loose` : null,
    ].filter(Boolean).join(' + ') || 'no stock on hand';

    acc.push({
      id: alertKey('NEAR_EXPIRY', row.id, tier.urgency),
      type: 'NEAR_EXPIRY',
      title: `${name} — ${context.toLowerCase()}`,
      message: `Batch ${row.batch_no || '—'} · ${held}`,
      context,
      is_read: false,
      // The moment this tier became true, which is what a reader wants dated.
      // 'expired' starts on exp_date itself; every other tier starts N days
      // before it, N being the window edge the view buckets on.
      created_at: shiftDate(row.exp_date, -tier.days),
      derived: true,
      severity: tier.rank,
      metadata: {
        batch_id: row.id,
        batch_no: row.batch_no ?? null,
        medicine_name: row.medicine_name ?? null,
        urgency: tier.urgency,
        exp_date: row.exp_date ?? null,
        days_to_expiry: days,
        stock_qty: sealed,
        loose_qty: loose,
        // Unformatted on purpose: currency rendering belongs to domain/Money.jsx
        // on the client, and stock-requisitions.export.js is the standing
        // reminder of what a second copy of it costs.
        potential_loss_value: finiteOrNull(row.potential_loss_value),
      },
    });
    return acc;
  }, []);
}

/**
 * medicines_with_stock rows → alerts. The caller filters on is_low_stock; this
 * only decides which of the two tiers a row is in.
 */
function buildLowStockAlerts(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.reduce((acc, row) => {
    if (!row?.id) return acc;

    const stock = intOrNull(row.total_stock) ?? 0;
    const threshold = intOrNull(row.low_stock_threshold);
    const unit = row.unit || 'units';
    const name = row.name || 'Unnamed medicine';
    const isOut = stock <= 0;
    const tier = isOut ? 'out' : 'low';

    const context = isOut
      ? 'Out of stock'
      : threshold === null
        ? `${qtyWithUnit(stock, unit)} left`
        : `${stock} of ${threshold} left`;

    acc.push({
      id: alertKey('LOW_STOCK', row.id, tier),
      type: 'LOW_STOCK',
      title: isOut ? `${name} is out of stock` : `${name} is running low`,
      message: threshold === null
        ? `${qtyWithUnit(stock, unit)} on hand.`
        : `${qtyWithUnit(stock, unit)} on hand · reorder level ${threshold}.`,
      context,
      is_read: false,
      // No derivable onset. Knowing WHEN stock crossed the threshold means
      // scanning inventory_ledger, which is not worth a query on an endpoint
      // polled every 60 seconds — and `context` already says the thing that
      // matters. Null rather than now(), because now() would make the bell
      // print "Just now" for a medicine that has been empty for a week.
      created_at: null,
      derived: true,
      severity: STOCK_TIERS[tier],
      metadata: {
        medicine_id: row.id,
        medicine_name: row.name ?? null,
        tier,
        total_stock: stock,
        low_stock_threshold: threshold,
        unit: row.unit ?? null,
      },
    });
    return acc;
  }, []);
}

/**
 * Severity descending, then onset ascending — the oldest instance of the worst
 * problem first, which is the order someone triaging a shelf works in.
 *
 * A null onset (every LOW_STOCK alert) sorts after dated ones within its band
 * rather than being treated as the epoch, which would float them to the top of
 * their tier for a reason that is an absence of data, not urgency. Ties break
 * on id so the order is total and the list cannot shuffle between polls.
 */
function sortAlerts(alerts) {
  return [...alerts].sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity;
    if (a.created_at !== b.created_at) {
      if (!a.created_at) return 1;
      if (!b.created_at) return -1;
      return a.created_at < b.created_at ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

module.exports = {
  ALERT_PREFIX,
  EXPIRY_TIERS,
  STOCK_TIERS,
  alertKey,
  isAlertKey,
  parseAlertKey,
  buildExpiryAlerts,
  buildLowStockAlerts,
  sortAlerts,
};
