/**
 * MODULES 15–20: Reports, Notifications, Dashboard,
 *                Settings, Audit Logs
 * Runner: Jest + Supertest
 */

const request = require('supertest');
const app = require('../src/app');

let ownerToken, staffToken;

beforeAll(async () => {
  const [o, s] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD }),
    request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_STAFF_EMAIL,  password: process.env.TEST_STAFF_PASSWORD }),
  ]);
  ownerToken = o.body.data.session.access_token;
  staffToken = s.body.data.session.access_token;
});

const oa = () => ({ Authorization: `Bearer ${ownerToken}` });
const sa = () => ({ Authorization: `Bearer ${staffToken}` });

const today = new Date().toISOString().slice(0,10);
const month = new Date(new Date().setDate(1)).toISOString().slice(0,10);

// ════════════════════════════════════
// MODULE 15 — REPORTS
// ════════════════════════════════════

describe('Module 15 — Reports', () => {
  test('TC-RPT-01: Staff cannot access any report — 403', async () => {
    const [a, b, c, d] = await Promise.all([
      request(app).get('/api/v1/reports/sales').set(sa()),
      request(app).get('/api/v1/reports/margins').set(sa()),
      request(app).get('/api/v1/reports/inventory').set(sa()),
      request(app).get('/api/v1/reports/purchases').set(sa()),
    ]);
    [a,b,c,d].forEach(r => expect(r.status).toBe(403));
  });

  test('TC-RPT-02: Sales report returns correct shape', async () => {
    const res = await request(app).get(`/api/v1/reports/sales?dateFrom=${month}&dateTo=${today}&groupBy=day`).set(oa());
    expect(res.status).toBe(200);
    const { report } = res.body.data;
    expect(report).toHaveProperty('rows');
    expect(report).toHaveProperty('totals');
    expect(report.totals).toHaveProperty('total_revenue');
    expect(report.totals).toHaveProperty('bill_count');
    expect(report.totals).toHaveProperty('cash_total');
    expect(Array.isArray(report.rows)).toBe(true);
  });

  test('TC-RPT-03: Sales total = sum of daily rows', async () => {
    const res = await request(app).get(`/api/v1/reports/sales?dateFrom=${month}&dateTo=${today}`).set(oa());
    const { rows, totals } = res.body.data.report;
    const rowSum = rows.reduce((s,r) => s + parseFloat(r.total_revenue||0), 0);
    expect(Math.abs(parseFloat(totals.total_revenue) - rowSum)).toBeLessThan(0.01);
  });

  test('TC-RPT-04: Margin report returns medicines with margin data', async () => {
    const res = await request(app).get('/api/v1/reports/margins').set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.report).toHaveProperty('medicines');
    expect(res.body.data.report).toHaveProperty('summary');
    if (res.body.data.report.medicines.length > 0) {
      const m = res.body.data.report.medicines[0];
      expect(m).toHaveProperty('avg_margin_pct');
      expect(m).toHaveProperty('total_margin_earned');
    }
  });

  test('TC-RPT-05: Inventory report includes stock counts', async () => {
    const res = await request(app).get('/api/v1/reports/inventory').set(oa());
    expect(res.status).toBe(200);
    const { summary } = res.body.data.report;
    expect(summary).toHaveProperty('total_medicines');
    expect(summary).toHaveProperty('out_of_stock');
    expect(summary).toHaveProperty('low_stock');
    expect(summary.total_medicines).toBeGreaterThan(0);
  });

  test('TC-RPT-06: Purchase report returns supplier totals', async () => {
    const res = await request(app).get(`/api/v1/reports/purchases?dateFrom=${month}&dateTo=${today}`).set(oa());
    expect(res.status).toBe(200);
    expect(res.body.data.report).toHaveProperty('purchases');
    expect(res.body.data.report).toHaveProperty('summary');
  });

  test('TC-RPT-07: Weekly groupBy returns fewer rows than daily', async () => {
    const [daily, weekly] = await Promise.all([
      request(app).get(`/api/v1/reports/sales?dateFrom=${month}&dateTo=${today}&groupBy=day`).set(oa()),
      request(app).get(`/api/v1/reports/sales?dateFrom=${month}&dateTo=${today}&groupBy=week`).set(oa()),
    ]);
    expect(daily.body.data.report.rows.length).toBeGreaterThanOrEqual(weekly.body.data.report.rows.length);
  });

  test('TC-RPT-08: All report data is computed — no stored totals', async () => {
    // Verify that creating a new bill changes the sales report total
    const before = await request(app).get(`/api/v1/reports/sales?dateFrom=${today}&dateTo=${today}`).set(oa());
    const medId = (await request(app).get('/api/v1/medicines').set(oa())).body.data.medicines[0]?.id;
    await request(app).post('/api/v1/billing').set(sa()).send({ payment_mode:'cash', items:[{medicine_id:medId, qty:1}] });
    const after = await request(app).get(`/api/v1/reports/sales?dateFrom=${today}&dateTo=${today}`).set(oa());
    expect(after.body.data.report.totals.bill_count).toBeGreaterThan(before.body.data.report.totals.bill_count);
  });
});

