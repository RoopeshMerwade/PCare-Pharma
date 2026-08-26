/**
 * Access-token handling, refresh/retry behaviour, and session-identity enforcement.
 * Runner: Vitest.  Run: npm test
 *
 * `fetch` and `localStorage` are stubbed so the whole 401 -> refresh -> retry
 * cycle can be exercised in milliseconds instead of waiting an hour for a real
 * token to expire.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STORAGE CONTRACT — this is what changed, and it is the point of the suite
 *
 * The access JWT is MEMORY-ONLY. Nothing writes it to localStorage,
 * sessionStorage or a readable cookie, and a reload starts with no token at
 * all; `bootstrapSession()` recovers one from the httpOnly refresh cookie.
 *
 * localStorage holds `pcare_session` = { u, n } — a user id and a display name.
 * That is identity, not a credential: it is what the shared-terminal takeover
 * check compares, and on its own it grants nothing.
 *
 * The "no JWT is persisted" group below is a regression test, not a
 * demonstration. A future convenience — "just cache the token so reloads are
 * faster" — is exactly the change these assertions exist to fail.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const SESSION_KEY = 'pcare_session';
const SIGNAL_KEY = 'pcare_refresh_signal';
const LEGACY_KEY = 'pcare_token';
const ME = 'user-me';
const THEM = 'user-them';

// ── Response helpers matching the backend's real shapes ──────
const ok        = (data) => ({ ok: true,  status: 200, json: async () => ({ success: true, data }) });
const expired   = ()     => ({ ok: false, status: 401, json: async () => ({ error: 'TOKEN_INVALID',        message: 'Invalid or expired token.' }) });
const refreshOk = (t, u = ME) => ({ ok: true, status: 200, json: async () => ({ success: true, data: { access_token: t, expires_at: 1, user_id: u } }) });
const refreshNo = ()     => ({ ok: false, status: 401, json: async () => ({ error: 'REFRESH_TOKEN_INVALID', message: 'Session expired.' }) });
const forbidden = ()     => ({ ok: false, status: 403, json: async () => ({ error: 'FORBIDDEN',            message: 'Not allowed.' }) });
const suspended = ()     => ({ ok: false, status: 403, json: async () => ({ error: 'ACCOUNT_SUSPENDED',    message: 'Account suspended.' }) });

const isRefreshCall = (url) => String(url).endsWith('/auth/refresh');

/** Everything localStorage currently holds, as one string — for leak scanning. */
const allStorage = () => JSON.stringify(rawStore ? Object.fromEntries(rawStore) : {});

/** Simulate another tab having stored an identity (never a token). */
const storeIdentity = (u, n) => localStorage.setItem(SESSION_KEY, JSON.stringify({ u, n }));

/** Simulate another tab having just won a refresh race. */
const signalOtherTabRefreshed = () =>
  localStorage.setItem(SIGNAL_KEY, JSON.stringify({ at: Date.now(), u: ME, tab: 'some-other-tab' }));

let mod;
let rawStore;

/** Put a live session in memory the way login does. */
const signIn = (m, token, u = ME, n = 'Me') => m.setSession({ token, userId: u, fullName: n });

