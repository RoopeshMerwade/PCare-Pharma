// ── Module: Authentication
// ── Role: Service (business logic, no HTTP knowledge)

const { supabase, createAuthClient } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const attemptStore = require('../../utils/loginAttemptStore');

// Policy, unchanged: 5 failed attempts per email+IP, 15-minute lockout.
// Only the STORAGE moved — see utils/loginAttemptStore.js. It was a
// module-level Map, which counts per process: across PM2 workers or instances
// the real ceiling was 5 x N and a restart reset it to zero.
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function getRateLimitKey(email, ip) {
  return `${email}:${ip}`;
}

// The counter now lives outside this process, which means it can fail in ways a
// Map never could — a dropped connection, a pending migration, a driver shape
// nobody anticipated. None of those may take the till down, so every call is
// wrapped and every failure is fail-OPEN.
//
// Fail-open is safe here and fail-closed is not. Brute-force protection is
// layered: nginx's login zone, the 40-per-15-minutes IP backstop in app.js, and
// Supabase Auth itself all still stand if this counter goes blind. Whereas
// failing closed turns a transient database error into "nobody in the pharmacy
// can sign in" — the exact outage the old IP-keyed limiter already caused once.
//
// The `clear` path matters most: it runs AFTER a correct password, so an
// unhandled throw there would turn a *successful* login into a 500.
async function withStore(operation, fn, fallback) {
  try {
    const store = await attemptStore.getStore();
    return await fn(store);
  } catch (err) {
    logger.warn({ operation, reason: err.message }, 'Login-attempt store unavailable; failing open');
    return fallback;
  }
}

async function checkRateLimit(key) {
  const record = await withStore('read', (s) => s.read(key), null);
  if (!record || typeof record.count !== 'number') return;

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    const elapsed = (Date.now() - record.firstAttempt) / 1000 / 60;
    // A NaN window (a malformed row) must not become an infinite lockout.
    if (Number.isFinite(elapsed) && elapsed < LOCKOUT_MINUTES) {
      const remaining = Math.ceil(LOCKOUT_MINUTES - elapsed);
      // Thrown OUTSIDE withStore so a genuine 429 is never swallowed as a
      // store failure.
      throw new AppError(
        `Too many failed attempts. Try again in ${remaining} minute${remaining > 1 ? 's' : ''}.`,
        429, 'RATE_LIMITED'
      );
    }
    // Window rolled — the stores' own reads already treat an expired window as
    // absent, so this only fires on a store that does not.
    await withStore('clear', (s) => s.clear(key), undefined);
  }
}

async function recordFailedAttempt(key) {
  await withStore('increment', (s) => s.increment(key), undefined);
}

async function clearAttempts(key) {
  await withStore('clear', (s) => s.clear(key), undefined);
}

async function login({ email, password, ip, userAgent }) {
  const key = getRateLimitKey(email, ip);
  await checkRateLimit(key);

  // Supabase Auth — signInWithPassword.
  // Own client per request: signing in on the shared service-role client would
  // attach this user's token to it and break service_role on later queries.
  const { data, error } = await createAuthClient().auth.signInWithPassword({ email, password });

  if (error || !data?.user) {
    await recordFailedAttempt(key);
    await logAudit(null, 'login_failed', { email }, { ip, userAgent });
    throw new AppError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
  }

  // Fetch profile from public.users (service_role — bypasses RLS)
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('id, full_name, role, is_active, phone, avatar_url')
    .eq('id', data.user.id)
    .single();

  if (profileError || !profile) throw new AppError('User profile not found.', 404, 'PROFILE_NOT_FOUND');
  if (!profile.is_active) {
    await logAudit(profile.id, 'login_blocked_inactive', {}, { ip, userAgent });
    throw new AppError('Your account has been disabled. Contact the owner.', 403, 'ACCOUNT_DISABLED');
  }

  await clearAttempts(key);
  await logAudit(profile.id, 'login', {}, { ip, userAgent });
  logger.info({ userId: profile.id, role: profile.role, ip }, 'User logged in');

  return { user: profile, session: data.session };
}

async function logout(userId) {
  await createAuthClient().auth.signOut();
  await logAudit(userId, 'logout', {});
  logger.info({ userId }, 'User logged out');
}

async function refreshSession(refreshToken) {
  // Fresh anon client per call — refreshSession() stores the resulting session
  // on the instance, so doing this on the shared service-role client would
  // hijack it for every later query.
  const { data, error } = await createAuthClient().auth.refreshSession({ refresh_token: refreshToken });

  // Never log the token itself, only that a refresh was rejected.
  if (error || !data?.session) {
    logger.warn({ reason: error?.message }, 'Refresh token rejected');
    throw new AppError('Session expired. Please log in again.', 401, 'REFRESH_TOKEN_INVALID');
  }

  // The identity is returned alongside the token, and the frontend compares it
  // against the identity that tab believes it is. Without it, a tab left open
  // while somebody else signed in on the same browser refreshes against the
  // SHARED httpOnly cookie, receives a perfectly valid token belonging to the
  // other person, and silently keeps working as them — which is how a bill gets
  // recorded against the wrong name. See frontend/src/lib/api.js.
  return {
    session: data.session,
    userId: data.user?.id ?? data.session?.user?.id ?? null,
  };
}

async function forgotPassword(email) {
  // Fire and forget — never reveal if email exists, so the controller
  // responds immediately regardless of how this resolves.
  //
  // resetPasswordForEmail resolves with { data, error } rather than
  // rejecting on most Supabase-side failures (no SMTP provider configured,
  // the built-in sender's rate limit) — .catch() alone only ever sees a
  // thrown exception, never that resolved error, so this logged nothing on
  // the failure mode that actually happens. Checking both.
  createAuthClient().auth.resetPasswordForEmail(email, {
    redirectTo: `${config.frontendUrl}/reset-password`
  }).then(({ error }) => {
    if (error) logger.warn({ reason: error.message }, 'Password reset email failed to send');
  }).catch(e => logger.warn({ reason: e.message }, 'Password reset email failed silently'));
}

async function resetPassword(token, newPassword) {
  // The reset email link carries a recovery token. Verifying it establishes
  // a session on this throwaway client; updateUser then acts on that session.
  // (Previously updateUser was called on a fresh session-less client — it
  // could never succeed and the token argument was ignored entirely.)
  const client = createAuthClient();
  const { error: otpError } = await client.auth.verifyOtp({ type: 'recovery', token_hash: token });
  if (otpError) throw new AppError('Password reset failed. The link may have expired.', 400, 'RESET_FAILED');

  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw new AppError('Password reset failed. Please request a new link.', 400, 'RESET_FAILED');
}

async function getProfile(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, role, phone, avatar_url, is_active, created_at')
    .eq('id', userId)
    .single();
  if (error || !data) throw new AppError('Profile not found.', 404, 'PROFILE_NOT_FOUND');
  return data;
}

module.exports = { login, logout, refreshSession, forgotPassword, resetPassword, getProfile };
