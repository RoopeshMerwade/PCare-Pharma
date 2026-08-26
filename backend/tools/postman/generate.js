#!/usr/bin/env node
// ── Postman collection generator.
//
// Routes are discovered by walking the live Express router, not by hand-listing
// them — so the collection cannot silently fall behind the code. Add a route,
// re-run, and it is in the collection. Descriptions and example bodies come
// from ./routes-meta.js.
//
//   npm run postman         regenerate the collection
//   npm run postman:check   fail (exit 1) if the committed file is stale or
//                           any route lacks metadata — use in CI / pre-deploy
//
// Anything the metadata file does not describe is still exported, flagged with
// a TODO description, and reported on stderr.

const fs = require('fs');
const path = require('path');

// The app validates env at require time; supply harmless placeholders so the
// generator runs on any machine without a real Supabase project.
process.env.SUPABASE_URL ||= 'https://generator.placeholder.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'placeholder-service-key';
process.env.SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
process.env.FRONTEND_URL ||= 'http://localhost:3000';
process.env.LOG_LEVEL ||= 'silent';

const app = require('../../src/app');
const META = require('./routes-meta');

const OUT_FILE = path.resolve(__dirname, '../../../docs/api/PCare-Pharma.postman_collection.json');
const CHECK = process.argv.includes('--check');

// ── Folder presentation: mount prefix → display name, in the order a person
// would actually work through the system.
const FOLDERS = [
  ['', 'Health'],
  ['auth', 'Auth'],
  ['users', 'Users'],
  ['categories', 'Categories'],
  ['medicines', 'Medicines'],
  ['inventory', 'Inventory'],
  ['suppliers', 'Suppliers'],
  ['purchases', 'Purchases'],
  ['billing', 'Billing'],
  ['customers', 'Customers'],
  ['customer-returns', 'Customer Returns'],
  ['supplier-returns', 'Supplier Returns'],
  ['expiry', 'Expiry'],
  ['reports', 'Reports'],
  ['notifications', 'Notifications'],
  ['dashboard', 'Dashboard'],
  ['settings', 'Settings'],
  ['audit-logs', 'Audit Logs'],
  ['chronic-care', 'Chronic Care'],
  ['attendance', 'Attendance'],
  ['supplier-invoices', 'Supplier Invoices'],
  ['stock-requisitions', 'Stock Requisitions'],
];

const FOLDER_BLURB = {
  Health: 'Unauthenticated probes. `/health` is liveness (process up); `/ready` is readiness (database reachable).',
  Auth: 'Login, token refresh and password reset. The browser never talks to Supabase directly — every hop goes through Express.',
  Users: 'Staff accounts. Passwords are never accepted over the API; accounts are created with an emailed setup link.',
  Categories: 'Medicine categories, including display ordering.',
  Medicines: 'The catalog. A medicine holds no stock of its own — stock lives in inventory batches.',
  Inventory: 'Batches and the append-only stock ledger. Stock is always `SUM(inventory_ledger.change_qty)`, never a stored column.',
  Suppliers: 'Supplier master with live outstanding balances.',
  Purchases: 'Purchase orders and goods receipt. Receiving is the transactional path that turns an order into stock.',
  Billing: 'Sales. FEFO allocation, chronic-adherence gate, atomic write. **Bills are immutable — there is no update or delete.**',
  Customers: 'Customer master and purchase history (linked by phone).',
  'Customer Returns': 'The only correction path for an immutable bill. Staff submit, owner approves, stock returns inward.',
  'Supplier Returns': 'Returning stock to a supplier and raising the debit note.',
  Expiry: 'Expiry tracking and write-offs. Owner-only throughout.',
  Reports: 'Owner reporting. Every figure is computed live from views — nothing derived is stored.',
  Notifications: 'In-app alerts.',
  Dashboard: 'Role-specific landing views.',
  Settings: 'Pharmacy profile and defaults. Owner-only writes against a key allow-list.',
  'Audit Logs': 'Owner-only trail of every privileged action.',
  'Chronic Care': 'Refill adherence monitoring. **This module never blocks a sale** — it warns, staff acknowledge, the sale proceeds.',
  Attendance: 'Staff check-in / check-out. Staff act on themselves; the owner may act on anyone. Absence is the absence of a row — the board left-joins it back in.',
  'Supplier Invoices': 'AI-assisted goods inward. Ingest writes nothing that is stock; `commit` (owner-only) is the single call that creates batches, ledger rows and a received purchase.',
  'Stock Requisitions': 'Staff ask for stock, the owner approves and downloads a per-vendor order. **Writes no stock** — approving creates no purchase order and no ledger row. `GET /vendor-prices` is a scoped criterion-A9 exception: it is the one place Staff see what a distributor charges.',
};

// ── Walk the Express router ──────────────────────────────────────────────

