/**
 * Unit tests — resolveDismissals and countLiveAlerts. Pure: fake Supabase, no
 * credentials, no network.
 *
 * /notifications/count is polled once a minute by every owner tab, and used to
 * build every live alert object just to call .length on the array. It now
 * reaches the same number from two head-counts minus the dismissals that still
 * silence something.
 *
 * "The same number" is the whole claim, and the subtlety is the TIER: an alert
 * key carries it (alert:LOW_STOCK:<id>:out), so a dismissal is live only while
 * the thing it silenced is still in the tier it was silenced at.
 */

const mockFrom = jest.fn();

jest.mock('../../src/config/supabase', () => ({
  supabase: { from: (...args) => mockFrom(...args), rpc: async () => ({ data: null, error: null }) },
  createAuthClient: () => ({}),
}));

jest.mock('../../src/config/capabilities', () => ({
  hasNotificationDismissals: async () => true,
  hasLooseUnits: async () => true,
  hasInvoiceTaxDetail: async () => true,
  __resetCapabilityCache: () => {},
}));

const svc = require('../../src/modules/notifications/notifications.service');

const OWNER = { id: 'owner-1', role: 'owner' };
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/**
 * A fake postgrest builder that records the filters applied to it and resolves
 * to whatever the table's handler returns.
 */
function fakeTable(handler) {
  const state = { ins: [], eqs: [], head: false, count: null };
  const builder = {
    state,
    select: (_cols, options) => {
      state.head = Boolean(options?.head);
      state.count = options?.count ?? null;
      return builder;
    },
    neq: () => builder,
    eq: (col, val) => { state.eqs.push([col, val]); return builder; },
    in: (col, vals) => { state.ins.push([col, vals]); return builder; },
    delete: () => { state.deleted = true; return builder; },
    then: (resolve, reject) => Promise.resolve(handler(state)).then(resolve, reject),
  };
  return builder;
}