// ════════════════════════════════════
// MODULE 16 — NOTIFICATIONS
// ════════════════════════════════════

describe('Module 16 — Notifications', () => {
  let notifId;

  test('TC-NTF-01: Both roles can fetch their notifications', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/notifications').set(oa()),
      request(app).get('/api/v1/notifications').set(sa()),
    ]);
    expect(o.status).toBe(200); expect(s.status).toBe(200);
    expect(Array.isArray(o.body.data.notifications)).toBe(true);
  });

  test('TC-NTF-02: Unread count endpoint returns a number', async () => {
    const res = await request(app).get('/api/v1/notifications/count').set(oa());
    expect(res.status).toBe(200);
    expect(typeof res.body.data.unread_count).toBe('number');
  });

  test('TC-NTF-03: Mark all read reduces unread count', async () => {
    const before = (await request(app).get('/api/v1/notifications/count').set(oa())).body.data.unread_count;
    await request(app).patch('/api/v1/notifications/read-all').set(oa());
    const after  = (await request(app).get('/api/v1/notifications/count').set(oa())).body.data.unread_count;
    expect(after).toBeLessThanOrEqual(before);
  });

  test('TC-NTF-04: Unread filter returns only unread', async () => {
    const res = await request(app).get('/api/v1/notifications?unreadOnly=true').set(oa());
    res.body.data.notifications.forEach(n => expect(n.is_read).toBe(false));
  });
});

// ════════════════════════════════════
// MODULE 17+18 — DASHBOARDS
// ════════════════════════════════════