// Express 4 keeps the mount path only as a regexp; for the static prefixes we
// use ('/api/v1/billing') it reverses cleanly.
function prefixFromLayer(layer) {
  if (layer.path) return layer.path;
  const src = layer.regexp && layer.regexp.source;
  if (!src || src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

function collectRoutes() {
  const found = [];
  const root = app._router || app.router;

  const visit = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const p = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          found.push({ method: method.toUpperCase(), path: p || '/' });
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        visit(layer.handle.stack, prefix + prefixFromLayer(layer));
      }
    }
  };

  visit(root.stack, '');
  return found;
}

// ── Build Postman items ──────────────────────────────────────────────────

function folderFor(routePath) {
  if (!routePath.startsWith('/api/v1/')) return 'Health';
  const seg = routePath.slice('/api/v1/'.length).split('/')[0];
  const hit = FOLDERS.find(([prefix]) => prefix === seg);
  return hit ? hit[1] : seg;
}

// `/medicines/:id` → `/medicines/{{medicine_id}}` so ids captured by earlier
// requests flow into later ones and the collection is runnable end to end.
function substituteParams(routePath, pathVars = {}) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_, name) => `{{${pathVars[name] || name}}}`);
}

function buildUrl(routePath, meta) {
  const withVars = substituteParams(routePath, meta.pathVars);
  const segments = withVars.split('/').filter(Boolean);

  const query = Object.entries(meta.query || {}).map(([key, raw]) => {
    const [value, description] = Array.isArray(raw) ? raw : [raw, undefined];
    const item = { key, value: String(value) };
    if (description) item.description = description;
    // Empty-valued params are optional filters — present but off by default.
    if (value === '' || value === null) item.disabled = true;
    return item;
  });

  const raw = '{{base_url}}' + (segments.length ? '/' + segments.join('/') : '') +
    (query.length ? '?' + query.filter(q => !q.disabled).map(q => `${q.key}=${q.value}`).join('&') : '');

  const url = { raw, host: ['{{base_url}}'], path: segments };
  if (query.length) url.query = query;
  return url;
}

// Boilerplate endpoints (deactivate/reactivate/get-by-id) follow identical
// rules across every module. Stating those rules once here beats copying the
// same sentence into a dozen metadata entries.
function fallbackDescription(route) {
  const noun = (folderFor(route.path) || 'record').replace(/s$/, '').toLowerCase();
  if (/\/deactivate$/.test(route.path)) {
    return `Soft-disables the ${noun}. **Nothing is ever hard-deleted in this system** — the row and its history are retained, and \`/reactivate\` reverses this.`;
  }
  if (/\/reactivate$/.test(route.path)) {
    return `Restores a deactivated ${noun}.`;
  }
  if (route.method === 'GET' && /:[A-Za-z0-9_]+$/.test(route.path)) {
    return `Fetches a single ${noun} by id.`;
  }
  return '';
}

