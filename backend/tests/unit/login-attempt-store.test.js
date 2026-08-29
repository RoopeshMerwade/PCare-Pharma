/**
 * Failed-login counter — store semantics.
 * Runner: npx jest tests/unit/login-attempt-store.test.js --runInBand
 *
 * Pure: no credentials, no network, no database. The Postgres store is
 * exercised against a fake supabase client so its window-roll arithmetic and
 * its fail-open posture are covered without a live project.
 *
 * WHAT THIS PROTECTS
 *
 * The per-account limiter (5 failed attempts per email+IP per 15 minutes) was a
 * module-level Map, which counts per PROCESS: under PM2 cluster mode the real
 * ceiling was 5 x workers and a restart reset it to zero. The policy did not
 * change — only where the count lives — so these tests assert the BEHAVIOUR is
 * identical across both stores, which is what makes the swap safe.
 */

const WINDOW_MS = 15 * 60 * 1000;

// ── Fake supabase, shared by the Postgres-store tests ────────────────────────
const mockDb = { rows: new Map(), failReads: false, failRpc: false, missingTable: false };

jest.mock('../../src/config/supabase', () => ({
  supabase: {
    from: () => {
      const q = { _key: null };
      const chain = () => q;
      q.select = chain; q.limit = chain;
      q.eq = (col, val) => { q._key = val; return q; };
      q.maybeSingle = async () => {
        if (mockDb.failReads) return { data: null, error: { message: 'connection reset' } };
        const row = mockDb.rows.get(q._key);
        return { data: row || null, error: null };
      };
      q.delete = () => ({
        eq: async (col, val) => { mockDb.rows.delete(val); return { error: null }; },
      });
      // Awaiting the builder is the probe path in loginAttemptStore.
      q.then = (resolve, reject) => {
        const result = mockDb.missingTable
          ? { data: null, error: { code: '42P01', message: 'relation "login_attempts" does not exist' } }
          : { data: [], error: null };
        return Promise.resolve(result).then(resolve, reject);
      };
      return q;
    },
    rpc: async (_fn, { p_key, p_window_seconds }) => {
      if (mockDb.failRpc) return { data: null, error: { message: 'timeout' } };
      const windowMs = p_window_seconds * 1000;
      const existing = mockDb.rows.get(p_key);
      const now = Date.now();
      let row;
      if (!existing || new Date(existing.window_started_at).getTime() < now - windowMs) {
        row = { attempt_count: 1, window_started_at: new Date(now).toISOString() };
      } else {
        row = { attempt_count: existing.attempt_count + 1, window_started_at: existing.window_started_at };
      }
      mockDb.rows.set(p_key, row);
      // The SQL function returns `setof`, so supabase-js hands back an array.
      return { data: [row], error: null };
    },
    auth: {},
    storage: { from: () => ({}) },
  },
  createAuthClient: () => ({ auth: {} }),
}));

const store = require('../../src/utils/loginAttemptStore');

const KEY = 'anita@pcare.in:203.0.113.9';

beforeEach(() => {
  mockDb.rows = new Map();
  mockDb.failReads = false;
  mockDb.failRpc = false;
  mockDb.missingTable = false;
  store.setStore(null);
});

/* ═════════════════ Behaviour both stores must share ═════════════════ */

