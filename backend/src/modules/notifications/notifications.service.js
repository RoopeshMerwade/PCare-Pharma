// ── Module 16: Notifications Service
//
// Two kinds of notification, deliberately kept apart:
//
//   EVENTS  rows in `notifications`. A staff check-in or a requisition
//           approval is a fact about a moment in time; storing it with an
//           is_read flag is correct.
//
//   ALERTS  computed per request from expiry_summary and medicines_with_stock,
//           never stored. "This batch is 12 days from expiry" is a statement
//           about the world right now, and a stored copy of it survives the
//           batch being written off — the bell would go on asserting something
//           that stopped being true, with no sweep to retire it. Derived, a
//           sold or written-off batch simply drops out of the view and its
//           alert is gone.
//
// The rules for alerts live in notifications.alerts.js, which imports no
// Supabase client; this file is the only layer that queries.

const { supabase } = require('../../config/supabase');
const { hasNotificationDismissals } = require('../../config/capabilities');
const { AppError } = require('../../utils/AppError');
const logger = require('../../utils/logger');
const {
  isAlertKey,
  parseAlertKey,
  buildExpiryAlerts,
  buildLowStockAlerts,
  sortAlerts,
} = require('./notifications.alerts');

/** Mirrors the stored-list limit, so neither half can flood the other out. */
const ALERT_LIST_LIMIT = 50;

// ── DERIVED ALERTS ──────────────────────────────────────────────────────────

/* Derived alerts are read by three callers that need three different things,
   and serving all of them from one whole-table scan is what made the bell
   expensive: /notifications/count is polled every 60 seconds per owner tab.
   Split by what each actually needs —

     countLiveAlerts  the badge      two head-counts + a bounded probe, NO rows
     listLiveAlerts   the popover    limit + dismissals rows per source
     liveAlertKeys    read-all       still every row, but two columns, and only
                                     ever on an explicit click

   liveAlertKeys must stay uncapped. markAllRead upserts one dismissal per live
   key, so a capped read-all silently leaves a badge that cannot be cleared —
   invisible, and worse than a slow click. */

const EXPIRY_LIST_COLS =
  'id, medicine_name, medicine_unit, batch_no, exp_date, stock_qty, ' +
  'loose_qty, urgency, days_to_expiry, potential_loss_value';
const EXPIRY_KEY_COLS = 'id, urgency';
const STOCK_LIST_COLS = 'id, name, unit, total_stock, low_stock_threshold';
const STOCK_KEY_COLS = 'id, total_stock';

/** A dismissal count is not human-bounded — markAllRead writes one per live
 *  alert — so an owner who cleared a 3,000-alert bell would otherwise put
 *  3,000 UUIDs in a query string on every poll (a 414, not a 500). */
const IN_CHUNK = 150;

const chunk = (xs, n) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/* Factories, not shared builders: postgrest-js filter methods mutate the
   builder's URL in place and return `this`, so one instance reused across the
   parallel queries below would have each inherit the previous one's filters. */
function expiryQuery(columns, options) {
  return supabase.from('expiry_summary').select(columns, options).neq('urgency', 'ok');
}
function lowStockQuery(columns, options) {
  return supabase.from('medicines_with_stock').select(columns, options)
    .eq('is_active', true).eq('is_low_stock', true);
}

/** Owner-only, and gated on the migration. Staff cannot act on expiry or
 *  reorder decisions (/expiry is authorize('owner')), so an alert they could
 *  only be bounced from is an A9 payload gate, not a rendering one. */
async function alertsAvailable(user) {
  if (!user || user.role !== 'owner') return false;
  return hasNotificationDismissals();
}

async function fetchDismissalKeys(userId) {
  const { data, error } = await supabase
    .from('notification_dismissals').select('alert_key').eq('user_id', userId);
  if (error) throw error;
  return (data || []).map((r) => r.alert_key).filter(isAlertKey);
}

