// ── Failed-login counter: storage, behind one interface.
//
// WHY THIS IS NOT A Map ANY MORE
//
// The per-account brute-force control keys on `email:ip` and locks an account
// after 5 failed attempts in 15 minutes. It was a module-level `Map`, which
// makes it per-PROCESS: under PM2 cluster mode (ecosystem.config.js) or behind
// more than one instance, an attacker's attempts are spread across workers and
// each worker counts only the fraction it happened to serve. With N workers the
// real ceiling is 5N, and a restart resets it to zero. The lockout looked like a
// control and measured almost nothing.
//
// WHY POSTGRES AND NOT REDIS
//
// The brief prefers Redis "if Redis is already available". It is not — there is
// no Redis anywhere in this project: not in package.json, not in
// ecosystem.config.js, not in nginx.conf.template, not in the deployment docs.
// Adding it would mean provisioning, securing and monitoring a new stateful
// service on the VPS for one counter.
//
// Supabase Postgres is already a hard dependency of this API — login cannot
// succeed without it, because the profile read on the very next line needs it.
// Counting there costs no new infrastructure and gives genuinely shared state
// across every worker and instance. The increment is a single atomic RPC, so two
// workers racing on the same key cannot both read 4 and both write 5.
//
// THE SEAM
//
// Everything above the `Store` shape is storage-agnostic. A Redis store is
// `read` / `increment` / `clear` against the same contract, and `setStore()`
// swaps it in with no change to auth.service.js. That is deliberately left as a
// seam rather than a stub adapter: an untested Redis path that nobody has run is
// worse than an honest extension point.
//
//   Store = {
//     read(key)      -> { count, firstAttempt } | null
//     increment(key) -> { count, firstAttempt }
//     clear(key)     -> void
//   }
//
// `firstAttempt` is epoch milliseconds and marks the start of the window.

const { supabase } = require('../config/supabase');
const logger = require('./logger');

// Kept here rather than in auth.service so a store implementation can size its
// own expiry from the same number the policy uses.
const WINDOW_MS = 15 * 60 * 1000;

/* ══════════════════════════════ MEMORY STORE ══════════════════════════════
   The original behaviour, extracted unchanged. Still the right store for the
   test suite and for a single-process dev server, and it is the fallback when
   the shared table is not there. */

function createMemoryStore() {
  const attempts = new Map();

  const prune = (key) => {
    const rec = attempts.get(key);
    if (rec && Date.now() - rec.firstAttempt >= WINDOW_MS) {
      attempts.delete(key);
      return null;
    }
    return rec || null;
  };

  return {
    name: 'memory',
    async read(key) { return prune(key); },
    async increment(key) {
      const rec = prune(key) || { count: 0, firstAttempt: Date.now() };
      rec.count += 1;
      attempts.set(key, rec);
      return { ...rec };
    },
    async clear(key) { attempts.delete(key); },
  };
}

/* ═════════════════════════════ POSTGRES STORE ═════════════════════════════
   Shared across workers and instances. Reads are a plain select; the increment
   is `record_login_attempt()`, which does the insert-on-conflict-increment and
   the window roll inside one statement so concurrent workers cannot interleave
   a read and a write.

   FAILURE POSTURE: fail OPEN, and say so loudly.

   A database blip must not lock the whole pharmacy out of the till. Failing
   open here does not leave the login endpoint unprotected — nginx's zone and
   the 40-per-15-minutes IP backstop in app.js both still apply, and a login
   attempt that gets past this counter still has to satisfy Supabase Auth. The
   alternative (fail closed) turns a transient network error into "nobody can
   sign in", which is the outage this codebase has already been bitten by once
   with the old IP-keyed limiter. */

function createPostgresStore() {
  return {
    name: 'postgres',

    async read(key) {
      const { data, error } = await supabase
        .from('login_attempts')
        .select('attempt_count, window_started_at')
        .eq('attempt_key', key)
        .maybeSingle();

      if (error) {
        logger.warn({ reason: error.message }, 'Login-attempt read failed; allowing the attempt through');
        return null;
      }
      if (!data) return null;

      const firstAttempt = new Date(data.window_started_at).getTime();
      // A window that has already rolled is not a lockout. The RPC resets it on
      // the next failure; treating it as absent here keeps read and write
      // agreeing about when 15 minutes are up.
      if (Date.now() - firstAttempt >= WINDOW_MS) return null;

      return { count: data.attempt_count, firstAttempt };
    },

    async increment(key) {
      const { data, error } = await supabase.rpc('record_login_attempt', {
        p_key: key,
        p_window_seconds: Math.floor(WINDOW_MS / 1000),
      });

      if (error) {
        logger.warn({ reason: error.message }, 'Login-attempt increment failed; this failure was not counted');
        return { count: 0, firstAttempt: Date.now() };
      }

      // The RPC returns a single row (setof), so supabase-js hands back an array.
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { count: 0, firstAttempt: Date.now() };

      return {
        count: row.attempt_count,
        firstAttempt: new Date(row.window_started_at).getTime(),
      };
    },

    async clear(key) {
      const { error } = await supabase.from('login_attempts').delete().eq('attempt_key', key);
      if (error) logger.warn({ reason: error.message }, 'Login-attempt clear failed');
    },
  };
}

/* ════════════════════════════ STORE SELECTION ════════════════════════════
   One probe per process for the shared table, memoised on the promise so a
   burst of logins at opening issues one probe between them rather than one
   each. Same pattern and the same reasoning as config/capabilities.js: a
   pending migration may cost the FEATURE, it must never cost the till. */

let storePromise = null;
let injectedStore = null;

async function probeStore() {
  const { error } = await supabase.from('login_attempts').select('attempt_key').limit(1);

  if (!error) {
    logger.info('Login rate limiting: shared Postgres store active');
    return createPostgresStore();
  }

  // 42P01 = undefined_table; PGRST2xx = PostgREST's schema cache has no such
  // table. Both mean schema-28 has not been applied here.
  if (error.code === '42P01' || error.code?.startsWith('PGRST')) {
    logger.warn(
      { code: error.code },
      'login_attempts table not found — per-account login limiting is PER-PROCESS only. ' +
      'Apply backend/src/db/schema-28-security-hardening.sql and restart for shared limits.'
    );
  } else {
    logger.warn({ err: error }, 'Could not reach the shared login-attempt store; falling back to in-memory');
  }
  return createMemoryStore();
}

function getStore() {
  if (injectedStore) return Promise.resolve(injectedStore);
  if (!storePromise) storePromise = probeStore();
  return storePromise;
}

/**
 * Swap the store. The Redis seam, and the test seam.
 * Pass null to return to automatic selection.
 */
function setStore(store) {
  injectedStore = store;
  storePromise = null;
}

module.exports = { getStore, setStore, createMemoryStore, createPostgresStore, WINDOW_MS };
