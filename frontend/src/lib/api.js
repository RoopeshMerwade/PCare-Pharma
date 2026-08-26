// ── API client — single source for all HTTP calls
// Attaches the Bearer access token, and transparently refreshes it once when
// the backend reports the token has expired (401 TOKEN_INVALID), retrying the
// original request so the caller never sees the expiry.
//
// Refresh contract with the backend:
//   POST /auth/refresh  — reads the httpOnly `pcare_refresh` cookie,
//                         returns a new access_token, the owning user_id, and
//                         rotates the cookie.
// Errors follow errorHandler.js: { error: <CODE>, message, details? }
//
// ═══════════════════════════════════════════════════════════════════════════
// WHERE THE ACCESS TOKEN LIVES, AND WHY IT IS NOT IN localStorage
//
// The access JWT exists in ONE place: the module-level `session.t` below. It is
// never written to localStorage, sessionStorage, IndexedDB or a cookie this
// script can read. It dies with the page.
//
// It used to be persisted, and that made it readable by any script that reached
// this origin — one XSS, one bad dependency, one browser extension with host
// permissions, and a valid bearer token walks out. The refresh token was always
// safe from that (httpOnly), so the weakest credential was also the persisted
// one. Now nothing a script can read survives the page.
//
// WHAT REPLACES IT ON RELOAD
//
// `bootstrapSession()` — a POST to /auth/refresh. The browser attaches the
// httpOnly cookie itself, so a reload re-obtains a token without any stored
// credential. That is the same call the 401 interceptor already made; the only
// new thing is that it also runs once at startup. One extra round trip per page
// load buys a token that XSS cannot exfiltrate at rest.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE STILL KNOWS WHO YOU ARE
//
// This is a shared-terminal app: one counter PC, one owner, up to four staff.
// Credentials are per-ORIGIN, not per-tab — localStorage is shared by every tab,
// and there is exactly one `pcare_refresh` cookie for the whole browser. So a
// second person signing in silently re-points every already-open tab at their
// credentials, while those tabs carry on rendering the first person's name.
//
// That produced a real defect: a bill rung up by staff was recorded against the
// owner. `created_by` comes from the verified JWT and always did — the wrong
// token was sent, not the wrong field. And `bills.created_by` is the pharmacy's
// record of who dispensed what.
//
// The rule enforced here: LAST LOGIN OWNS THE BROWSER, every other tab freezes.
// Three independent layers, so no single miss can produce a write under the
// wrong name:
//
//   1. the stored IDENTITY (id + display name, never a token) is compared by a
//      `storage` listener in useAuth (see syncFromStorage);
//   2. `request()` refuses to send anything once a takeover is latched;
//   3. the refresh response carries `user_id`, compared before adoption —
//      without this a tab left open overnight refreshes against the shared
//      cookie, receives a valid token belonging to somebody else, and keeps
//      working as them with nothing anywhere flagging it.
//
// Identity is compared, never "did the token change". Tokens rotate constantly
// and legitimately — and now each tab holds its OWN token, so comparing tokens
// across tabs would be meaningless as well as wrong.
// ═══════════════════════════════════════════════════════════════════════════

const BASE = import.meta.env.VITE_API_URL || '/api/v1';

// Identity ONLY: { u: userId, n: fullName }. No token, ever.
// Still one key rather than two: a listener must never observe a torn state
// (new id, old name) and report a takeover that did not happen.
const SESSION_KEY = 'pcare_session';

// Pre-memory-token formats, read once at startup so they can be ERASED. Both
// held a bearer JWT: `pcare_session` as { t, u, n }, `pcare_token` as a bare
// string. Every browser that has used this app still has one of them sitting in
// localStorage right now, and an upgrade that merely stops writing tokens would
// leave those behind indefinitely.
const LEGACY_TOKEN_KEY = 'pcare_token';

// Cross-tab "a refresh just succeeded" marker: { at, u }. A timestamp and an
// id — deliberately not a token, and useless to anything that reads it.
// Supabase rotates the refresh cookie on every use, so when two tabs refresh at
// once the loser is told its token is invalid even though the session is alive.
// This is how the loser tells that apart from a session that really ended.
const REFRESH_SIGNAL_KEY = 'pcare_refresh_signal';

// How long to wait before deciding a rejected refresh was really a rejection
// and not a lost race with another tab. Only ever paid on the losing path.
const REFRESH_RACE_GRACE_MS = 300;

// Endpoints that must never trigger the startup refresh: they are the ones that
// establish or end a session, and a bootstrap in front of them would either
// recurse or fire a pointless 401 on the login screen.
const PUBLIC_AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/forgot-password', '/auth/reset-password'];