describe.each([
  ['memory', () => store.createMemoryStore()],
  ['postgres', () => store.createPostgresStore()],
])('%s store', (_name, make) => {
  test('an unseen key has no record', async () => {
    expect(await make().read(KEY)).toBeNull();
  });

  test('counts up from one', async () => {
    const s = make();
    expect((await s.increment(KEY)).count).toBe(1);
    expect((await s.increment(KEY)).count).toBe(2);
    expect((await s.read(KEY)).count).toBe(2);
  });

  test('reaches the lockout threshold at exactly five', async () => {
    const s = make();
    for (let i = 0; i < 4; i += 1) await s.increment(KEY);
    expect((await s.read(KEY)).count).toBe(4);   // still allowed
    await s.increment(KEY);
    expect((await s.read(KEY)).count).toBe(5);   // locked
  });

  test('a successful login clears the key', async () => {
    const s = make();
    await s.increment(KEY);
    await s.increment(KEY);
    await s.clear(KEY);
    expect(await s.read(KEY)).toBeNull();
  });

  test('keys are independent — one account locking out does not affect another', async () => {
    const s = make();
    await s.increment(KEY);
    await s.increment(KEY);
    expect(await s.read('ravi@pcare.in:203.0.113.9')).toBeNull();
    // Same email from a different IP is a different key, by design: the key has
    // always been email:ip, so one attacker cannot lock a colleague out from
    // somewhere else on the network.
    expect(await s.read('anita@pcare.in:198.51.100.4')).toBeNull();
  });

  test('the window start is carried forward across attempts, not reset', async () => {
    const s = make();
    const first = await s.increment(KEY);
    await new Promise((r) => setTimeout(r, 5));
    const second = await s.increment(KEY);
    expect(second.firstAttempt).toBe(first.firstAttempt);
  });

  test('a window older than 15 minutes reads as absent', async () => {
    const s = make();
    await s.increment(KEY);

    const realNow = Date.now;
    Date.now = () => realNow() + WINDOW_MS + 1000;
    try {
      expect(await s.read(KEY)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

/* ═════════════════ Postgres-specific: failure posture & bounded fallback ═════════════════ */

describe('postgres store bounded local fallback', () => {
  // When database RPC or network is transiently down, the postgres store falls back
  // to a bounded process-local counter so failed attempts are still captured locally
  // rather than dropping to zero.
  test('an unseen key with unreadable store returns null', async () => {
    mockDb.failReads = true;
    expect(await store.createPostgresStore().read(KEY)).toBeNull();
  });

  test('a failed RPC increment uses the bounded process-local fallback counter', async () => {
    mockDb.failRpc = true;
    const s = store.createPostgresStore();
    const result1 = await s.increment(KEY);
    expect(result1.count).toBe(1);
    const result2 = await s.increment(KEY);
    expect(result2.count).toBe(2);
    expect((await s.read(KEY)).count).toBe(2);
  });

  test('when database recovers, the higher count is preserved and clearing clears both', async () => {
    const s = store.createPostgresStore();
    // 1 attempt with DB healthy
    await s.increment(KEY);
    // 2 attempts during DB RPC failure
    mockDb.failRpc = true;
    mockDb.failReads = true;
    await s.increment(KEY);
    await s.increment(KEY);
    // DB recovers
    mockDb.failRpc = false;
    mockDb.failReads = false;
    const rec = await s.read(KEY);
    expect(rec.count).toBeGreaterThanOrEqual(3);
    await s.clear(KEY);
    expect(await s.read(KEY)).toBeNull();
  });
});

/* ═════════════════ Store selection and the Redis seam ═════════════════ */

describe('store selection', () => {
  test('picks the shared Postgres store when the table is there', async () => {
    const selected = await store.getStore();
    expect(selected.name).toBe('postgres');
  });

  test('falls back to memory when the migration has not been applied', async () => {
    mockDb.missingTable = true;
    const selected = await store.getStore();
    expect(selected.name).toBe('memory');
  });

  test('probes once per process, not once per login', async () => {
    const a = await store.getStore();
    const b = await store.getStore();
    expect(a).toBe(b);
  });

  test('setStore swaps the implementation — this is the Redis seam', async () => {
    const calls = [];
    const fake = {
      name: 'redis',
      async read(k) { calls.push(['read', k]); return null; },
      async increment(k) { calls.push(['increment', k]); return { count: 1, firstAttempt: Date.now() }; },
      async clear(k) { calls.push(['clear', k]); },
    };
    store.setStore(fake);

    const selected = await store.getStore();
    expect(selected.name).toBe('redis');
    await selected.increment(KEY);
    expect(calls).toEqual([['increment', KEY]]);
  });
});
