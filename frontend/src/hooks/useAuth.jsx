import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import {
  api, getUid, setSession, setIdentity, clearSession, abandonSession,
  bootstrapSession, syncFromStorage, setAuthFailureHandler, setSessionTakeoverHandler,
  SESSION_KEY,
} from '../lib/api';

/* ═══════════════════════════════════════════════════════════════════════════
   Auth state, and the detection of a session being taken over.

   The access token lives in JavaScript memory only (lib/api.js), so a reload
   starts with no token at all. `bootstrapSession()` is what recovers one: it
   POSTs /auth/refresh, the browser attaches the httpOnly cookie, and the
   session comes back without anything having been persisted where a script
   could read it. Only then is /auth/me worth calling.

   Identity — the user's id and display name, never a credential — IS persisted,
   because it is what the shared-terminal check compares. Every tab on the
   origin shares one localStorage and one `pcare_refresh` cookie, so a second
   person signing in re-points this tab's requests at their identity. The rule
   is LAST LOGIN OWNS THE BROWSER: the displaced tab freezes rather than
   carrying on under a name that is no longer its own. lib/api.js carries the
   full reasoning and does the enforcing; this file notices and tells the user.
   ═══════════════════════════════════════════════════════════════════════════ */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // true until first profile check
  const [takeover, setTakeover] = useState(null); // { byName } once displaced
  const [sessionNotice, setSessionNotice] = useState('');

  // Let the API client end the session when a refresh genuinely fails, and
  // raise the overlay when it detects it is no longer talking for this user.
  //
  // Note the failure hook fires ONLY on refresh failure. A routine token
  // rotation never touches React state, so `user` survives and the UI never
  // flickers.
  useEffect(() => {
    setAuthFailureHandler(() => {
      setUser(null);
      setSessionNotice('Your session ended. Please sign in again.');
    });
    setSessionTakeoverHandler((byName) => setTakeover({ byName: byName || null }));
    return () => {
      setAuthFailureHandler(null);
      setSessionTakeoverHandler(null);
    };
  }, []);

  // On mount: recover an access token from the httpOnly refresh cookie, then
  // confirm who it belongs to.
  //
  // There is nothing in storage to "verify" any more — the token is memory-only
  // and this page has just loaded, so it starts with none. bootstrapSession()
  // resolves to a token, or to null when there is no usable cookie (a first
  // visit, or one that expired while the tab was closed). Null is the ordinary
  // signed-out case, not an error: fall through to /login with no session
  // cleared and nothing logged.
  useEffect(() => {
    let cancelled = false;

    bootstrapSession()
      .then((token) => (token ? api.get('/auth/me') : null))
      .then((res) => {
        if (cancelled || !res) return;
        const me = res.data.user;
        setUser(me);
        // Self-heals an identity that disagrees with what the server just said —
        // including a tab whose stored identity is stale after a takeover.
        if (getUid() !== me.id) setIdentity(me.id, me.full_name);
      })
      .catch((err) => {
        if (cancelled) return;
        // A takeover already dropped this tab's copy. Calling clearSession()
        // here would wipe SHARED storage and sign out whoever now owns it.
        if (err?.code === 'SESSION_TAKEOVER') return;
        // A network failure must not destroy an identity that is probably fine;
        // the user sees the login screen and a retry costs one reload.
        if (err?.code === 'NETWORK_ERROR') return;
        clearSession();
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, []);

  const reconcile = useCallback(() => {
    const result = syncFromStorage();
    if (result.status === 'taken_over') {
      setTakeover((current) => current || { byName: result.byName || null });
    } else if (result.status === 'ended') {
      setUser(null);
      setSessionNotice('You were signed out in another tab.');
    }
  }, []);

  // The `storage` event fires in every OTHER tab of the origin — never in the
  // one that made the change, which is exactly right: the tab someone just
  // signed in on must not freeze itself.
  useEffect(() => {
    const onStorage = (event) => {
      // key === null means localStorage.clear() — reconcile for that too.
      if (event.key !== null && event.key !== SESSION_KEY) return;
      reconcile();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [reconcile]);

  // Belt and braces: a backgrounded or frozen tab (common on mobile, and on any
  // machine left overnight) can miss the storage event entirely, so identity is
  // re-checked whenever the tab comes back to the foreground.
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === 'hidden') return;
      reconcile();
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [reconcile]);

  const login = useCallback(async (email, password) => {
    setSessionNotice('');
    const res = await api.post('/auth/login', { email, password });
    const me = res.data.user;
    // Identity is stored WITH the token. Every other tab on this browser sees
    // the change and stands down.
    setSession({ token: res.data.session.access_token, userId: me.id, fullName: me.full_name });
    setUser(me);
    setTakeover(null);
    return me;
  }, []);

  const logout = useCallback(async () => {
    // Order matters: the server call needs the access token, so it goes first.
    // It clears the httpOnly `pcare_refresh` cookie (auth.controller.js);
    // clearSession() then drops the in-memory access token and the stored
    // identity. Both halves of the credential are gone.
    await api.post('/auth/logout').catch(() => {});
    clearSession(); // a real sign-out — this browser's session is over
    setUser(null);
    setTakeover(null);
    setSessionNotice('');
  }, []);

  /**
   * Leave a session that has been taken over.
   *
   * Uses abandonSession(), NOT clearSession(), and the difference is the whole
   * point: shared storage now holds the credentials of whoever just signed in.
   * Clearing it from here would fire a removal event in THEIR tab and sign them
   * out — the displaced tab would take down the session that displaced it.
   */
  const leaveTakenOverSession = useCallback(() => {
    const name = takeover?.byName;
    abandonSession();
    setUser(null);
    setTakeover(null);
    setSessionNotice(
      name
        ? `${name} signed in on this browser, so this tab was signed out.`
        : 'Someone else signed in on this browser, so this tab was signed out.'
    );
  }, [takeover]);

  const clearSessionNotice = useCallback(() => setSessionNotice(''), []);

  const value = useMemo(() => ({
    user,
    loading,
    login,
    logout,
    isOwner: user?.role === 'owner',
    takeover,
    leaveTakenOverSession,
    sessionNotice,
    clearSessionNotice,
  }), [user, loading, login, logout, takeover, leaveTakenOverSession, sessionNotice, clearSessionNotice]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
