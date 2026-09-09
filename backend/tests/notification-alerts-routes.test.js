/**
 * Module 36 — derived alerts end to end through the router. HERMETIC.
 *
 * No network, no seeded data, no credentials — but backend/.env must exist,
 * because app.js validates config at require time. Runs in CI.
 *
 * Unlike stock-requisition-routes.test.js, the Supabase stub here does not
 * throw: this file asserts BEHAVIOUR (what the badge counts, what a dismissal
 * silences, what the garbage collector deletes), not just which guard fired.
 * So `db` below is a small in-memory table set that supports exactly the query
 * shapes notifications.service.js builds, and each test drives it directly.
 */

const mockSession = { id: 'owner-1', role: 'owner' };

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, res, next) => {
    req.user = {
      id: mockSession.id, full_name: 'Test User', is_active: true, role: mockSession.role,
    };
    next();
  },
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role) ? next()
      : next(Object.assign(new Error('Forbidden'), {
        statusCode: 403, code: 'FORBIDDEN', isOperational: true,
      }))
  ),
}));

// ── In-memory tables ────────────────────────────────────────────────────────

const db = {
  migrated: true,            // flip to simulate schema-36 not applied
  expiry_summary: [],
  medicines_with_stock: [],
  notifications: [],
  notification_dismissals: [],
};

const NOT_MIGRATED = { code: '42P01', message: 'relation "notification_dismissals" does not exist' };

/** Applies the filter shapes the service actually uses. */
function applyFilters(rows, filters) {
  return filters.reduce((acc, f) => {
    if (f.op === 'eq')  return acc.filter((r) => r[f.col] === f.val);
    if (f.op === 'neq') return acc.filter((r) => r[f.col] !== f.val);
    if (f.op === 'in')  return acc.filter((r) => f.val.includes(r[f.col]));
    if (f.op === 'or') {
      // Only shape used: `user_id.eq.X,user_id.is.null` — own rows + broadcasts.
      const id = /user_id\.eq\.([^,]+)/.exec(f.val)?.[1];
      return acc.filter((r) => r.user_id === id || r.user_id === null);
    }
    return acc;
  }, rows);
}

function mockMakeQuery(table) {
  const state = { op: 'select', filters: [], count: null, head: false, limit: null, payload: null };

  const run = () => {
    if (table === 'notification_dismissals' && !db.migrated) {
      return { data: null, error: NOT_MIGRATED, count: null };
    }
    const rows = db[table] || [];

    if (state.op === 'select') {
      let out = applyFilters(rows, state.filters);
      const total = out.length;
      if (state.limit !== null) out = out.slice(0, state.limit);
      return { data: state.head ? null : out.map((r) => ({ ...r })), error: null, count: state.count ? total : null };
    }
    if (state.op === 'update') {
      for (const r of applyFilters(rows, state.filters)) Object.assign(r, state.payload);
      return { data: null, error: null, count: null };
    }
    if (state.op === 'delete') {
      const doomed = new Set(applyFilters(rows, state.filters));
      db[table] = rows.filter((r) => !doomed.has(r));
      return { data: null, error: null, count: null };
    }
    if (state.op === 'upsert') {
      for (const row of [].concat(state.payload)) {
        const dup = rows.find((r) => r.user_id === row.user_id && r.alert_key === row.alert_key);
        if (!dup) rows.push({ ...row });
      }
      return { data: null, error: null, count: null };
    }
    throw new Error(`unhandled op ${state.op}`);
  };

  const q = {
    select(_cols, opts = {}) {
      if (opts.count) state.count = opts.count;
      if (opts.head) state.head = true;
      return q;
    },
    update(payload) { state.op = 'update'; state.payload = payload; return q; },
    delete()        { state.op = 'delete'; return q; },
    upsert(payload) { state.op = 'upsert'; state.payload = payload; return q; },
    eq(col, val)    { state.filters.push({ op: 'eq', col, val }); return q; },
    neq(col, val)   { state.filters.push({ op: 'neq', col, val }); return q; },
    in(col, val)    { state.filters.push({ op: 'in', col, val }); return q; },
    or(val)         { state.filters.push({ op: 'or', val }); return q; },
    order()         { return q; },
    limit(n)        { state.limit = n; return q; },
    then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
  };
  return q;
}