beforeEach(async () => {
  rawStore = new Map();
  vi.stubGlobal('localStorage', {
    getItem:    (k) => (rawStore.has(k) ? rawStore.get(k) : null),
    setItem:    (k, v) => rawStore.set(k, String(v)),
    removeItem: (k) => rawStore.delete(k),
  });

  // Fresh module instance per test so the module-level refresh lock, the
  // session copy, the bootstrap latch and the takeover latch all reset.
  vi.resetModules();
  mod = await import('./api.js');
  signIn(mod, 'stale-token');
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE STORAGE GUARANTEE
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the access token is never persisted', () => {
  test('signing in puts the token in memory and only the identity in storage', () => {
    expect(mod.getToken()).toBe('stale-token');

    expect(allStorage()).not.toContain('stale-token');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual({ u: ME, n: 'Me' });
    // Explicitly: no `t` field survives, under any key.
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).t).toBeUndefined();
  });

  test('a refreshed token is not written to storage either', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      isRefreshCall(url) ? refreshOk('fresh-token') : (mod.getToken() === 'fresh-token' ? ok({}) : expired())
    ));

    await mod.api.get('/dashboard');

    expect(mod.getToken()).toBe('fresh-token');
    expect(allStorage()).not.toContain('fresh-token');
  });

  test('the cross-tab refresh signal carries no credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      isRefreshCall(url) ? refreshOk('secret-token') : (mod.getToken() === 'secret-token' ? ok({}) : expired())
    ));

    await mod.api.get('/dashboard');

    const signal = JSON.parse(localStorage.getItem(SIGNAL_KEY));
    expect(signal).toMatchObject({ u: ME });
    expect(Object.values(signal)).not.toContain('secret-token');
  });

  test('no storage key holds anything JWT-shaped after a full session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      isRefreshCall(url)
        ? refreshOk('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig')
        : (mod.getToken()?.startsWith('eyJ') ? ok({}) : expired())
    ));

    await mod.api.get('/dashboard');

    // The three-segment dotted shape of a JWT, wherever it might have landed.
    expect(allStorage()).not.toMatch(/eyJ[\w-]*\.[\w-]+\.[\w-]+/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   RELOAD: recovering a token from the httpOnly cookie
   ═══════════════════════════════════════════════════════════════════════════ */

describe('bootstrap after a page reload', () => {
  test('a reload with no token in memory recovers one from the refresh cookie', async () => {
    // Exactly what a reload looks like: identity survives in storage, the token
    // does not, because it never left memory.
    storeIdentity(ME, 'Me');
    vi.resetModules();
    const fresh = await import('./api.js');

    expect(fresh.getToken()).toBeNull();

    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url: String(url), credentials: opts.credentials });
      return isRefreshCall(url) ? refreshOk('recovered-token') : ok({ user: { id: ME } });
    }));

    const token = await fresh.bootstrapSession();

    expect(token).toBe('recovered-token');
    expect(fresh.getToken()).toBe('recovered-token');
    // The cookie is what authenticates the call, so it must be sent.
    expect(calls[0]).toMatchObject({ url: '/api/v1/auth/refresh', credentials: 'include' });
  });

  test('a request made before bootstrap finishes still carries a token', async () => {
    storeIdentity(ME, 'Me');
    vi.resetModules();
    const fresh = await import('./api.js');

    vi.stubGlobal('fetch', vi.fn(async (url) =>
      isRefreshCall(url) ? refreshOk('recovered-token') : ok({ fine: true })
    ));

    // No explicit bootstrap: request() must do it rather than send a bare
    // request that comes back 401 TOKEN_MISSING, which does NOT trigger refresh.
    const res = await fresh.api.get('/dashboard');

    expect(res.data).toEqual({ fine: true });
    const dataCall = globalThis.fetch.mock.calls.find(([u]) => !isRefreshCall(u));
    expect(dataCall[1].headers.Authorization).toBe('Bearer recovered-token');
  });

  test('no cookie is the ordinary signed-out case, not an error', async () => {
    vi.resetModules();
    const fresh = await import('./api.js');
    const onFailure = vi.fn();
    fresh.setAuthFailureHandler(onFailure);

    vi.stubGlobal('fetch', vi.fn(async () => refreshNo()));

    await expect(fresh.bootstrapSession()).resolves.toBeNull();
    expect(fresh.getToken()).toBeNull();
    // A first-time visitor is not a session that "ended".
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('bootstrap is single-flight — five callers, one refresh', async () => {
    storeIdentity(ME, 'Me');
    vi.resetModules();
    const fresh = await import('./api.js');

    let refreshCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (isRefreshCall(url)) {
        refreshCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return refreshOk('recovered-token');
      }
      return ok({ fine: true });
    }));

    await Promise.all([
      fresh.api.get('/a'), fresh.api.get('/b'), fresh.api.get('/c'),
      fresh.api.get('/d'), fresh.api.get('/e'),
    ]);

    // The refresh cookie is single-use; five bootstraps would spend it five times.
    expect(refreshCount).toBe(1);
  });

  test('the login call itself is never preceded by a bootstrap refresh', async () => {
    vi.resetModules();
    const fresh = await import('./api.js');

    vi.stubGlobal('fetch', vi.fn(async () => ok({ user: { id: ME }, session: { access_token: 'x' } })));

    await fresh.api.post('/auth/login', { email: 'a@b.c', password: 'x' });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(String(globalThis.fetch.mock.calls[0][0])).toBe('/api/v1/auth/login');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SILENT REFRESH — unchanged behaviour, preserved
   ═══════════════════════════════════════════════════════════════════════════ */

describe('silent refresh on an expired access token', () => {
  test('401 TOKEN_INVALID triggers a refresh and the original request is retried', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (isRefreshCall(url)) return refreshOk('fresh-token');
      return calls.filter((c) => c.endsWith('/billing')).length === 1 ? expired() : ok({ bill: 'created' });
    }));

    const res = await mod.api.post('/billing', { total: 100 });

    // Caller sees success — never an expiry error.
    expect(res.data).toEqual({ bill: 'created' });
    expect(calls).toEqual(['/api/v1/billing', '/api/v1/auth/refresh', '/api/v1/billing']);
    expect(mod.getToken()).toBe('fresh-token');
    expect(globalThis.fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer fresh-token');
  });

  test('a refresh keeps the identity attached to the session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      isRefreshCall(url) ? refreshOk('fresh-token') : (mod.getToken() === 'fresh-token' ? ok({}) : expired())
    ));

    await mod.api.get('/dashboard');

    expect(mod.getUid()).toBe(ME);
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).u).toBe(ME);
  });

  test('five concurrent 401s cause exactly ONE refresh, and all five retry', async () => {
    let refreshCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (isRefreshCall(url)) {
        refreshCount += 1;
        await new Promise((r) => setTimeout(r, 10)); // keep the flight open
        return refreshOk('fresh-token');
      }
      return opts.headers.Authorization === 'Bearer fresh-token' ? ok({ url: String(url) }) : expired();
    }));

    const results = await Promise.all([
      mod.api.get('/dashboard'), mod.api.get('/inventory'), mod.api.get('/sales'),
      mod.api.get('/profile'), mod.api.get('/reports'),
    ]);

    expect(refreshCount).toBe(1);              // the single-flight lock
    expect(results).toHaveLength(5);
    results.forEach((r) => expect(r.data.url).toBeDefined());
  });

  test('a fresh 401 after the lock has cleared refreshes again', async () => {
    let refreshCount = 0;
    let serverToken = 'v1';
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (isRefreshCall(url)) { refreshCount += 1; serverToken = `v${refreshCount + 1}`; return refreshOk(serverToken); }
      return opts.headers.Authorization === `Bearer ${serverToken}` ? ok({}) : expired();
    }));

    await mod.api.get('/a');
    serverToken = 'v9';   // the server moves on underneath us
    await mod.api.get('/b');

    expect(refreshCount).toBe(2); // lock is per-flight, not permanent
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SESSION TERMINATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe('session termination', () => {
  test('failed refresh clears the session and notifies the auth layer once', async () => {
    const onFailure = vi.fn();
    mod.setAuthFailureHandler(onFailure);

    vi.stubGlobal('fetch', vi.fn(async (url) => (isRefreshCall(url) ? refreshNo() : expired())));

    await expect(mod.api.get('/billing')).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });

    expect(mod.getToken()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('a retry that still 401s ends the session instead of looping forever', async () => {
    const onFailure = vi.fn();
    mod.setAuthFailureHandler(onFailure);

    let refreshCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (isRefreshCall(url)) { refreshCount += 1; return refreshOk('still-rejected'); }
      return expired();
    }));

    await expect(mod.api.get('/billing')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });

    expect(refreshCount).toBe(1);                       // refreshed once, not repeatedly
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);  // request, refresh, retry — then stop
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('a mid-session deactivation ends the session rather than looping on 403s', async () => {
    const onFailure = vi.fn();
    mod.setAuthFailureHandler(onFailure);
    vi.stubGlobal('fetch', vi.fn(async () => suspended()));

    await expect(mod.api.get('/billing')).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mod.getToken()).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('logout drops the in-memory token and the stored identity', () => {
    expect(mod.getToken()).toBe('stale-token');
    mod.clearSession();

    expect(mod.getToken()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(SIGNAL_KEY)).toBeNull();
    // The httpOnly cookie is the server's to clear — POST /auth/logout does it.
  });

  test('after logout a request carries no Authorization header', async () => {
    mod.clearSession();
    vi.stubGlobal('fetch', vi.fn(async (url) => (isRefreshCall(url) ? refreshNo() : ok({}))));

    await mod.api.get('/dashboard').catch(() => {});

    const dataCall = globalThis.fetch.mock.calls.find(([u]) => !isRefreshCall(u));
    expect(dataCall?.[1].headers.Authorization).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT MUST NOT TRIGGER A REFRESH
   ═══════════════════════════════════════════════════════════════════════════ */

describe('what must NOT trigger a refresh', () => {
  test('a 403 business error passes straight through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => forbidden()));

    await expect(mod.api.get('/reports')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no refresh attempted
    expect(mod.getToken()).toBe('stale-token');
  });

  test('a network failure during refresh preserves the session', async () => {
    const onFailure = vi.fn();
    mod.setAuthFailureHandler(onFailure);

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (isRefreshCall(url)) throw new TypeError('Failed to fetch'); // server unreachable
      return expired();
    }));

    await expect(mod.api.get('/billing')).rejects.toBeInstanceOf(mod.NetworkError);

    // A flaky network must not cost the user their session mid-bill.
    expect(mod.getToken()).toBe('stale-token');
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Shared-browser identity. Credentials are per-origin, not per-tab, so a
   second person signing in re-points this tab at their session. These are the
   cases that produced a bill recorded against the wrong person.
   ═══════════════════════════════════════════════════════════════════════════ */

describe('session takeover', () => {
  test('a refresh that returns SOMEONE ELSE freezes the tab instead of adopting it', async () => {
    // The long-lived-tab case: left open overnight, token expires, and the
    // shared cookie now belongs to whoever logged in last. A valid token comes
    // back — it is simply not ours.
    const onTakeover = vi.fn();
    const onFailure = vi.fn();
    mod.setSessionTakeoverHandler(onTakeover);
    mod.setAuthFailureHandler(onFailure);

    vi.stubGlobal('fetch', vi.fn(async (url) =>
      (isRefreshCall(url) ? refreshOk('their-token', THEM) : expired())
    ));

    await expect(mod.api.get('/billing')).rejects.toBeInstanceOf(mod.SessionTakeoverError);

    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(mod.isTakenOver()).toBe(true);
    // Their token must NOT be adopted, and their session must NOT be destroyed:
    // shared storage belongs to them now.
    expect(mod.getToken()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('once frozen, no request is even attempted', async () => {
    mod.setSessionTakeoverHandler(vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      (isRefreshCall(url) ? refreshOk('their-token', THEM) : expired())
    ));
    await expect(mod.api.get('/billing')).rejects.toBeInstanceOf(mod.SessionTakeoverError);

    globalThis.fetch.mockClear();
    // This is the guarantee — not the overlay, which is only what explains it.
    await expect(mod.api.post('/billing', { total: 500 })).rejects.toBeInstanceOf(mod.SessionTakeoverError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('syncFromStorage reports a takeover when another tab stores a different identity', () => {
    const onTakeover = vi.fn();
    mod.setSessionTakeoverHandler(onTakeover);

    storeIdentity(THEM, 'Vijay');
    const result = mod.syncFromStorage();

    expect(result).toMatchObject({ status: 'taken_over', byName: 'Vijay' });
    expect(onTakeover).toHaveBeenCalledWith('Vijay');
  });

  test('the SAME user in another tab is not a takeover', () => {
    // Two tabs of one session (billing + inventory) is normal and must keep
    // working. Identity is compared — and each tab now holds its OWN token, so
    // comparing tokens across tabs would be meaningless as well as wrong.
    const onTakeover = vi.fn();
    mod.setSessionTakeoverHandler(onTakeover);

    storeIdentity(ME, 'Me');
    const result = mod.syncFromStorage();

    expect(result.status).toBe('synced');
    expect(onTakeover).not.toHaveBeenCalled();
    expect(mod.getToken()).toBe('stale-token'); // this tab's own token is untouched
  });

  test('a sign-out in another tab ends this one', () => {
    localStorage.removeItem(SESSION_KEY);
    expect(mod.syncFromStorage()).toMatchObject({ status: 'ended' });
  });

  test('abandonSession drops this tab without signing the other person out', () => {
    mod.setSessionTakeoverHandler(vi.fn());
    storeIdentity(THEM, 'Vijay');
    mod.syncFromStorage();
    expect(mod.isTakenOver()).toBe(true);

    mod.abandonSession();

    // Shared storage untouched: clearing it would fire a removal event in the
    // new owner's tab and sign THEM out — the displaced tab taking down the
    // session that displaced it.
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).u).toBe(THEM);
    expect(mod.getToken()).toBeNull();
    // The latch lifts so this tab can sign in again.
    expect(mod.isTakenOver()).toBe(false);
  });

  test('a real sign-out does clear shared storage', () => {
    mod.clearSession();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CROSS-TAB REFRESH RACE
   Supabase rotates the refresh cookie on every use, so when two tabs of the
   SAME session refresh together the loser is told its token is invalid even
   though the session is alive. With the token no longer shared through
   storage, the loser cannot read the winner's token — it re-asks instead, and
   the browser sends the newly rotated cookie.
   ═══════════════════════════════════════════════════════════════════════════ */

describe('cross-tab refresh race', () => {
  test('losing the race retries against the rotated cookie instead of ending the session', async () => {
    const onFailure = vi.fn();
    mod.setAuthFailureHandler(onFailure);

    let refreshAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (isRefreshCall(url)) {
        refreshAttempts += 1;
        if (refreshAttempts === 1) {
          // Another tab won while ours was in flight and rotated the cookie.
          signalOtherTabRefreshed();
          return refreshNo();
        }
        return refreshOk('token-from-rotated-cookie');
      }
      return opts.headers.Authorization === 'Bearer token-from-rotated-cookie'
        ? ok({ fine: true })
        : expired();
    }));

    const res = await mod.api.get('/dashboard');

    expect(res.data).toEqual({ fine: true });
    expect(refreshAttempts).toBe(2);
    expect(onFailure).not.toHaveBeenCalled();
    expect(mod.getToken()).toBe('token-from-rotated-cookie');
  });

  test('a genuinely expired session is NOT retried — it ends', async () => {
    // No sibling signal, so there is no evidence of a race and no reason to
    // spend a second attempt. This is what stops the retry masking a real expiry.
    const onFailure = vi.fn();
    mod.setAuthFailureHandler(onFailure);

    let refreshAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (isRefreshCall(url)) { refreshAttempts += 1; return refreshNo(); }
      return expired();
    }));

    await expect(mod.api.get('/dashboard')).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });

    expect(refreshAttempts).toBe(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test("this tab's own refresh signal is not mistaken for a sibling's", async () => {
    // The two writes can land in the same millisecond, which is why the signal
    // carries a tab id and not just a timestamp.
    let refreshAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (isRefreshCall(url)) { refreshAttempts += 1; return refreshNo(); }
      return expired();
    }));

    await expect(mod.api.get('/dashboard')).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });

    // signIn() in beforeEach wrote a signal from THIS tab. It must not count.
    expect(refreshAttempts).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   UPGRADE FROM THE PERSISTED-TOKEN FORMAT
   ═══════════════════════════════════════════════════════════════════════════ */

describe('legacy storage is actively purged, not just ignored', () => {
  test('a JWT left in the old pcare_session shape is erased on load', async () => {
    // Every browser that has used the app still has one of these. Ceasing to
    // WRITE tokens would leave them sitting there indefinitely, so the upgrade
    // has to take them out.
    localStorage.setItem(SESSION_KEY, JSON.stringify({ t: 'old-jwt', u: ME, n: 'Me' }));
    vi.resetModules();
    const fresh = await import('./api.js');

    expect(allStorage()).not.toContain('old-jwt');
    expect(fresh.getToken()).toBeNull();          // not adopted into memory either
    // The identity survives, so the shift is not signed out and takeover
    // detection keeps working; the token comes back from the cookie.
    expect(fresh.getUid()).toBe(ME);
  });

  test('the older bare-token key is removed entirely', async () => {
    localStorage.setItem(LEGACY_KEY, 'legacy-jwt');
    vi.resetModules();
    const fresh = await import('./api.js');

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(allStorage()).not.toContain('legacy-jwt');
    expect(fresh.getToken()).toBeNull();
  });

  test('the purge keeps the key present so siblings do not read it as a sign-out', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ t: 'old-jwt', u: ME, n: 'Me' }));
    vi.resetModules();
    await import('./api.js');

    // Removing the key would fire a `storage` event that syncFromStorage reads
    // as 'ended' in every other tab.
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual({ u: ME, n: 'Me' });
  });
});

describe('storage resilience', () => {
  test('a throwing localStorage (private mode) does not break the client', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    vi.resetModules();
    const fresh = await import('./api.js');

    vi.stubGlobal('fetch', vi.fn(async () => ok({ fine: true })));
    fresh.setSession({ token: 'in-memory-only', userId: ME, fullName: 'Me' });

    // The in-memory copy governs this tab; only persistence is lost.
    expect(fresh.getToken()).toBe('in-memory-only');
    const res = await fresh.api.get('/dashboard');
    expect(res.data).toEqual({ fine: true });
    expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer in-memory-only');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   DOWNLOADS (Module 30)

   api.download goes THROUGH request() rather than around it, so a download has
   to inherit the refresh, the retry and the error split exactly. These assert
   that it does — and, just as importantly, that an ERROR on a download endpoint
   is still parsed as JSON. A 403 there is { error, message } like everywhere
   else; reading it as a Blob would turn a readable sentence into a binary blob
   the user is shown as "[object Blob]".
   ═══════════════════════════════════════════════════════════════════════════ */

const fileOk = (body, disposition) => ({
  ok: true,
  status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'content-disposition' ? disposition : null) },
  blob: async () => ({ size: body.length, type: 'application/pdf' }),
  json: async () => { throw new Error('a blob response must not be read as JSON'); },
});

describe('api.download', () => {
  // These tests print "Not implemented: navigation" to stderr. That is jsdom
  // declining to actually follow the anchor click, and it is evidence the click
  // fired rather than a failure. Stubbing document.createElement to silence it
  // would remove the only assertion that the anchor path runs at all.
  beforeEach(() => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: vi.fn() });
  });

  test('takes the filename from Content-Disposition', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      fileOk('PDF', 'attachment; filename="REQ-2026-0007.pdf"')));

    const name = await mod.api.download('/stock-requisitions/x/export/pdf', 'fallback.pdf');
    expect(name).toBe('REQ-2026-0007.pdf');
  });

  test('prefers the RFC 5987 form when both are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fileOk('PDF',
      "attachment; filename=\"REQ.pdf\"; filename*=UTF-8''REQ-2026-%E0%A5%A7.pdf")));

    const name = await mod.api.download('/x', 'fallback.pdf');
    expect(name).toBe('REQ-2026-१.pdf');
  });

  test('falls back when the header is not exposed (cross-origin)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fileOk('PDF', null)));
    const name = await mod.api.download('/x', 'REQ-2026-0007.pdf');
    expect(name).toBe('REQ-2026-0007.pdf');
  });

  test('a 401 refreshes once and retries, exactly like a JSON call', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (isRefreshCall(url)) return refreshOk('fresh-token');
      return mod.getToken() === 'fresh-token'
        ? fileOk('PDF', 'attachment; filename="REQ.pdf"')
        : expired();
    }));

    const name = await mod.api.download('/x', 'fallback.pdf');
    expect(name).toBe('REQ.pdf');
    expect(mod.getToken()).toBe('fresh-token');
  });

  test("an error carries the server's message, not a Blob", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => forbidden()));

    await expect(mod.api.download('/x', 'f.pdf')).rejects.toMatchObject({
      message: 'Not allowed.',
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  test('an unreachable server is a NetworkError, not a dead session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch'); }));
    await expect(mod.api.download('/x', 'f.pdf')).rejects.toBeInstanceOf(mod.NetworkError);
    // The session survives — the same guarantee every other call gets.
    expect(mod.getToken()).toBe('stale-token');
  });
});

describe('filenameFromDisposition', () => {
  test('handles quoted, unquoted, starred and missing forms', () => {
    const f = mod.filenameFromDisposition;
    expect(f('attachment; filename="a b.xlsx"')).toBe('a b.xlsx');
    expect(f('attachment; filename=plain.pdf')).toBe('plain.pdf');
    expect(f("attachment; filename*=UTF-8''caf%C3%A9.pdf")).toBe('café.pdf');
    expect(f(null)).toBeNull();
    expect(f('attachment')).toBeNull();
  });

  test('a malformed percent-escape falls back rather than throwing', () => {
    // decodeURIComponent('%E0%A4') throws URIError. A broken header must not
    // take down the download that was otherwise fine.
    expect(mod.filenameFromDisposition("attachment; filename=\"ok.pdf\"; filename*=UTF-8''%E0%A4"))
      .toBe('ok.pdf');
  });
});