/**
 * GC, unchanged in effect and still load-bearing rather than housekeeping.
 *
 * Expiry is monotone, so an expiry dismissal never needs revoking. Low stock is
 * NOT: a medicine goes low, is dismissed, is restocked, and months later goes
 * low again under an identical key — leaving the alert silently dead forever,
 * a worse failure than the one this module exists to fix because it is
 * invisible. So a dismissal lives exactly as long as the thing it dismissed.
 *
 * Safe on a read path: no statement unless the diff is non-empty, deleting an
 * already-deleted row is a no-op, and it only ever names keys that are NOT
 * live — so it cannot race a concurrent dismissal under the 60-second poll.
 */
async function gcStaleDismissals(userId, staleKeys) {
  if (!staleKeys.length) return;
  for (const part of chunk(staleKeys, IN_CHUNK)) {
    const { error } = await supabase
      .from('notification_dismissals').delete().eq('user_id', userId).in('alert_key', part);
    // A failed GC must not fail the read. The consequence is one cycle of an
    // alert staying silent, self-correcting on the next request.
    if (error) logger.warn({ err: error }, 'Stale dismissal cleanup failed');
  }
}

/**
 * Which of this user's dismissals still silence something live.
 *
 * Re-queries ONLY the entities the dismissal keys name, so the cost is the
 * dismissal count rather than the catalogue. Re-checks the TIER, not merely
 * existence: the key carries it, so a medicine dismissed at `out` that took
 * delivery of one unit is now `low`, has a different live key, and its old
 * dismissal silences nothing and is stale.
 *
 * Returns the same live/stale split computeLiveAlerts used to derive by
 * intersecting against every live key.
 */
async function resolveDismissals(userId) {
  const keys = await fetchDismissalKeys(userId);
  if (!keys.length) return { liveKeys: new Set(), staleKeys: [] };

  const parsed = keys.map((key) => ({ key, ...(parseAlertKey(key) || {}) }));
  const idsFor = (type) => [...new Set(parsed.filter((p) => p.type === type && p.entityId).map((p) => p.entityId))];

  const expiryIds = idsFor('NEAR_EXPIRY');
  const stockIds = idsFor('LOW_STOCK');

  const gather = async (ids, build) => {
    const out = new Map();
    if (!ids.length) return out;
    const pages = await Promise.all(chunk(ids, IN_CHUNK).map((part) => build(part)));
    for (const res of pages) {
      if (res.error) throw res.error;
      for (const row of res.data || []) out.set(row.id, row);
    }
    return out;
  };

  const [expiryRows, stockRows] = await Promise.all([
    gather(expiryIds, (part) => expiryQuery(EXPIRY_KEY_COLS).in('id', part)),
    gather(stockIds, (part) => lowStockQuery(STOCK_KEY_COLS).in('id', part)),
  ]);

  const liveKeys = new Set();
  const staleKeys = [];
  for (const p of parsed) {
    let currentTier = null;
    if (p.type === 'NEAR_EXPIRY') {
      currentTier = expiryRows.get(p.entityId)?.urgency ?? null;
    } else if (p.type === 'LOW_STOCK') {
      const row = stockRows.get(p.entityId);
      if (row) currentTier = (Number(row.total_stock) || 0) <= 0 ? 'out' : 'low';
    }
    if (currentTier && currentTier === p.tier) liveKeys.add(p.key);
    else staleKeys.push(p.key);
  }

  return { liveKeys, staleKeys };
}

/**
 * The badge. Two metadata-only counts and a probe bounded by the dismissal
 * count — zero alert rows cross the wire.
 *
 * Exact, not an estimate: expiry alerts are one per non-`ok` batch and
 * low-stock alerts one per low-stock medicine, so the head-counts ARE the
 * alert totals, and the dismissals that still silence one are subtracted.
 */
async function countLiveAlerts(user) {
  if (!(await alertsAvailable(user))) return 0;

  try {
    const HEAD = { count: 'exact', head: true };
    const [expiryRes, stockRes, dismissals] = await Promise.all([
      expiryQuery('*', HEAD),
      lowStockQuery('*', HEAD),
      resolveDismissals(user.id),
    ]);
    if (expiryRes.error) throw expiryRes.error;
    if (stockRes.error) throw stockRes.error;

    await gcStaleDismissals(user.id, dismissals.staleKeys);

    const total = (expiryRes.count || 0) + (stockRes.count || 0);
    return Math.max(0, total - dismissals.liveKeys.size);
  } catch (err) {
    logger.warn({ err }, 'Derived alert count failed; serving stored count only');
    return 0;
  }
}