jest.mock('../src/config/supabase', () => ({
  supabase: { from: (t) => mockMakeQuery(t), rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) }, auth: {} },
  createAuthClient: () => ({}),
}));

const request = require('supertest');
const app = require('../src/app');
const { __resetCapabilityCache } = require('../src/config/capabilities');
const { alertKey } = require('../src/modules/notifications/notifications.alerts');

const BASE = '/api/v1/notifications';
const BATCH = 'b1111111-2222-4333-8444-555555555555';
const MED   = 'm2222222-3333-4444-8555-666666666666';
const NOTE  = '99999999-8888-4777-8666-555555555555';

const expiryRow = (over = {}) => ({
  id: BATCH, medicine_name: 'Dolo 650', medicine_unit: 'strips', batch_no: 'B12',
  exp_date: '2026-12-01', stock_qty: 40, loose_qty: 0,
  urgency: 'critical', days_to_expiry: 12, potential_loss_value: '4124.80', ...over,
});

const stockRow = (over = {}) => ({
  id: MED, name: 'Azithral 500', unit: 'strips', total_stock: 4,
  low_stock_threshold: 20, is_active: true, is_low_stock: true, ...over,
});

const eventRow = (over = {}) => ({
  id: NOTE, user_id: 'owner-1', type: 'STAFF_CHECK_IN', title: 'Ravi checked in',
  message: '09:02', is_read: false, metadata: {}, created_at: '2026-09-01T03:32:00Z', ...over,
});

const asRole = (role, id = 'owner-1') => { mockSession.role = role; mockSession.id = id; };

beforeEach(() => {
  db.migrated = true;
  db.expiry_summary = [];
  db.medicines_with_stock = [];
  db.notifications = [];
  db.notification_dismissals = [];
  asRole('owner');
  __resetCapabilityCache();
});

const list = () => request(app).get(BASE);
const count = () => request(app).get(`${BASE}/count`);

// ── Role scoping (A9: filtered in the payload, not the DOM) ──────────────────

describe('derived alerts are owner-only, server-side', () => {
  test('the owner receives expiry and low-stock alerts', async () => {
    db.expiry_summary = [expiryRow()];
    db.medicines_with_stock = [stockRow()];

    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.data.notifications.map((n) => n.type))
      .toEqual(['NEAR_EXPIRY', 'LOW_STOCK']);
  });

  test('staff receive NONE of them, and keep their stored events', async () => {
    db.expiry_summary = [expiryRow()];
    db.medicines_with_stock = [stockRow()];
    db.notifications = [eventRow({ user_id: 'staff-9', type: 'STOCK_REQUISITION_APPROVED' })];
    asRole('staff', 'staff-9');

    const r = await list();
    const types = r.body.data.notifications.map((n) => n.type);
    expect(types).toEqual(['STOCK_REQUISITION_APPROVED']);
    // The alerts must be absent from the PAYLOAD, not merely unrendered.
    expect(JSON.stringify(r.body)).not.toContain('Dolo 650');
    expect(JSON.stringify(r.body)).not.toContain('alert:');
  });

  test("staff's badge counts only their stored events", async () => {
    db.expiry_summary = [expiryRow()];
    db.notifications = [eventRow({ user_id: 'staff-9' })];
    asRole('staff', 'staff-9');
    expect((await count()).body.data.unread_count).toBe(1);
  });
});

// ── Ordering and counting ───────────────────────────────────────────────────

describe('list and count', () => {
  test('alerts lead the list — a live condition outranks last week’s history', async () => {
    db.expiry_summary = [expiryRow()];
    db.notifications = [eventRow()];

    const [first, second] = (await list()).body.data.notifications;
    expect(first.derived).toBe(true);
    expect(second.id).toBe(NOTE);
  });

  test('the badge is alerts plus unread stored, and ignores read ones', async () => {
    db.expiry_summary = [expiryRow(), expiryRow({ id: 'b2', urgency: 'expired' })];
    db.medicines_with_stock = [stockRow()];
    db.notifications = [eventRow(), eventRow({ id: 'n2', is_read: true })];

    expect((await count()).body.data.unread_count).toBe(4);  // 3 alerts + 1 unread
  });

  test('a healthy shelf produces nothing at all', async () => {
    db.expiry_summary = [expiryRow({ urgency: 'ok' })];
    expect((await list()).body.data.notifications).toEqual([]);
    expect((await count()).body.data.unread_count).toBe(0);
  });

  test('alerts carry `context` so the client need not date them', async () => {
    db.expiry_summary = [expiryRow()];
    expect((await list()).body.data.notifications[0].context).toBe('Expires in 12 days');
  });
});