class ApiError extends Error {
  constructor(message, code, status, details) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}

// Distinguished from ApiError on purpose: a server we could not reach must not
// destroy a session that is probably still valid.
class NetworkError extends Error {
  constructor(message = 'Could not reach the server. Check your connection.') {
    super(message); this.code = 'NETWORK_ERROR'; this.status = 0;
  }
}

// A third distinguished type, for the same reason NetworkError exists: callers
// must be able to tell "we refused to send this" from "the server said no".
// Nothing was attempted, so nothing was recorded under the wrong name.
class SessionTakeoverError extends Error {
  constructor(message = 'Someone else signed in on this browser. This tab is locked.') {
    super(message); this.code = 'SESSION_TAKEOVER'; this.status = 0;
  }
}

// ── Session state ────────────────────────────────────────────
// `t` is the access token and is MEMORY-ONLY — it is never handed to
// writeStored(). `u`/`n` are the identity and are the only things persisted.
let session = null;      // { t, u, n } | null
let takenOver = false;   // one-way latch — see markTakenOver

function readStored() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.u != null || parsed.n != null)) {
        return { u: parsed.u ?? null, n: parsed.n ?? null };
      }
      return null;
    }
    return null;
  } catch {
    return null; // private mode / storage disabled — the memory copy governs
  }
}

/** Persist identity only. Any `t` on the object is dropped here, by construction. */
function writeStored(next) {
  try {
    if (next && (next.u != null || next.n != null)) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ u: next.u ?? null, n: next.n ?? null }));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch { /* private mode — this tab still works, it just won't persist */ }
}

/**
 * One-time cleanup of the pre-memory-token formats.
 *
 * Runs before anything else reads storage. The old `pcare_session` carried a
 * bearer JWT in `t`; the older `pcare_token` was that JWT bare. The identity is
 * kept (so an open shift is not signed out by the upgrade and takeover
 * detection keeps working); the TOKEN is discarded — this tab will get a fresh
 * one from the refresh cookie a moment later, exactly like any other reload.
 */
function purgeLegacyTokenStorage() {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.t === 'string') {
      // Rewrite without `t` rather than removing the key: dropping it entirely
      // would fire a `storage` event in sibling tabs that reads as a sign-out.
      localStorage.setItem(SESSION_KEY, JSON.stringify({ u: parsed.u ?? null, n: parsed.n ?? null }));
    }
  } catch { /* unparseable or unavailable — nothing to purge */ }
}

purgeLegacyTokenStorage();
session = readStored();

export const getToken = () => session?.t ?? null;
export const getUid = () => session?.u ?? null;
export const isTakenOver = () => takenOver;

/** Full replace — login, where token and identity arrive together. */
export function setSession({ token, userId = null, fullName = null }) {
  session = { t: token, u: userId, n: fullName };
  writeStored(session);   // identity only; `token` stays in memory
  signalRefreshed(userId);
}

/** Corrects an identity that disagrees with what /auth/me reports. */
export function setIdentity(userId, fullName = null) {
  if (!session) return;
  session = { ...session, u: userId, n: fullName ?? session.n };
  writeStored(session);
}

/** A real sign-out: this browser's session is over for everyone. */
export function clearSession() {
  session = null;
  bootstrapPromise = null;
  bootstrapDone = false;
  writeStored(null);
  try { localStorage.removeItem(REFRESH_SIGNAL_KEY); } catch { /* ignore */ }
}

/**
 * Give up this tab's session WITHOUT touching shared storage, and lift the
 * takeover latch so the tab can sign in again.
 *
 * The distinction from clearSession() is load-bearing. After a takeover the
 * shared credential belongs to whoever just signed in — clearing it from the
 * frozen tab would fire a removal event in THEIR tab and sign them out too, so
 * the losing tab would take down the session that displaced it.
 */
export function abandonSession() {
  session = null;
  takenOver = false;
  bootstrapPromise = null;
  bootstrapDone = false;
}

/** New token, same person — refresh. Memory only. Keeps the identity. */
function updateToken(token) {
  session = { u: null, n: null, ...(session || {}), t: token };
}

// ── Cross-tab refresh signalling ─────────────────────────────
// Carries no credential: just "someone on this origin successfully rotated the
// cookie at time T". Enough for a tab that lost the race to know its own retry
// will now be sent with the NEW cookie.

// Identifies THIS tab for the lifetime of the page. Without it a tab could read
// back its own signal and mistake it for a sibling's — the two writes can land
// in the same millisecond, so a timestamp alone cannot tell them apart.
const TAB_ID = Math.random().toString(36).slice(2);