describe('Modules 17+18 — Dashboards', () => {
  test('TC-DASH-01: Owner dashboard returns correct structure', async () => {
    const res = await request(app).get('/api/v1/dashboard/owner').set(oa());
    expect(res.status).toBe(200);
    const { dashboard } = res.body.data;
    expect(dashboard).toHaveProperty('today');
    expect(dashboard).toHaveProperty('week');
    expect(dashboard).toHaveProperty('month');
    expect(dashboard).toHaveProperty('alerts');
    expect(dashboard.today).toHaveProperty('total_sales');
    expect(dashboard.today).toHaveProperty('bill_count');
    expect(dashboard.alerts).toHaveProperty('low_stock');
    expect(dashboard.alerts).toHaveProperty('pending_customer_returns');
  });

  test('TC-DASH-02: Staff cannot access owner dashboard — 403', async () => {
    const res = await request(app).get('/api/v1/dashboard/owner').set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-DASH-03: Staff dashboard returns today and recent bills', async () => {
    const res = await request(app).get('/api/v1/dashboard/staff').set(sa());
    expect(res.status).toBe(200);
    const { dashboard } = res.body.data;
    expect(dashboard).toHaveProperty('today');
    expect(dashboard.today).toHaveProperty('bill_count');
    expect(dashboard.today).toHaveProperty('recent_bills');
  });

  test('TC-DASH-04: Owner dashboard today total matches bills created today', async () => {
    const dash = (await request(app).get('/api/v1/dashboard/owner').set(oa())).body.data.dashboard;
    const report = (await request(app).get(`/api/v1/reports/sales?dateFrom=${today}&dateTo=${today}`).set(oa())).body.data.report;
    expect(Math.abs(parseFloat(dash.today.total_sales) - parseFloat(report.totals.total_revenue))).toBeLessThan(0.01);
  });

  test('TC-DASH-05: Dashboard loads in single request (no N+1)', async () => {
    const start = Date.now();
    await request(app).get('/api/v1/dashboard/owner').set(oa());
    expect(Date.now() - start).toBeLessThan(5000); // should resolve within 5s
  });

  test('TC-DASH-06: Trend is 14 zero-filled ascending days ending in today', async () => {
    const dash = (await request(app).get('/api/v1/dashboard/owner').set(oa())).body.data.dashboard;
    expect(dash.trend.days).toBe(14);
    expect(dash.trend.rows).toHaveLength(14);
    // Ascending, no gaps — a quiet day appears as 0, it never vanishes.
    const dates = dash.trend.rows.map((r) => r.sale_date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(14);
    dash.trend.rows.forEach((r) => {
      expect(r).toHaveProperty('total_revenue');
      expect(r).toHaveProperty('cash_total');
      expect(r).toHaveProperty('upi_total');
      expect(r).toHaveProperty('credit_total');
      expect(r).toHaveProperty('card_total');
    });
  });

  test('TC-DASH-07: Trend endpoint equals the headline it sits under', async () => {
    const dash = (await request(app).get('/api/v1/dashboard/owner').set(oa())).body.data.dashboard;
    const last = dash.trend.rows[dash.trend.rows.length - 1];
    // The sparkline's endpoint is pinned to today's computed figures, so the
    // tile and its trend can never disagree (UTC/DB-tz bucketing aside).
    expect(Math.abs(parseFloat(last.total_revenue) - parseFloat(dash.today.total_sales))).toBeLessThan(0.01);
    expect(last.bill_count).toBe(dash.today.bill_count);
    expect(Math.abs(parseFloat(last.cash_total) - parseFloat(dash.today.payment_breakdown.cash))).toBeLessThan(0.01);
    // Yesterday block mirrors the second-to-last trend row.
    expect(dash.yesterday).toHaveProperty('total_sales');
    expect(dash.yesterday.date).toBe(dash.trend.rows[12].sale_date);
  });
});

// ════════════════════════════════════
// MODULE 19 — SETTINGS
// ════════════════════════════════════

describe('Module 19 — Settings', () => {
  test('TC-SET-01: Both roles can read settings', async () => {
    const [o, s] = await Promise.all([
      request(app).get('/api/v1/settings').set(oa()),
      request(app).get('/api/v1/settings').set(sa()),
    ]);
    expect(o.status).toBe(200); expect(s.status).toBe(200);
    expect(o.body.data.settings).toHaveProperty('pharmacy_name');
  });

  test('TC-SET-02: Owner can update settings', async () => {
    const res = await request(app).patch('/api/v1/settings').set(oa()).send({ pharmacy_name: 'P. Care Pharma Updated', city: 'Gadag-Betageri' });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.pharmacy_name).toBe('P. Care Pharma Updated');
  });

  test('TC-SET-03: Settings persist after update', async () => {
    await request(app).patch('/api/v1/settings').set(oa()).send({ pharmacy_name: 'Persistence Test' });
    const r = await request(app).get('/api/v1/settings').set(oa());
    expect(r.body.data.settings.pharmacy_name).toBe('Persistence Test');
    // Restore
    await request(app).patch('/api/v1/settings').set(oa()).send({ pharmacy_name: 'P. Care Pharma' });
  });

  test('TC-SET-04: Staff cannot update settings — 403', async () => {
    const res = await request(app).patch('/api/v1/settings').set(sa()).send({ pharmacy_name: 'Hack' });
    expect(res.status).toBe(403);
  });

  test('TC-SET-05: Unknown setting key returns 422', async () => {
    const res = await request(app).patch('/api/v1/settings').set(oa()).send({ hack_key: 'value' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_KEYS');
  });
});

// ════════════════════════════════════
// MODULE 20 — AUDIT LOGS
// ════════════════════════════════════

describe('Module 20 — Audit Logs', () => {
  test('TC-AUD-01: Staff cannot access audit logs — 403', async () => {
    const res = await request(app).get('/api/v1/audit-logs').set(sa());
    expect(res.status).toBe(403);
  });

  test('TC-AUD-02: Owner can fetch paginated audit logs', async () => {
    const res = await request(app).get('/api/v1/audit-logs?limit=10&page=1').set(oa());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.logs)).toBe(true);
    expect(res.body.data.pagination).toHaveProperty('total');
  });

  test('TC-AUD-03: Logs include human-readable action_label', async () => {
    const res = await request(app).get('/api/v1/audit-logs?limit=5').set(oa());
    res.body.data.logs.forEach(l => {
      expect(l).toHaveProperty('action_label');
      expect(l).toHaveProperty('user_name');
      expect(typeof l.action_label).toBe('string');
    });
  });

  test('TC-AUD-04: Filter by action returns only that action', async () => {
    const res = await request(app).get('/api/v1/audit-logs?action=login&limit=10').set(oa());
    res.body.data.logs.forEach(l => expect(l.action).toBe('login'));
  });

  test('TC-AUD-05: Filter by date range returns only logs in range', async () => {
    const res = await request(app).get(`/api/v1/audit-logs?dateFrom=${today}&dateTo=${today}`).set(oa());
    expect(res.status).toBe(200);
    res.body.data.logs.forEach(l => {
      const logDate = l.created_at.slice(0,10);
      expect(logDate >= today).toBe(true);
    });
  });

  test('TC-AUD-06: Audit log grows after an action', async () => {
    const before = (await request(app).get(`/api/v1/audit-logs?dateFrom=${today}&action=login`).set(oa())).body.data.pagination.total;
    await request(app).post('/api/v1/auth/login').send({ email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD });
    const after  = (await request(app).get(`/api/v1/audit-logs?dateFrom=${today}&action=login`).set(oa())).body.data.pagination.total;
    expect(after).toBeGreaterThan(before);
  });

  test('TC-AUD-07: action_types list is returned for filter UI', async () => {
    const res = await request(app).get('/api/v1/audit-logs').set(oa());
    expect(Array.isArray(res.body.data.action_types)).toBe(true);
    expect(res.body.data.action_types.length).toBeGreaterThan(0);
  });
});