// ── Dismissal: the behaviour the feature was asked for ───────────────────────

describe('marking an alert read', () => {
  test('removes it from the list and the badge, and it STAYS gone', async () => {
    db.expiry_summary = [expiryRow()];
    const key = alertKey('NEAR_EXPIRY', BATCH, 'critical');

    expect((await count()).body.data.unread_count).toBe(1);

    const r = await request(app).patch(`${BASE}/${encodeURIComponent(key)}/read`);
    expect(r.status).toBe(200);
    expect(db.notification_dismissals).toEqual([
      expect.objectContaining({ user_id: 'owner-1', alert_key: key }),
    ]);

    // Fresh requests — the same thing a re-login does.
    expect((await count()).body.data.unread_count).toBe(0);
    expect((await list()).body.data.notifications).toEqual([]);
  });

  test('is idempotent — a double click is not a duplicate-key error', async () => {
    db.expiry_summary = [expiryRow()];
    const key = alertKey('NEAR_EXPIRY', BATCH, 'critical');
    await request(app).patch(`${BASE}/${encodeURIComponent(key)}/read`);
    const second = await request(app).patch(`${BASE}/${encodeURIComponent(key)}/read`);
    expect(second.status).toBe(200);
    expect(db.notification_dismissals).toHaveLength(1);
  });

  test('silences one alert only, not every alert of that type', async () => {
    db.expiry_summary = [expiryRow(), expiryRow({ id: 'b2', batch_no: 'B99' })];
    await request(app)
      .patch(`${BASE}/${encodeURIComponent(alertKey('NEAR_EXPIRY', BATCH, 'critical'))}/read`);

    const left = (await list()).body.data.notifications;
    expect(left).toHaveLength(1);
    expect(left[0].metadata.batch_id).toBe('b2');
  });

  test('a stored notification still marks read the old way', async () => {
    db.notifications = [eventRow()];
    const r = await request(app).patch(`${BASE}/${NOTE}/read`);
    expect(r.status).toBe(200);
    expect(db.notifications[0].is_read).toBe(true);
    expect(db.notification_dismissals).toEqual([]);
  });
});

// ── Escalation ──────────────────────────────────────────────────────────────

describe('escalation', () => {
  test('THE HEADLINE RULE: a nearer tier speaks despite the earlier dismissal', async () => {
    db.expiry_summary = [expiryRow({ urgency: 'watch', days_to_expiry: 88 })];
    await request(app)
      .patch(`${BASE}/${encodeURIComponent(alertKey('NEAR_EXPIRY', BATCH, 'watch'))}/read`);
    expect((await count()).body.data.unread_count).toBe(0);

    // Time passes; the same batch is now inside 30 days.
    db.expiry_summary = [expiryRow({ urgency: 'critical', days_to_expiry: 12 })];

    const r = await list();
    expect(r.body.data.notifications).toHaveLength(1);
    expect(r.body.data.notifications[0].context).toBe('Expires in 12 days');
    expect((await count()).body.data.unread_count).toBe(1);
  });

  test('low stock running out raises a fresh alert after a dismissal', async () => {
    db.medicines_with_stock = [stockRow({ total_stock: 4 })];
    await request(app)
      .patch(`${BASE}/${encodeURIComponent(alertKey('LOW_STOCK', MED, 'low'))}/read`);
    expect((await count()).body.data.unread_count).toBe(0);

    db.medicines_with_stock = [stockRow({ total_stock: 0 })];
    expect((await list()).body.data.notifications[0].context).toBe('Out of stock');
  });
});

// ── Stale-dismissal GC: the low-stock oscillation ───────────────────────────