function signalRefreshed(userId) {
  try {
    localStorage.setItem(
      REFRESH_SIGNAL_KEY,
      JSON.stringify({ at: Date.now(), u: userId ?? null, tab: TAB_ID })
    );
  } catch { /* ignore */ }
}

/** Did a DIFFERENT tab complete a refresh since `timestamp`? */
function refreshedElsewhereSince(timestamp) {
  try {
    const raw = localStorage.getItem(REFRESH_SIGNAL_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.tab !== TAB_ID && typeof parsed?.at === 'number' && parsed.at >= timestamp;
  } catch {
    return false;
  }
}

// ── Handlers registered by AuthProvider ──────────────────────
// Two, because they mean different things and need different copy: a failure
// is "your session ended", a takeover is "you are now someone else".
let onAuthFailure = null;
let onSessionTakeover = null;
export function setAuthFailureHandler(fn) { onAuthFailure = fn; }
export function setSessionTakeoverHandler(fn) { onSessionTakeover = fn; }

function markTakenOver(byName = null) {
  if (takenOver) return;
  takenOver = true;
  session = null; // memory only — shared storage is the new owner's now
  onSessionTakeover?.(byName);
}

function failSession() {
  clearSession();
  onAuthFailure?.();
}

/**
 * Reconcile this tab against shared storage. Called by AuthProvider on the
 * `storage` event, and again on focus/visibility because a backgrounded or
 * frozen tab can miss that event entirely.
 *
 * Compares IDENTITY. It no longer has a token to adopt — each tab holds its own
 * in memory — which is what the old `stored.u == null` branch existed to
 * tolerate. That branch is gone with the legacy format.
 *
 * Returns { status: 'synced' | 'ended' | 'taken_over' | 'none', byName? }.
 */
export function syncFromStorage() {
  if (takenOver) return { status: 'taken_over' };

  const stored = readStored();

  if (!stored) {
    // Signed out elsewhere, or storage cleared.
    if (session) { session = null; return { status: 'ended' }; }
    return { status: 'none' };
  }

  // Nothing to compare against yet — this tab has no identity of its own
  // (mid-bootstrap). Take the stored one; /auth/me confirms it a moment later.
  if (!session || session.u == null) {
    session = { ...(session || {}), u: stored.u, n: stored.n };
    return { status: 'synced' };
  }

  if (stored.u != null && stored.u !== session.u) {
    markTakenOver(stored.n);
    return { status: 'taken_over', byName: stored.n };
  }

  // Same person — the ordinary case of another tab having refreshed or renamed.
  session = { ...session, u: stored.u, n: stored.n };
  return { status: 'synced' };
}

// ── Single-flight refresh ────────────────────────────────────
// Shared promise so N requests failing at once trigger exactly ONE refresh.
let refreshPromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deliberately does NOT go through request(): the refresh call must never be
// able to re-enter the refresh path and recurse.
async function postRefresh() {
  try {
    return await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',            // sends the httpOnly refresh cookie
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    throw new NetworkError();            // transient — keep the session
  }
}

async function requestRefresh() {
  const startedAt = Date.now();

  const before = syncFromStorage();
  if (before.status === 'taken_over') throw new SessionTakeoverError();

  let res = await postRefresh();
  let data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Two tabs refreshed together and this one lost: the winner has already
    // rotated the shared cookie, so the token WE sent is spent — but the cookie
    // in the jar is now the new one, and simply asking again works. Without
    // this, a healthy two-tab session destroys itself the first time both tabs
    // wake at once.
    //
    // (When the token was persisted, the loser could just re-read the winner's
    // token from storage. There is no shared token any more, so the recovery is
    // to re-ask rather than to re-read.)
    await sleep(REFRESH_RACE_GRACE_MS);

    const after = syncFromStorage();
    if (after.status === 'taken_over') throw new SessionTakeoverError();

    if (refreshedElsewhereSince(startedAt)) {
      res = await postRefresh();
      data = await res.json().catch(() => ({}));
    }

    if (!res.ok) {
      throw new ApiError(data.message || 'Session expired. Please log in again.', data.error, res.status);
    }
  }

  const token = data.data?.access_token;
  if (!token) throw new ApiError('Malformed refresh response.', 'REFRESH_TOKEN_INVALID', 500);

  // The check that stops a forgotten tab quietly becoming somebody else. The
  // cookie we just spent is the browser's, not this tab's, so a valid token
  // coming back is NOT evidence it belongs to the person this tab is showing.
  const uid = data.data?.user_id ?? null;
  if (uid && session?.u && uid !== session.u) {
    markTakenOver(null);
    throw new SessionTakeoverError();
  }

  updateToken(token);
  // A tab that refreshed before /auth/me ran has no identity yet.
  if (uid && session && session.u == null) setIdentity(uid);
  signalRefreshed(uid ?? session?.u ?? null);
  return token;
}