/** Wire up the three tables resolveDismissals / countLiveAlerts touch. */
function arrange({ dismissals = [], expiryRows = [], stockRows = [], expiryCount = 0, stockCount = 0 }) {
  const deletes = [];
  const inCalls = { expiry_summary: [], medicines_with_stock: [] };

  mockFrom.mockImplementation((table) => {
    if (table === 'notification_dismissals') {
      return fakeTable((s) => {
        if (s.deleted) { deletes.push(s.ins.flatMap(([, v]) => v)); return { error: null }; }
        return { data: dismissals.map((alert_key) => ({ alert_key })), error: null };
      });
    }
    if (table === 'expiry_summary') {
      return fakeTable((s) => {
        if (s.head) return { count: expiryCount, data: null, error: null };
        const ids = s.ins.length ? s.ins[0][1] : null;
        if (ids) inCalls.expiry_summary.push(ids);
        return { data: ids ? expiryRows.filter((r) => ids.includes(r.id)) : expiryRows, error: null };
      });
    }
    if (table === 'medicines_with_stock') {
      return fakeTable((s) => {
        if (s.head) return { count: stockCount, data: null, error: null };
        const ids = s.ins.length ? s.ins[0][1] : null;
        if (ids) inCalls.medicines_with_stock.push(ids);
        return { data: ids ? stockRows.filter((r) => ids.includes(r.id)) : stockRows, error: null };
      });
    }
    if (table === 'notifications') {
      return fakeTable(() => ({ count: 0, data: [], error: null }));
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { deletes, inCalls };
}

beforeEach(() => mockFrom.mockReset());

describe('resolveDismissals — liveness is tier-sensitive', () => {
  test('a dismissal on a batch still at that urgency is live', async () => {
    arrange({
      dismissals: [`alert:NEAR_EXPIRY:${uuid(1)}:critical`],
      expiryRows: [{ id: uuid(1), urgency: 'critical' }],
    });
    const { liveKeys, staleKeys } = await svc.resolveDismissals(OWNER.id);
    expect([...liveKeys]).toEqual([`alert:NEAR_EXPIRY:${uuid(1)}:critical`]);
    expect(staleKeys).toEqual([]);
  });

  test('a batch that has crossed into a worse tier makes its dismissal stale', async () => {
    // Silenced at `warning`; it is now `critical`. That is a different alert
    // and it must speak again — the dismissal silences nothing.
    arrange({
      dismissals: [`alert:NEAR_EXPIRY:${uuid(2)}:warning`],
      expiryRows: [{ id: uuid(2), urgency: 'critical' }],
    });
    const { liveKeys, staleKeys } = await svc.resolveDismissals(OWNER.id);
    expect(liveKeys.size).toBe(0);
    expect(staleKeys).toEqual([`alert:NEAR_EXPIRY:${uuid(2)}:warning`]);
  });

  test('a dismissal whose entity is gone entirely is stale', async () => {
    // Written off, or sold down to nothing — expiry_summary only carries
    // batches that still hold stock.
    arrange({ dismissals: [`alert:NEAR_EXPIRY:${uuid(3)}:expired`], expiryRows: [] });
    const { liveKeys, staleKeys } = await svc.resolveDismissals(OWNER.id);
    expect(liveKeys.size).toBe(0);
    expect(staleKeys).toHaveLength(1);
  });

  test('a medicine dismissed at `out` that took delivery of one unit is stale', async () => {
    // THE case the tier check exists for. is_low_stock is still true at 4 of
    // 20, so the row is still returned — only the tier moved, out -> low.
    arrange({
      dismissals: [`alert:LOW_STOCK:${uuid(4)}:out`],
      stockRows: [{ id: uuid(4), total_stock: 4 }],
    });
    const { liveKeys, staleKeys } = await svc.resolveDismissals(OWNER.id);
    expect(liveKeys.size).toBe(0);
    expect(staleKeys).toEqual([`alert:LOW_STOCK:${uuid(4)}:out`]);
  });

  test('a medicine still at zero keeps its `out` dismissal live', async () => {
    arrange({
      dismissals: [`alert:LOW_STOCK:${uuid(5)}:out`],
      stockRows: [{ id: uuid(5), total_stock: 0 }],
    });
    const { liveKeys } = await svc.resolveDismissals(OWNER.id);
    expect(liveKeys.size).toBe(1);
  });

  test('no dismissals means no probe at all', async () => {
    arrange({ dismissals: [] });
    const { liveKeys, staleKeys } = await svc.resolveDismissals(OWNER.id);
    expect(liveKeys.size).toBe(0);
    expect(staleKeys).toEqual([]);
    // Only the dismissals table was read; neither view was probed.
    expect(mockFrom.mock.calls.map(([t]) => t)).toEqual(['notification_dismissals']);
  });
});

describe('resolveDismissals — the .in() is chunked', () => {
  test('400 dismissals become 3 probes of at most 150 ids', async () => {
    // markAllRead writes one dismissal per live alert, so this count is not
    // human-bounded. Unchunked, a cleared 3,000-alert bell would put 3,000
    // UUIDs in a query string on every 60-second poll — a 414 from nginx, not
    // a 500, which is a confusing way to fail.
    const ids = Array.from({ length: 400 }, (_, i) => uuid(i + 100));
    const { inCalls } = arrange({
      dismissals: ids.map((id) => `alert:LOW_STOCK:${id}:out`),
      stockRows: ids.map((id) => ({ id, total_stock: 0 })),
    });

    const { liveKeys } = await svc.resolveDismissals(OWNER.id);

    expect(inCalls.medicines_with_stock).toHaveLength(3);
    expect(inCalls.medicines_with_stock.map((c) => c.length)).toEqual([150, 150, 100]);
    expect(liveKeys.size).toBe(400);   // and every one is still resolved
  });
});

describe('countLiveAlerts — exact, from head-counts', () => {
  test('is the two counts minus the dismissals that are still live', async () => {
    arrange({
      expiryCount: 40,
      stockCount: 12,
      dismissals: [
        `alert:NEAR_EXPIRY:${uuid(6)}:critical`,   // live
        `alert:LOW_STOCK:${uuid(7)}:out`,          // live
        `alert:LOW_STOCK:${uuid(8)}:out`,          // stale — now `low`
      ],
      expiryRows: [{ id: uuid(6), urgency: 'critical' }],
      stockRows: [{ id: uuid(7), total_stock: 0 }, { id: uuid(8), total_stock: 6 }],
    });

    await expect(svc.countLiveAlerts(OWNER)).resolves.toBe(50);   // 40 + 12 - 2
  });

  test('never returns a negative badge', async () => {
    // Belt and braces: if the counts and the probe ever disagree (a batch
    // written off between the two queries), a negative badge is worse than a
    // slightly stale zero.
    arrange({
      expiryCount: 0,
      stockCount: 0,
      dismissals: [`alert:LOW_STOCK:${uuid(9)}:out`],
      stockRows: [{ id: uuid(9), total_stock: 0 }],
    });
    await expect(svc.countLiveAlerts(OWNER)).resolves.toBe(0);
  });

  test('staff get nothing, without touching the database', async () => {
    // A9 payload gate: staff cannot act on expiry or reorder decisions, so the
    // alerts never leave the server rather than being hidden in the DOM.
    arrange({ expiryCount: 99, stockCount: 99 });
    await expect(svc.countLiveAlerts({ id: 'u2', role: 'staff' })).resolves.toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('a failed count degrades to 0 rather than throwing the bell down', async () => {
    mockFrom.mockImplementation(() => { throw new Error('view exploded'); });
    await expect(svc.countLiveAlerts(OWNER)).resolves.toBe(0);
  });
});

describe('liveAlertKeys — read-all stays complete', () => {
  test('enumerates EVERY live key, uncapped', async () => {
    // markAllRead upserts one dismissal per key returned here. A cap would
    // leave a badge that cannot be cleared — invisible, and worse than a slow
    // click. This is why liveAlertKeys keeps the whole-table read while the
    // 60-second poll does not.
    const expiryRows = Array.from({ length: 120 }, (_, i) => ({ id: uuid(i + 500), urgency: 'watch' }));
    const stockRows = Array.from({ length: 80 }, (_, i) => ({ id: uuid(i + 900), total_stock: 0 }));
    arrange({ expiryRows, stockRows });

    const keys = await svc.liveAlertKeys(OWNER);
    expect(keys).toHaveLength(200);
    expect(keys).toContain(`alert:NEAR_EXPIRY:${uuid(500)}:watch`);
    expect(keys).toContain(`alert:LOW_STOCK:${uuid(900)}:out`);
  });

  test('staff get nothing', async () => {
    arrange({ expiryRows: [{ id: uuid(1), urgency: 'expired' }] });
    await expect(svc.liveAlertKeys({ id: 'u2', role: 'staff' })).resolves.toEqual([]);
  });
});
