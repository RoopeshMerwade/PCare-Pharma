// ── Express application construction — NO listening here.
// server.js binds the port; tests require this file directly so a running
// dev server never causes EADDRINUSE in the test process.

const config = require('./config/env'); // validates env, fails fast
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { requestContext } = require('./middleware/requestContext');
const { errorHandler } = require('./middleware/errorHandler');
const { supabase } = require('./config/supabase');

const authRoutes = require('./modules/auth/auth.routes');
const usersRoutes = require('./modules/users/users.routes');
const categoriesRoutes = require('./modules/categories/categories.routes');
const medicinesRoutes = require('./modules/medicines/medicines.routes');
const inventoryRoutes = require('./modules/inventory/inventory.routes');
const suppliersRoutes = require('./modules/suppliers/suppliers.routes');
const purchasesRoutes = require('./modules/purchases/purchases.routes');
const billingRoutes = require('./modules/billing/billing.routes');
const customersRoutes = require('./modules/customers/customers.routes');
const customerReturnsRoutes = require('./modules/customer-returns/customer-returns.routes');
const supplierReturnsRoutes = require('./modules/supplier-returns/supplier-returns.routes');
const expiryRoutes = require('./modules/expiry/expiry.routes');
const reportsRoutes = require('./modules/reports/reports.routes');
const notificationsRoutes = require('./modules/notifications/notifications.routes');
const dashboardRoutes = require('./modules/dashboard/dashboard.routes');
const settingsRoutes = require('./modules/settings/settings.routes');
const auditRoutes = require('./modules/audit-logs/audit-logs.routes');
const chronicCareRoutes = require('./modules/chronic-care/chronic-care.routes');
const supplierInvoicesRoutes = require('./modules/supplier-invoices/supplier-invoices.routes');
const attendanceRoutes = require('./modules/attendance/attendance.routes');
const stockRequisitionsRoutes = require('./modules/stock-requisitions/stock-requisitions.routes');

const app = express();

// ── Security headers
// helmet's defaults, widened for one origin. Module 23's review screen shows
// the original invoice in an <iframe> (PDF) or an <img>, from a short-lived
// signed Supabase Storage URL; the default policy (img-src 'self' data:, and
// frame-src falling back to default-src 'self') blocks both whenever this
// server serves the frontend itself. nginx.conf.template sends the same two
// allowances for the nginx-served deploy — keep them in step.
//
// upgrade-insecure-requests only in production. Over plain http it rewrites
// every asset URL to https, so a server tested by IP before its certificate
// exists loads a blank page.
const supabaseOrigin = new URL(config.supabase.url).origin;
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'img-src': ["'self'", 'data:', supabaseOrigin],
      'frame-src': ["'self'", supabaseOrigin],
      'upgrade-insecure-requests': config.isProduction ? [] : null,
    },
  },
}));
app.set('trust proxy', 1); // behind nginx

// ── CORS — locked to frontend origin
app.use(cors({
  origin: config.frontendUrl,
  credentials: true, // allow cookies
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // Module 30's exports name their own file in Content-Disposition. A response
  // header is invisible to fetch() cross-origin unless it is exposed, and nginx
  // serving the SPA same-origin is a deployment fact rather than a guarantee —
  // VITE_API_URL can point anywhere. Without this the download still works but
  // silently falls back to a client-guessed filename.
  exposedHeaders: ['Content-Disposition']
}));

// ── Body parsing
app.use(express.json({ limit: '10kb' })); // prevent large payload attacks
app.use(cookieParser());

// ── Request ID + one structured log line per request
app.use(requestContext);

