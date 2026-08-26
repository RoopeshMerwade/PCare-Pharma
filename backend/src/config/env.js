// ── Centralized environment configuration.
// The ONLY place process.env is read (besides NODE_ENV checks in logger
// transport selection). Validates at require time and fails fast with a
// friendly message BEFORE any module tries to use a missing value.

require('dotenv').config();

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
  frontendUrl: process.env.FRONTEND_URL,
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
  },
};

module.exports = config;