/**
 * The popover list.
 *
 * Fetches `limit + dismissals` from each source: a dismissed alert consumes a
 * slot in its source's ordering but not in the result. Taking the top-N of each
 * source and merging is correct because an alert's rank in the merged list is
 * never better than its rank within its own source.
 *
 * `exp_date asc` reproduces sortAlerts EXACTLY for expiry alerts — within a
 * tier the onset is exp_date minus a constant, and across tiers the view's own
 * CASE makes severity a decreasing function of exp_date. `total_stock asc` puts
 * `out` ahead of `low` as sortAlerts does; within `low` it orders by remaining
 * stock rather than by medicine UUID, which shows only past `limit` low-stock
 * alerts and is the better of two arbitrary tiebreaks.
 */
async function listLiveAlerts(user, { limit = ALERT_LIST_LIMIT } = {}) {
  if (!(await alertsAvailable(user))) return [];

  try {
    const { liveKeys, staleKeys } = await resolveDismissals(user.id);
    const headroom = Math.min(liveKeys.size, 500) + limit;

    const [expiryRes, stockRes] = await Promise.all([
      expiryQuery(EXPIRY_LIST_COLS)
        .order('exp_date', { ascending: true }).order('id', { ascending: true }).limit(headroom),
      lowStockQuery(STOCK_LIST_COLS)
        .order('total_stock', { ascending: true }).order('id', { ascending: true }).limit(headroom),
    ]);
    if (expiryRes.error) throw expiryRes.error;
    if (stockRes.error) throw stockRes.error;

    await gcStaleDismissals(user.id, staleKeys);

    const alerts = sortAlerts([
      ...buildExpiryAlerts(expiryRes.data),
      ...buildLowStockAlerts(stockRes.data),
    ]);
    return alerts.filter((a) => !liveKeys.has(a.id)).slice(0, limit);
  } catch (err) {
    // Same rule the dashboard applies to its own alert block: a degraded bell
    // is better than a 500 that hides the events which are working.
    logger.warn({ err }, 'Derived alert computation failed; serving stored notifications only');
    return [];
  }
}

/**
 * Every live alert key, for read-all.
 *
 * Still unbounded in rows, and that is correct: the badge has to be able to
 * reach zero, and a capped read-all leaves one that cannot be cleared. It runs
 * on an explicit click rather than the 60-second poll, and reads two columns
 * per row rather than ten — the alert objects are discarded, only the keys are
 * wanted.
 */
async function liveAlertKeys(user) {
  if (!(await alertsAvailable(user))) return [];

  try {
    const [expiryRes, stockRes] = await Promise.all([
      expiryQuery(EXPIRY_KEY_COLS),
      lowStockQuery(STOCK_KEY_COLS),
    ]);
    if (expiryRes.error) throw expiryRes.error;
    if (stockRes.error) throw stockRes.error;

    return [
      ...buildExpiryAlerts(expiryRes.data),
      ...buildLowStockAlerts(stockRes.data),
    ].map((a) => a.id);
  } catch (err) {
    logger.warn({ err }, 'Live alert key enumeration failed; read-all covers stored rows only');
    return [];
  }
}

/** Back-compat alias — the old name, same contract as the list path. */
const computeLiveAlerts = (user) => listLiveAlerts(user);

// ── READ ────────────────────────────────────────────────────────────────────

/**
 * Takes the whole `user`, not just an id — the derived half is role-gated.
 *
 * Alerts lead the list. They are conditions rather than history, and burying a
 * batch that expires this week under last week's check-ins is the wrong order.
 * `unreadOnly` filters the stored half only: every alert returned here is, by
 * construction, one that has not been dismissed.
 */