// ── Global rate limiting.
// Budget must fit real SPA usage: one page load issues ~a dozen API calls and
// the whole pharmacy typically shares one shop IP, so the previous 100/15min
// throttled normal operation. 900/15min ≈ 1 req/sec sustained per IP — still
// a meaningful abuse ceiling, no longer a self-inflicted outage.
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 900,
  message: { error: 'RATE_LIMITED', message: 'Too many requests. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Login abuse ceiling for the whole premises.
//
// This is a BACKSTOP, not the brute-force control. The real one lives in
// auth.service.js and keys on `email:ip` — 5 failed attempts per account — which
// is the granularity that actually protects a password.
//
// This limiter can only ever key on IP, and the entire pharmacy shares one
// shop IP (same reason the global limiter above is 900, not 100). At max:5
// counting SUCCESSES it meant five logins per 15 minutes for the building:
// owner plus three staff arriving at opening, one mistyped password, and
// nobody can bill until the window rolls over. skipSuccessfulRequests means a
// normal shift change never spends any of this budget, and 40 leaves room for
// every account to fail a few times before this fires at all.
//
// Distinct message from the per-account limiter on purpose — both answer
// 429 RATE_LIMITED, and without it there is no way to tell in the field which
// of the two locked someone out.
app.use('/api/v1/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  skipSuccessfulRequests: true,
  message: { error: 'RATE_LIMITED', message: 'Too many failed sign-in attempts from this network. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Liveness (process is up) — used by Nginx + monitoring
app.get('/health', (req, res) => res.json({
  status: 'ok', version: config.appVersion, timestamp: new Date().toISOString()
}));

// ── Readiness (dependencies reachable) — used by deploy checks
app.get('/ready', async (req, res) => {
  try {
    const { error } = await supabase.from('pharmacy_settings').select('key', { head: true, count: 'exact' });
    if (error) throw new Error(error.message);
    return res.json({ status: 'ready' });
  } catch (e) {
    return res.status(503).json({ status: 'not_ready', reason: 'database unreachable' });
  }
});

// ── Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/categories', categoriesRoutes);
app.use('/api/v1/medicines', medicinesRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/suppliers', suppliersRoutes);
app.use('/api/v1/purchases', purchasesRoutes);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/customers', customersRoutes);
app.use('/api/v1/customer-returns', customerReturnsRoutes);
app.use('/api/v1/supplier-returns', supplierReturnsRoutes);
app.use('/api/v1/expiry', expiryRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/audit-logs', auditRoutes);
app.use('/api/v1/chronic-care', chronicCareRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/stock-requisitions', stockRequisitionsRoutes);
// Module 23 mounts AFTER the json parser but is unaffected by its 10kb cap:
// the upload is multipart/form-data, which express.json skips entirely and
// multer parses with its own (much larger) size limit.
app.use('/api/v1/supplier-invoices', supplierInvoicesRoutes);

// ── Serve the built frontend from this same origin (single-service deploy —
// e.g. one Render Web Service instead of a separate backend + static site).
//
// Gated on the build actually existing. backend/tests/*.test.js require this
// file directly with no frontend build present, and local development runs
// two separate processes (`cd backend && npm run dev`, `cd frontend && npm
// run dev` — Vite's own dev server on :3000, proxying /api to this one, per
// vite.config.js). Neither should gain static serving or an SPA fallback, or
// a missing index.html would 500 instead of the ordinary 404 JSON below.
//
// This is also why sameSite:'strict' on the refresh cookie (auth.controller.js)
// is safe: the whole app lives on ONE origin when deployed this way, so the
// cookie is never asked to cross a site boundary. Splitting the frontend onto
// a separate host later would break that and needs sameSite:'none' instead —
// a deliberate choice, not a default to fall into.
const FRONTEND_DIST = path.join(__dirname, '../../frontend/dist');
const FRONTEND_INDEX = path.join(FRONTEND_DIST, 'index.html');

if (fs.existsSync(FRONTEND_INDEX)) {
  app.use(express.static(FRONTEND_DIST));

  // SPA fallback: any GET that isn't under /api/* and didn't match a static
  // asset is a client-side route (e.g. /billing/new) — hand it index.html and
  // let React Router take it from there. /api/* deliberately falls through to
  // the 404 handler below instead, so a missing API route still answers JSON.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    return res.sendFile(FRONTEND_INDEX);
  });
}

// ── 404 handler
app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found.' }));

// ── Global error handler (must be last)
app.use(errorHandler);

module.exports = app;
