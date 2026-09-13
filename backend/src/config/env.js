// ── Centralized environment configuration.
// The ONLY place process.env is read (besides NODE_ENV checks in logger
// transport selection). Validates at require time and fails fast with a
// friendly message BEFORE any module tries to use a missing value.

const path = require('path');

// By absolute path, not dotenv's default of `<process.cwd()>/.env`. PM2 runs
// server.js from the repository root, where ecosystem.config.js lives, so the
// default looked for a .env that is not there and the API refused to boot with
// every required variable "missing". A variable already set in the environment
// still wins: dotenv never overwrites one.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'FRONTEND_URL'];
const VALID_ENVS = ['development', 'test', 'production'];

function fatal(msg) {
  // console, not logger — logger config depends on this module.
  console.error(`FATAL: ${msg}`);
  console.error('Copy backend/.env.example to backend/.env and fill in the values.');
  process.exit(1);
}

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) fatal(`Missing required environment variables: ${missing.join(', ')}`);

const nodeEnv = process.env.NODE_ENV || 'development';
if (!VALID_ENVS.includes(nodeEnv)) fatal(`NODE_ENV must be one of ${VALID_ENVS.join('/')}, got "${nodeEnv}"`);

try {
  new URL(process.env.SUPABASE_URL);
} catch {
  fatal('SUPABASE_URL is not a valid URL');
}

// FRONTEND_URL is the CORS origin AND the base of every password-reset link
// (auth.service.js, users.service.js). A trailing slash makes the origin never
// match a browser's Origin header and doubles the slash in the link, so it is
// stripped here rather than left for each caller to get right.
const frontendUrl = process.env.FRONTEND_URL.replace(/\/+$/, '');
let frontendHost = null;
let frontendProtocol = null;
try {
  ({ hostname: frontendHost, protocol: frontendProtocol } = new URL(frontendUrl));
} catch {
  fatal('FRONTEND_URL is not a valid URL');
}

// A development .env copied onto a server boots cleanly and is wrong in two
// ways nobody notices until a customer does: password-reset emails link to
// localhost, and without https the refresh cookie (Secure in production) is
// never stored, so every session ends at the first access-token expiry.
if (nodeEnv === 'production') {
  if (frontendProtocol !== 'https:') {
    fatal(`FRONTEND_URL must be an https:// address in production, got "${frontendUrl}"`);
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(frontendHost)) {
    fatal(`FRONTEND_URL points at this machine ("${frontendUrl}"). Set it to the public site address.`);
  }
}

const port = parseInt(process.env.PORT, 10) || 4000;

const intFromEnv = (key, fallback) => {
  const parsed = parseInt(process.env[key], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  port,
  appVersion: process.env.APP_VERSION || '1.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',
  frontendUrl,
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
  },

  // ── Module 23: supplier invoice reading.
  //
  // NOT in REQUIRED, on purpose. Every existing deployment, run-demo.sh's dummy
  // .env and the whole test suite predate this feature; making the key
  // mandatory would turn "invoice reading is not set up" into "the API will not
  // boot". The module reports 503 EXTRACTION_UNAVAILABLE instead, and the rest
  // of the app is unaffected.
  gemini: {
    enabled: Boolean(process.env.GEMINI_API_KEY),
    apiKey: process.env.GEMINI_API_KEY || null,
    // gemini-2.5-flash was retired by Google for new/existing callers as of
    // 2026 ("no longer available to new users" — a 404, not a quota error) in
    // favour of gemini-3.6-flash. Pin this explicitly rather than trust a
    // future default: a silent model swap changes extraction behaviour on an
    // audit trail that assumes a known model version.
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    // A 6-page invoice at high resolution is a slow read. The frontend holds a
    // progress state for this whole window, so it is a UX budget, not a guess.
    timeoutMs: intFromEnv('GEMINI_TIMEOUT_MS', 120_000),
    maxAttempts: intFromEnv('GEMINI_MAX_ATTEMPTS', 2),
    // gemini-3.6-flash spends part of this budget on its own reasoning
    // (thoughtSignature) before it writes the JSON answer — a low budget hits
    // MAX_TOKENS having produced no visible text at all, not a half-finished
    // array. A 40-line invoice plus that reasoning overhead is why this is
    // generous rather than sized to the JSON alone.
    maxOutputTokens: intFromEnv('GEMINI_MAX_OUTPUT_TOKENS', 32_768),
  },

  invoices: {
    bucket: process.env.SUPABASE_INVOICE_BUCKET || 'supplier-invoices',
    // Gemini's inline-data ceiling is 20MB for the whole request, and base64
    // inflates by a third — so the file itself has to stay comfortably under it.
    maxUploadBytes: intFromEnv('INVOICE_MAX_UPLOAD_MB', 12) * 1024 * 1024,
    signedUrlTtlSeconds: intFromEnv('INVOICE_SIGNED_URL_TTL', 900),
    // Each accepted upload is a paid Gemini call and a buffer of up to
    // maxUploadBytes held in memory for the whole read. See the upload guards
    // in supplier-invoices.routes.js for why there are two limits.
    uploadsPerHour: intFromEnv('INVOICE_UPLOADS_PER_HOUR', 10),
    maxConcurrentExtractions: intFromEnv('INVOICE_MAX_CONCURRENT_EXTRACTIONS', 1),
  },
};

module.exports = config;
