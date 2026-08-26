// ── Module: Authentication
// ── Role: Controller (Express route handlers)
// ── Principle: Thin controller — validation in middleware, logic in service

const authService = require('./auth.service');
const config = require('../../config/env');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');
const { AppError } = require('../../utils/AppError');

const REFRESH_COOKIE = 'pcare_refresh';

// Shared by login and refresh. Kept in one place because a mismatch in path or
// sameSite between the two silently breaks rotation: the browser would store a
// second cookie instead of replacing the first, and the stale one may win.
// sameSite:'strict' is correct here — nginx serves the SPA and proxies /api on
// the same origin, so the cookie is never sent cross-site.
const refreshCookieOptions = () => ({
  httpOnly: true,                                    // not readable by JS (XSS protection)
  secure: config.isProduction,                       // HTTPS-only in production
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,                   // 7 days
  path: '/api/v1/auth',
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';

  const { user, session } = await authService.login({ email, password, ip, userAgent });

  // Refresh token goes to the httpOnly cookie ONLY — never into the JSON body.
  res.cookie(REFRESH_COOKIE, session.refresh_token, refreshCookieOptions());

  return ApiResponse.success(res, { user, session: { access_token: session.access_token, expires_in: session.expires_in } }, 'Login successful');
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.user.id);
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  return ApiResponse.success(res, null, 'Logged out successfully');
});

const refreshToken = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];

  // Missing and invalid are reported identically — the client treats both as
  // "session is over, log in again", and a distinct code would only leak
  // whether a cookie was present.
  if (!token) throw new AppError('Session expired. Please log in again.', 401, 'REFRESH_TOKEN_INVALID');

  let session;
  let userId;
  try {
    ({ session, userId } = await authService.refreshSession(token));
  } catch (err) {
    // The cookie is spent or bad — drop it so the browser stops replaying a
    // token that can never succeed.
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    throw err;
  }

  // Supabase rotates the refresh token on every use; the one we just consumed
  // is now dead. Persist the replacement or the NEXT refresh fails.
  if (session.refresh_token) {
    res.cookie(REFRESH_COOKIE, session.refresh_token, refreshCookieOptions());
  }

  return ApiResponse.success(res, {
    access_token: session.access_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    // WHOSE token this is. The refresh cookie is scoped to the origin, not to a
    // tab, so a browser where two people have signed in has exactly one — and a
    // tab that refreshes against it can receive a token for the other person.
    // Returning the identity is what lets the client notice instead of adopting
    // it silently. Additive: nothing that ignores this field is affected.
    user_id: userId,
  });
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  // Always return success even if email doesn't exist (prevents email enumeration)
  await authService.forgotPassword(email);
  return ApiResponse.success(res, null, 'If that email is registered, a reset link has been sent.');
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, new_password } = req.body;
  await authService.resetPassword(token, new_password);
  return ApiResponse.success(res, null, 'Password updated. Please log in.');
});

const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getProfile(req.user.id);
  return ApiResponse.success(res, { user });
});

module.exports = { login, logout, refreshToken, forgotPassword, resetPassword, getMe };
