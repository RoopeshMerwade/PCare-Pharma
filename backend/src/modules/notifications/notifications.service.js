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
  buildExpiryAlerts,
  buildLowStockAlerts,
  sortAlerts,
} = require('./notifications.alerts');

/** Mirrors the stored-list limit, so neither half can flood the other out. */
const ALERT_LIST_LIMIT = 50;

// ── DERIVED ALERTS ──────────────────────────────────────────────────────────

/**
 * Live derived alerts for a user, minus the ones they have silenced.
 *
 * OWNER-ONLY. Staff cannot act on expiry or reorder decisions: /expiry is
 * authorize('owner'), and NEAR_EXPIRY is ownerOnly in the frontend registry, so
 * a staff member clicking one would be bounced to /notifications — a dead end
 * that reads as a broken notification rather than a permission boundary. This
 * is an A9 payload gate, not a rendering one: the alerts never leave the server.
 *
 * ALSO GARBAGE-COLLECTS stale dismissals, and that is load-bearing rather than
 * housekeeping. Expiry is monotone, so an expiry dismissal never needs
 * revoking. Low stock is NOT: a medicine goes low, is dismissed, is restocked,
 * and months later goes low again under an identical key — leaving the alert
 * silently dead forever, which is a worse failure than the one this module
 * exists to fix because it is invisible. So a dismissal lives exactly as long
 * as the thing it dismissed: any whose key is no longer in the live set is
 * dismissing nothing and is deleted.
 *
 * The write is safe on a read path. It issues no statement at all unless the
 * diff is non-empty, deleting an already-deleted row is a no-op, and it only
 * ever names keys absent from the live set — so it cannot race a concurrent
 * dismissal of a live alert under the client's 60-second poll.
 */
async function computeLiveAlerts(user) {
  if (!user || user.role !== 'owner') return [];
  if (!(await hasNotificationDismissals())) return [];

  try {
    const [expiryRes, lowStockRes] = await Promise.all([
      supabase
        .from('expiry_summary')
        .select(
          'id, medicine_name, medicine_unit, batch_no, exp_date, stock_qty, ' +
          'loose_qty, urgency, days_to_expiry, potential_loss_value'
        )
        .neq('urgency', 'ok'),
      supabase
        .from('medicines_with_stock')
        .select('id, name, unit, total_stock, low_stock_threshold')
        .eq('is_active', true)
        .eq('is_low_stock', true),
    ]);

    if (expiryRes.error) throw expiryRes.error;
    if (lowStockRes.error) throw lowStockRes.error;

    const alerts = sortAlerts([
      ...buildExpiryAlerts(expiryRes.data),
      ...buildLowStockAlerts(lowStockRes.data),
    ]);

    const { data: dismissals, error: dErr } = await supabase
      .from('notification_dismissals')
      .select('alert_key')
      .eq('user_id', user.id);
    if (dErr) throw dErr;

    const liveKeys = new Set(alerts.map((a) => a.id));
    const dismissed = new Set();
    const stale = [];
    for (const row of dismissals || []) {
      if (liveKeys.has(row.alert_key)) dismissed.add(row.alert_key);
      else stale.push(row.alert_key);
    }

    if (stale.length) {
      const { error: gcErr } = await supabase
        .from('notification_dismissals')
        .delete()
        .eq('user_id', user.id)
        .in('alert_key', stale);
      // A failed GC must not fail the read. The consequence is one cycle of an
      // alert staying silent, self-correcting on the next request.
      if (gcErr) logger.warn({ err: gcErr }, 'Stale dismissal cleanup failed');
    }

    return alerts.filter((a) => !dismissed.has(a.id));
  } catch (err) {
    // Same rule the dashboard applies to its own alert block: a degraded bell
    // is better than a 500 that hides the events which are working.
    logger.warn({ err }, 'Derived alert computation failed; serving stored notifications only');
    return [];
  }
}

/** Every live alert key, for read-all. Separate name so the intent is legible. */
async function liveAlertKeys(user) {
  return (await computeLiveAlerts(user)).map((a) => a.id);
}

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

  const [{ data, error }, alerts] = await Promise.all([q, computeLiveAlerts(user)]);
  if (error) throw new AppError('Failed to fetch notifications.', 500, 'DB_ERROR');

  return [...alerts.slice(0, ALERT_LIST_LIMIT), ...(data || [])];
}

/**
 * The badge. Counts the UNCAPPED alert total, so it stays honest even when the
 * list above is capped — and read-all dismisses every live alert server-side
 * rather than only the listed ones, so a cap can never strand a badge that
 * cannot be cleared.
 */
async function getUnreadCount(user) {
  const [{ count }, alerts] = await Promise.all([
    supabase.from('notifications')
      .select('*', { count: 'exact', head: true })
      .or(`user_id.eq.${user.id},user_id.is.null`)
      .eq('is_read', false),
    computeLiveAlerts(user),
  ]);
  return (count || 0) + alerts.length;
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
};