async function getNotifications(user, { unreadOnly = false, limit = 50 } = {}) {
  let q = supabase.from('notifications').select('*')
    .or(`user_id.eq.${user.id},user_id.is.null`)  // own + broadcasts
    .order('created_at', { ascending: false }).limit(limit);
  if (unreadOnly) q = q.eq('is_read', false);

  const [{ data, error }, alerts] = await Promise.all([
    q,
    listLiveAlerts(user, { limit: ALERT_LIST_LIMIT }),
  ]);
  if (error) throw new AppError('Failed to fetch notifications.', 500, 'DB_ERROR');

  return [...alerts, ...(data || [])];
}

/**
 * The badge. Still counts the UNCAPPED alert total, so it stays honest even
 * when the list above is capped — and read-all still dismisses every live
 * alert server-side rather than only the listed ones, so a cap can never
 * strand a badge that cannot be cleared.
 *
 * It just no longer BUILDS the alerts to count them. countLiveAlerts reaches
 * the same number from two head-counts, which matters because this is the
 * endpoint every owner tab polls once a minute.
 */
async function getUnreadCount(user) {
  const [{ count }, alertCount] = await Promise.all([
    supabase.from('notifications')
      .select('*', { count: 'exact', head: true })
      .or(`user_id.eq.${user.id},user_id.is.null`)
      .eq('is_read', false),
    countLiveAlerts(user),
  ]);
  return (count || 0) + alertCount;
}

// ── MARK READ ───────────────────────────────────────────────────────────────

/**
 * One entry point for both kinds, discriminated by the `alert:` prefix, so the
 * client has a single code path and the branch lives on the authoritative side.
 *
 * A derived alert is not "read" — it is silenced, permanently, for that tier.
 * Upsert rather than insert so a double-click is not a 23505.
 */
async function markRead(id, user) {
  if (isAlertKey(id)) {
    const { error } = await supabase.from('notification_dismissals')
      .upsert({ user_id: user.id, alert_key: id }, { onConflict: 'user_id,alert_key' });
    if (error) throw new AppError('Failed to dismiss alert.', 500, 'DB_ERROR');
    return;
  }

  const { error } = await supabase.from('notifications')
    .update({ is_read: true }).eq('id', id)
    .or(`user_id.eq.${user.id},user_id.is.null`);
  if (error) throw new AppError('Failed to mark notification.', 500, 'DB_ERROR');
}

/**
 * Both halves, or the badge does not reach zero — which is a visible bug rather
 * than a subtle one, and the first thing anyone tests.
 */
async function markAllRead(user) {
  const keys = await liveAlertKeys(user);

  const { error } = await supabase.from('notifications').update({ is_read: true })
    .or(`user_id.eq.${user.id},user_id.is.null`).eq('is_read', false);
  if (error) throw new AppError('Failed to mark notifications.', 500, 'DB_ERROR');

  if (keys.length) {
    const { error: dErr } = await supabase.from('notification_dismissals')
      .upsert(
        keys.map((alert_key) => ({ user_id: user.id, alert_key })),
        { onConflict: 'user_id,alert_key' }
      );
    if (dErr) throw new AppError('Failed to dismiss alerts.', 500, 'DB_ERROR');
  }
}

// ── CREATE (internal use — called by other services on a real event) ─────────
//
// Fire-and-forget by design: a notification that cannot be written must not
// fail the business operation that earned it. The cost is that a `type` missing
// from notifications_type_check disappears with only a WARN line — see the
// comment above that constraint in schema-30-stock-requisitions.sql.
async function createNotification({ user_id = null, type, title, message, metadata = {} }) {
  try {
    const { data, error } = await supabase.from('notifications')
      .insert({ user_id, type, title, message, metadata }).select().single();
    if (error) logger.warn({ type, error: error.message }, 'Notification insert failed');
    return data;
  } catch(e) {
    logger.warn({ type }, 'Notification creation failed silently');
  }
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  createNotification,
  computeLiveAlerts,
  countLiveAlerts,
  listLiveAlerts,
  liveAlertKeys,
  resolveDismissals,
};
