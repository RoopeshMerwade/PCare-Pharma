/**
 * env.js start-up checks. Pure, no network.
 *
 * Each case runs in a child process, because a fatal in env.js exits the
 * process — which, in-process, would take the test runner with it.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '../..');
const SUPABASE = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
};

/** Loads env.js with these variables; `undefined` removes one. */
function loadEnv(overrides, {
  cwd = BACKEND,
  script = "console.log(require('./src/config/env').frontendUrl)",
} = {}) {
  const env = { ...process.env, ...SUPABASE, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const result = spawnSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8' });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
}

describe('FRONTEND_URL in production', () => {
  test('refuses http — the refresh cookie is Secure and would never be stored', () => {
    const r = loadEnv({ NODE_ENV: 'production', FRONTEND_URL: 'http://pcare-pharma.com' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/must be an https:\/\/ address/);
  });

  test('refuses localhost even over https — reset emails would link to it', () => {
    const r = loadEnv({ NODE_ENV: 'production', FRONTEND_URL: 'https://localhost:3000' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/points at this machine/);
  });

  test('accepts the public https origin and strips a trailing slash', () => {
    const r = loadEnv({ NODE_ENV: 'production', FRONTEND_URL: 'https://pcare-pharma.com/' });
    expect(r.status).toBe(0);
    expect(r.out).toBe('https://pcare-pharma.com');
  });
});

test('development still runs against localhost', () => {
  const r = loadEnv({ NODE_ENV: 'development', FRONTEND_URL: 'http://localhost:3000' });
  expect(r.status).toBe(0);
  expect(r.out).toBe('http://localhost:3000');
});

test('refuses a FRONTEND_URL that is not a URL at all', () => {
  const r = loadEnv({ NODE_ENV: 'development', FRONTEND_URL: 'pcare-pharma.com' });
  expect(r.status).toBe(1);
  expect(r.err).toMatch(/FRONTEND_URL is not a valid URL/);
});

// Needs a real backend/.env to find, so it is skipped where there is none (CI).
const hasEnvFile = fs.existsSync(path.join(BACKEND, '.env'));
(hasEnvFile ? test : test.skip)('finds backend/.env from the repository root, where PM2 starts the API', () => {
  const r = loadEnv(
    {
      SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined, SUPABASE_ANON_KEY: undefined,
      FRONTEND_URL: undefined, NODE_ENV: 'development',
    },
    { cwd: path.resolve(BACKEND, '..'), script: "require('./backend/src/config/env'); console.log('loaded')" },
  );
  expect(r.status).toBe(0);
  expect(r.out).toBe('loaded');
});