function refreshAccessToken() {
  if (!refreshPromise) {
    // Assign before awaiting so concurrent callers observe the in-flight promise.
    refreshPromise = requestRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

// ── Startup: recover a token from the refresh cookie ──────────
// The access token no longer survives a reload, so every page load starts
// without one. This is the call that gets it back.
let bootstrapPromise = null;
let bootstrapDone = false;

/**
 * Obtain an access token from the httpOnly refresh cookie.
 *
 * Resolves to the token, or to `null` when there is no usable session (no
 * cookie, or an expired one) — a first-ever visitor is not an error. Rethrows
 * SessionTakeoverError and NetworkError, which mean something specific.
 *
 * Idempotent and single-flight: AuthProvider calls it on mount, and request()
 * awaits the same promise if a call somehow gets in first.
 */
export function bootstrapSession() {
  if (session?.t) return Promise.resolve(session.t);
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = refreshAccessToken()
    .catch((err) => {
      if (err instanceof SessionTakeoverError) throw err;
      if (err instanceof NetworkError) throw err;
      // 401 here is the ordinary "not signed in" case: no cookie, or it expired
      // while the tab was closed. Clear any stale identity so a takeover
      // comparison is never made against a session that no longer exists.
      session = null;
      writeStored(null);
      return null;
    })
    .finally(() => { bootstrapDone = true; bootstrapPromise = null; });

  return bootstrapPromise;
}

/** True once a bootstrap attempt has completed (successfully or not). */
export const isBootstrapped = () => bootstrapDone;

// ── Core request ─────────────────────────────────────────────
// `isRetry` is the loop guard: a request is retried at most once, so a retry
// that still 401s ends the session instead of refreshing again forever.
//
// `options.parse` selects how a SUCCESSFUL response is read: 'json' (every
// caller that existed before Module 30) or 'blob' (the export endpoints). It is
// destructured out rather than spread into fetch, and `options` itself is left
// untouched so the refresh retry below rebuilds the request identically.
//
// ERRORS ARE ALWAYS JSON, whatever `parse` says. A 403 from a download endpoint
// is { error: 'FORBIDDEN', message: '…' } like everything else — errorHandler
// emits that shape for every failure, including on a route whose happy path is
// a file. Routing it through res.blob() would turn a readable sentence into an
// unreadable Blob.
async function request(endpoint, options = {}, isRetry = false) {
  // Layer 2. The overlay in SessionTakeoverOverlay.jsx is what the user sees;
  // THIS is the guarantee. It holds in the render before React has caught up,
  // and it holds for callers that never look at auth state at all.
  if (takenOver) throw new SessionTakeoverError();

  const { parse = 'json', ...init } = options;

  const isPublicAuth = PUBLIC_AUTH_PATHS.some((p) => endpoint.startsWith(p));

  // A call that arrives before AuthProvider has finished bootstrapping would
  // otherwise be sent with no Authorization header and come back 401
  // TOKEN_MISSING — which is not TOKEN_INVALID, so the interceptor below would
  // not rescue it. Awaiting the same single-flight promise closes that window.
  if (!isPublicAuth && !getToken() && !bootstrapDone) {
    await bootstrapSession().catch(() => {});
    if (takenOver) throw new SessionTakeoverError();
  }

  const token = getToken();

  // A FormData body is passed through untouched, and — critically — WITHOUT a
  // Content-Type header. The browser has to set it itself so it can append the
  // multipart boundary; supplying `multipart/form-data` by hand omits the
  // boundary and the server parses zero fields.
  //
  // FormData is safe to reuse across the refresh retry below: fetch reads it
  // when it builds each request rather than consuming it like a stream.
  const isMultipart = typeof FormData !== 'undefined' && init.body instanceof FormData;

  let res;
  try {
    res = await fetch(`${BASE}${endpoint}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
      body: isMultipart ? init.body : (init.body ? JSON.stringify(init.body) : undefined),
    });
  } catch {
    throw new NetworkError();
  }

  if (res.ok) {
    if (parse === 'blob') return { blob: await res.blob(), headers: res.headers };
    return await res.json().catch(() => ({}));
  }

  const data = await res.json().catch(() => ({}));

  // Only an EXPIRED ACCESS TOKEN warrants a refresh. Business 401/403s
  // (INVALID_CREDENTIALS, ACCOUNT_SUSPENDED, FORBIDDEN…) must pass straight
  // through — refreshing on those would be wrong and would mask real errors.
  const tokenExpired = res.status === 401 && data.error === 'TOKEN_INVALID';

  if (tokenExpired && !isRetry) {
    try {
      await refreshAccessToken();
    } catch (err) {
      // Server unreachable — do NOT log the user out over a flaky network.
      if (err instanceof NetworkError) throw err;
      // A takeover already cleared this tab's session and raised the overlay.
      // Calling failSession() here would clear SHARED storage and sign out the
      // person who legitimately owns the browser now.
      if (err instanceof SessionTakeoverError) throw err;
      failSession();
      throw new ApiError('Session expired. Please log in again.', 'REFRESH_TOKEN_INVALID', 401);
    }
    // Retry once. `options` still holds the un-stringified body, so the
    // request is rebuilt cleanly with the new token.
    return request(endpoint, options, true);
  }

  // Refresh succeeded but the retry still 401s — the session is genuinely dead.
  if (tokenExpired && isRetry) failSession();

  // Deactivated mid-session. The token is valid, so no refresh will help and
  // nothing else will ever succeed either; end the session rather than leave
  // the user clicking through identical errors.
  if (res.status === 403 && data.error === 'ACCOUNT_SUSPENDED') failSession();

  throw new ApiError(data.message || 'Request failed', data.error, res.status, data.details);
}

/**
 * The filename the server chose, out of Content-Disposition (RFC 6266).
 *
 * Prefers `filename*=UTF-8''…` over the plain form when both are sent, because
 * only the starred form survives a non-ASCII character. Returns null when the
 * header is absent — which, cross-origin, it will be unless the API exposes it
 * (app.js sets exposedHeaders for exactly that reason).
 */
export function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { /* fall through to plain */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

export const api = {
  get:    (url, opts = {}) => request(url, { ...opts, method: 'GET' }),
  post:   (url, body, opts = {}) => request(url, { ...opts, method: 'POST', body }),
  put:    (url, body, opts = {}) => request(url, { ...opts, method: 'PUT', body }),
  patch:  (url, body, opts = {}) => request(url, { ...opts, method: 'PATCH', body }),
  delete: (url, opts = {}) => request(url, { ...opts, method: 'DELETE' }),

  /**
   * Multipart POST — supplier invoice upload is the only caller.
   *
   * Goes through `request()` rather than around it so an upload gets the same
   * token refresh, the same NetworkError/ApiError split and the same
   * single-flight guarantee as every other call. Building a bespoke fetch here
   * is how the one request that takes a minute becomes the one request that
   * silently logs the user out.
   *
   * `fields` are appended as form fields alongside the file.
   */
  upload: (url, file, fields = {}, opts = {}) => {
    const form = new FormData();
    form.append('file', file);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== null && value !== undefined && value !== '') form.append(key, value);
    }
    return request(url, { ...opts, method: 'POST', body: form });
  },

  /**
   * Fetch a file the API generates and hand it to the browser.
   *
   * Goes through request() for exactly the reason upload does, and the warning
   * above applies here word for word: a download must get the same token
   * refresh, the same takeover latch and the same NetworkError/ApiError split
   * as every other call, or the one request that takes a moment becomes the one
   * request that silently logs the user out.
   *
   * THE SERVER NAMES THE FILE. Content-Disposition carries the requisition
   * number that is also printed inside the document; a client-side guess would
   * drift from it the moment either side changed. `fallbackName` covers only
   * the case where the header is not readable.
   *
   * Returns the filename used, so a caller can name it in a toast.
   */
  download: async (url, fallbackName = 'download') => {
    const { blob, headers } = await request(url, { method: 'GET', parse: 'blob' });
    const name = filenameFromDisposition(headers.get('Content-Disposition')) || fallbackName;

    const href = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = href;
      link.download = name;
      link.rel = 'noopener';
      // Firefox will not follow a click on an anchor that is not in the document.
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      // Revoked on the next task, never in the same tick as the click: Safari
      // cancels an in-flight download when its object URL is revoked
      // synchronously, and the failure mode is a file that simply never appears.
      setTimeout(() => URL.revokeObjectURL(href), 0);
    }
    return name;
  },
};

export { ApiError, NetworkError, SessionTakeoverError, SESSION_KEY, REFRESH_SIGNAL_KEY };
