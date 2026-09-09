// ── Optional-migration detection.
//
// Module 27 (loose units) adds columns to medicines_with_stock and
// batches_with_stock. Selecting them on a database where
// schema-27-loose-units.sql has not been run yet returns PostgREST 42703 and
// the whole query fails — which took the medicine search, and therefore the
// ability to start a bill at all, down on a database that was otherwise fine.
//
// That is the wrong failure. The rule this codebase already applies to
// GEMINI_API_KEY holds here too: the POS has to work in a pharmacy that has
// not set the optional thing up. A pending migration may cost the loose-unit
// FEATURE; it must never cost the till.
//
// So the two hot-path reads ask once whether the columns are there and pick
// their column list accordingly. One probe per process, cached — the schema
// cannot change under a running API without a deploy.

const { supabase } = require('./supabase');
const logger = require('../utils/logger');

let looseUnitsPromise = null;
let dismissalsPromise = null;
let invoiceTaxPromise = null;

/**
 * Whether schema-27-loose-units.sql has been applied.
 *
 * Probes `loose_sale_supported`, which only that migration creates. The result
 * is memoised on the PROMISE, not the value, so a burst of concurrent searches
 * at startup issues one probe between them rather than one each.
 *
 * Fails closed: anything unexpected is treated as "not available", because
 * running without the loose-unit columns is a working POS and guessing wrong
 * the other way is a broken one.
 */
function hasLooseUnits() {
  if (looseUnitsPromise) return looseUnitsPromise;

  looseUnitsPromise = (async () => {
    const { error } = await supabase
      .from('medicines_with_stock')
      .select('loose_sale_supported')
      .limit(1);

    if (!error) return true;

    // 42703 = undefined_column, PGRST204/205 = PostgREST's schema cache has no
    // such column/table. All three mean the same thing here: not migrated yet.
    if (error.code === '42703' || error.code?.startsWith('PGRST')) {
      logger.warn(
        { code: error.code },
        'Loose-unit columns not found — running without single-unit sales. ' +
        'Apply backend/src/db/schema-27-loose-units.sql and restart to enable them.'
      );
      return false;
    }

    logger.warn({ err: error }, 'Could not determine loose-unit support; assuming unavailable');
    return false;
  })();

  return looseUnitsPromise;
}

/**
 * Whether schema-36-notification-dismissals.sql has been applied.
 *
 * Same reasoning as above, one layer out. Derived expiry and low-stock alerts
 * cannot be silenced without somewhere to record the silence, so on an
 * unmigrated database they are not offered at all and the bell behaves exactly
 * as it did before Module 36 — stored events only. The alternative is worse
 * than a missing feature: querying a table PostgREST does not know fails the
 * whole request, which would take /notifications down and break the bell for
 * the attendance and requisition events that do work.
 *
 * Fails closed, memoised on the promise, one probe per process — so the API
 * must be restarted after applying the migration, exactly as Module 27 requires.
 */
function hasNotificationDismissals() {
  if (dismissalsPromise) return dismissalsPromise;

  dismissalsPromise = (async () => {
    const { error } = await supabase
      .from('notification_dismissals')
      .select('alert_key')
      .limit(1);

    if (!error) return true;

    // 42P01 = undefined_table, PGRST2xx = PostgREST's schema cache has no such
    // table. Both mean the same thing here: not migrated yet.
    if (error.code === '42P01' || error.code?.startsWith('PGRST')) {
      logger.warn(
        { code: error.code },
        'notification_dismissals not found — running without derived expiry/low-stock alerts. ' +
        'Apply backend/src/modules/notifications/schema-36-notification-dismissals.sql and restart to enable them.'
      );
      return false;
    }

    logger.warn({ err: error }, 'Could not determine dismissal support; assuming unavailable');
    return false;
  })();

  return dismissalsPromise;
}

/**
 * Whether schema-37-invoice-tax-detail.sql has been applied.
 *
 * Probes `invoice_type`, which only that migration creates. Same reasoning as
 * the two above, but the failure it prevents is on a WRITE rather than a read,
 * and that makes it sharper.
 *
 * `ingestInvoice` inserts the whole normalised header in one statement. Send a
 * column PostgREST's schema cache does not know and it rejects the ENTIRE
 * insert with PGRST204 — so on an unmigrated database every upload would fail,
 * after paying for the storage write and the Gemini call. Not a degraded
 * feature: no goods inward at all, on the only working goods-inward path.
 *
 * Where the migration is absent, the new fields are dropped before the write
 * and Module 23 behaves exactly as it did before this migration existed. The
 * document is still read, still reviewed, still imported; only the tax detail
 * is not retained. That is a real loss and it is the right one to take —
 * losing the tax block costs a GST reconciliation later, losing the insert
 * costs the delivery standing at the counter now.
 *
 * Fails closed, memoised on the promise, one probe per process — so the API
 * must be restarted after applying the migration, exactly as Modules 27 and 36
 * require.
 */
function hasInvoiceTaxDetail() {
  if (invoiceTaxPromise) return invoiceTaxPromise;

  invoiceTaxPromise = (async () => {
    const { error } = await supabase
      .from('supplier_invoices')
      .select('invoice_type')
      .limit(1);

    if (!error) return true;

    if (error.code === '42703' || error.code?.startsWith('PGRST')) {
      logger.warn(
        { code: error.code },
        'Invoice tax-detail columns not found — supplier invoices will be stored without tax, party or document detail. ' +
        'Apply backend/src/modules/supplier-invoices/schema-37-invoice-tax-detail.sql and restart to enable them.'
      );
      return false;
    }

    logger.warn({ err: error }, 'Could not determine invoice tax-detail support; assuming unavailable');
    return false;
  })();

  return invoiceTaxPromise;
}

/** Test seam — lets a suite assert both branches without a live database. */
function __resetCapabilityCache() {
  looseUnitsPromise = null;
  dismissalsPromise = null;
  invoiceTaxPromise = null;
}

module.exports = {
  hasLooseUnits,
  hasNotificationDismissals,
  hasInvoiceTaxDetail,
  __resetCapabilityCache,
};