function buildItem(route, meta, missing) {
  const key = `${route.method} ${route.path}`;
  const isPublic = meta.auth === 'public';

  const description = [
    meta.description || fallbackDescription(route) ||
      (missing ? '> **TODO — undocumented.** Add an entry for `' + key + '` to `backend/tools/postman/routes-meta.js`.' : ''),
    meta.role === 'owner' ? '\n\n_Requires the **owner** role (403 `FORBIDDEN` for staff)._' : '',
    isPublic ? '\n\n_Public — no bearer token required._' : '',
  ].filter(Boolean).join('');

  const item = {
    name: meta.name || key,
    request: {
      method: route.method,
      header: [],
      url: buildUrl(route.path, meta),
      description,
    },
  };

  if (meta.body) {
    item.request.header.push({ key: 'Content-Type', value: 'application/json' });
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify(meta.body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }

  // Collection-level bearer auth is inherited; opt public endpoints out of it.
  if (isPublic) item.request.auth = { type: 'noauth' };

  if (meta.capture) {
    const parts = meta.capture.path.split('.');
    item.event = [{
      listen: 'test',
      script: {
        type: 'text/javascript',
        exec: [
          `// Saves ${meta.capture.var} for the requests that follow.`,
          'let v = null;',
          'try { v = pm.response.json(); } catch (e) { v = null; }',
          `for (const k of ${JSON.stringify(parts)}) { v = (v == null ? null : v[k]); }`,
          'if (pm.response.code < 400 && v) {',
          `  pm.collectionVariables.set(${JSON.stringify(meta.capture.var)}, v);`,
          `  console.log("saved ${meta.capture.var} =", v);`,
          '}',
        ],
      },
    }];
  }

  return item;
}

// ── Assemble ─────────────────────────────────────────────────────────────

const routes = collectRoutes();
const metaKeys = new Set(Object.keys(META));
const undocumented = [];

const byFolder = new Map();
for (const route of routes) {
  const key = `${route.method} ${route.path}`;
  const meta = META[key];
  if (!meta) undocumented.push(key);
  metaKeys.delete(key);

  const folder = folderFor(route.path);
  if (!byFolder.has(folder)) byFolder.set(folder, []);
  byFolder.get(folder).push(buildItem(route, meta || {}, !meta));
}

const orderedFolders = FOLDERS.map(([, name]) => name).filter(n => byFolder.has(n));
for (const name of byFolder.keys()) if (!orderedFolders.includes(name)) orderedFolders.push(name);

const collection = {
  info: {
    _postman_id: 'pcare-pharma-api-v1',
    name: 'P.Care Pharma API',
    description:
      '# P.Care Pharma — Backend API\n\n' +
      'Pharmacy management API. Node/Express over Supabase Postgres, organised as a modular monolith.\n\n' +
      '**Generated from the live Express router** by `backend/tools/postman/generate.js` — do not hand-edit this file; ' +
      'edit `backend/tools/postman/routes-meta.js` and re-run `npm run postman`.\n\n' +
      '## Getting started\n\n' +
      '1. Set the `owner_email` / `owner_password` collection variables (or override them in an environment).\n' +
      '2. Run **Auth → Login**. Its test script stores `access_token`; every other request inherits it.\n' +
      '3. Work down the folders — create requests save their new ids (`medicine_id`, `bill_id`, …) into collection ' +
      'variables, so the later requests in each folder resolve without copy-pasting UUIDs.\n\n' +
      '## Conventions\n\n' +
      '- Success: `{ "success": true, "message": "...", "data": { ... } }`\n' +
      '- Failure: `{ "error": "CODE", "message": "...", "details": [ ... ] }` — note the key is **`error`**, not `code`.\n' +
      '- Validation failures are `422` with `details` listing the offending fields.\n' +
      '- Access tokens last ~1 hour. On `401 TOKEN_INVALID`, run **Auth → Refresh** (it reads the httpOnly cookie).\n' +
      '- Rate limits: 900 requests / 15 min per IP overall; 5 / 15 min on login.\n\n' +
      '## Invariants worth knowing before you POST\n\n' +
      '- **Stock is never stored.** It is summed live from the append-only `inventory_ledger`; every change is a new row.\n' +
      '- **Bills are immutable.** No PATCH, no DELETE — corrections go through Customer Returns.\n' +
      '- **Nothing is hard-deleted.** Records deactivate and reactivate.\n' +
      '- **FEFO is automatic.** Staff never choose a batch.\n' +
      '- **Chronic-care warnings never block a sale.** A `409 ADHERENCE_ACK_REQUIRED` is a prompt to acknowledge and resend.\n\n' +
      '## Requires migration\n\n' +
      'Bill creation, purchase receiving and both return workflows call the atomic RPCs in ' +
      '`backend/src/db/schema-22-atomic-workflows.sql`. Until that migration is applied they return `500 MIGRATION_REQUIRED`.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] },
  event: [{
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: [
        '// Applies to every request in the collection.',
        'pm.test("no server error", () => pm.expect(pm.response.code).to.be.below(500));',
        'if (pm.response.code === 401) {',
        '  console.warn("401 — run Auth > Login (or Auth > Refresh) to renew access_token.");',
        '}',
      ],
    },
  }],
  variable: [
    { key: 'base_url', value: 'http://localhost:4000', type: 'string' },
    { key: 'owner_email', value: '', type: 'string' },
    { key: 'owner_password', value: '', type: 'string' },
    { key: 'access_token', value: '', type: 'string' },
    ...[
      'user_id', 'category_id', 'medicine_id', 'batch_id', 'supplier_id',
      'purchase_id', 'purchase_item_id', 'bill_id', 'customer_id',
      'customer_return_id', 'supplier_return_id', 'notification_id',
      'condition_id', 'patient_condition_id', 'schedule_id',
    ].map(key => ({ key, value: '', type: 'string' })),
    { key: 'expiry_urgency', value: 'critical', type: 'string' },
  ],
  item: orderedFolders.map(name => ({
    name,
    description: FOLDER_BLURB[name] || '',
    item: byFolder.get(name),
  })),
};

// ── Write / check ────────────────────────────────────────────────────────

const json = JSON.stringify(collection, null, 2) + '\n';
const total = routes.length;

if (undocumented.length) {
  console.error(`\n⚠ ${undocumented.length} route(s) have no metadata (exported with a TODO description):`);
  undocumented.forEach(k => console.error(`   ${k}`));
  console.error('  → describe them in backend/tools/postman/routes-meta.js\n');
}
if (metaKeys.size) {
  console.error(`⚠ ${metaKeys.size} metadata entr(ies) match no live route — stale after a rename?`);
  metaKeys.forEach(k => console.error(`   ${k}`));
  console.error('');
}

if (CHECK) {
  const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  const stale = current !== json;
  if (stale) console.error('✗ Collection is out of date — run `npm run postman` and commit the result.');
  if (stale || undocumented.length || metaKeys.size) process.exit(1);
  console.log(`✓ Collection up to date — ${total} requests, all documented.`);
} else {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, json);
  console.log(`✓ Wrote ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log(`  ${total} requests across ${orderedFolders.length} folders.`);
}