describe('a dismissal lives exactly as long as the thing it dismissed', () => {
  test('restocking deletes the dismissal, so the NEXT dip alerts again', async () => {
    // Go low, dismiss.
    db.medicines_with_stock = [stockRow({ total_stock: 4 })];
    await request(app)
      .patch(`${BASE}/${encodeURIComponent(alertKey('LOW_STOCK', MED, 'low'))}/read`);
    expect(db.notification_dismissals).toHaveLength(1);

    // Restocked: the medicine leaves the low-stock view entirely.
    db.medicines_with_stock = [];
    await list();
    expect(db.notification_dismissals).toEqual([]);   // collected

    // Falls low again under the SAME key. Without the GC this is silent forever.
    db.medicines_with_stock = [stockRow({ total_stock: 4 })];
    expect((await count()).body.data.unread_count).toBe(1);
  });

  test('a written-off batch takes its alert and its dismissal with it', async () => {
    db.expiry_summary = [expiryRow()];
    await request(app)
      .patch(`${BASE}/${encodeURIComponent(alertKey('NEAR_EXPIRY', BATCH, 'critical'))}/read`);

    db.expiry_summary = [];                            // written off
    expect((await list()).body.data.notifications).toEqual([]);
    expect(db.notification_dismissals).toEqual([]);
  });

  test('a still-live dismissal is never collected', async () => {
    db.expiry_summary = [expiryRow()];
    const key = alertKey('NEAR_EXPIRY', BATCH, 'critical');
    await request(app).patch(`${BASE}/${encodeURIComponent(key)}/read`);

    await list(); await count(); await list();          // several polls
    expect(db.notification_dismissals.map((d) => d.alert_key)).toEqual([key]);
  });
});

// ── Mark all as read ────────────────────────────────────────────────────────

describe('read-all clears both halves', () => {
  test('the badge reaches zero, which one half alone would not achieve', async () => {
    db.expiry_summary = [expiryRow(), expiryRow({ id: 'b2', urgency: 'expired' })];
    db.medicines_with_stock = [stockRow()];
    db.notifications = [eventRow()];

    expect((await count()).body.data.unread_count).toBe(4);

    const r = await request(app).patch(`${BASE}/read-all`);
    expect(r.status).toBe(200);

    expect(db.notifications[0].is_read).toBe(true);
    expect(db.notification_dismissals).toHaveLength(3);
    expect((await count()).body.data.unread_count).toBe(0);
  });

  test('is reached before /:id/read — Express matches in order', async () => {
    // If the literal path bound to :id it would fail the identifier validator
    // and answer 422 about a malformed id, a routing bug in validation clothing.
    const r = await request(app).patch(`${BASE}/read-all`);
    expect(r.status).toBe(200);
  });

  test('with nothing outstanding it is a no-op, not an error', async () => {
    const r = await request(app).patch(`${BASE}/read-all`);
    expect(r.status).toBe(200);
    expect(db.notification_dismissals).toEqual([]);
  });
});

// ── Identifier validation ───────────────────────────────────────────────────

describe('PATCH /:id/read accepts exactly two identifier shapes', () => {
  test('a notification UUID', async () => {
    db.notifications = [eventRow()];
    expect((await request(app).patch(`${BASE}/${NOTE}/read`)).status).toBe(200);
  });

  test('an alert key, colons and all', async () => {
    const key = alertKey('NEAR_EXPIRY', BATCH, 'critical');
    expect((await request(app).patch(`${BASE}/${encodeURIComponent(key)}/read`)).status).toBe(200);
    // Unencoded too: colons are legal in a path segment.
    expect((await request(app).patch(`${BASE}/${key}/read`)).status).toBe(200);
  });

  test.each([
    ['banana'],
    ['alert-NEAR_EXPIRY-x-critical'],
    ['12345'],
    ['not-a-uuid-at-all-really'],
  ])('%s is refused with 422', async (bad) => {
    const r = await request(app).patch(`${BASE}/${encodeURIComponent(bad)}/read`);
    expect([r.status, r.body.error]).toEqual([422, 'VALIDATION_ERROR']);
  });
});

// ── Degraded mode: schema-36 not applied ────────────────────────────────────

describe('an unmigrated database costs the feature, never the bell', () => {
  test('stored events still load; derived alerts are simply absent', async () => {
    db.migrated = false;
    db.expiry_summary = [expiryRow()];
    db.medicines_with_stock = [stockRow()];
    db.notifications = [eventRow()];

    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.data.notifications.map((n) => n.id)).toEqual([NOTE]);
    expect((await count()).body.data.unread_count).toBe(1);
  });

  test('read-all still works on the stored half', async () => {
    db.migrated = false;
    db.notifications = [eventRow()];
    expect((await request(app).patch(`${BASE}/read-all`)).status).toBe(200);
    expect(db.notifications[0].is_read).toBe(true);
  });
});
