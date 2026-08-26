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

/** Test seam — lets a suite assert both branches without a live database. */
function __resetCapabilityCache() {
  looseUnitsPromise = null;
}

module.exports = { hasLooseUnits, __resetCapabilityCache };
