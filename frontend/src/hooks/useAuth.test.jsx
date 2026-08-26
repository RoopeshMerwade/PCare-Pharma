/**
 * Cross-tab session integrity at the React layer.
 * Runner: Vitest.  Run: npm test
 *
 * The defect these cover: credentials are per-ORIGIN, not per-tab (one
 * localStorage, one `pcare_refresh` cookie), so a second person signing in
 * re-points an already-open tab at their token while it carries on showing the
 * first person's name. A bill was recorded against the wrong person that way.
 *
 * jsdom does not dispatch `storage` between "tabs" — there is only one window —
 * so the event is dispatched by hand. That is exactly what the browser does to
 * every OTHER tab on the origin when localStorage changes, which is the signal
 * under test.
 *
 * NOTE ON THE STORAGE SHAPE: localStorage holds IDENTITY only — { u, n }. The
 * access token is memory-only (see lib/api.js), so a mount now begins with
 * POST /auth/refresh to recover one from the httpOnly cookie, and the fetch
 * stub below has to answer that before /auth/me is ever reached.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const SESSION_KEY = 'pcare_session';
const ME = { id: 'user-me', full_name: 'Asha', role: 'staff' };
const THEM = { id: 'user-them', full_name: 'Vijay', role: 'owner' };

let AuthProvider, useAuth, apiMod;

/** What the browser fires in every other tab when localStorage changes. */
function dispatchStorage(key, newValue) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

/** What a tab persists: identity, never a credential. */
function stored(user) {
  return JSON.stringify({ u: user.id, n: user.full_name });
}

// Module-scope, not defined inside a test — a component created in a render
// body gets a new identity every render (see ui/Field.jsx and the lint rule).
function Probe() {
  const { user, loading, takeover, sessionNotice, leaveTakenOverSession } = useAuth();
  if (loading) return <p>loading</p>;
  return (
    <div>
      <p data-testid="who">{user ? user.full_name : 'signed-out'}</p>
      <p data-testid="takeover">{takeover ? `taken-over-by:${takeover.byName}` : 'none'}</p>
      <p data-testid="notice">{sessionNotice}</p>
      <button type="button" onClick={leaveTakenOverSession}>Sign in again</button>
    </div>
  );
}

const renderAuth = () => render(<AuthProvider><Probe /></AuthProvider>);

beforeEach(async () => {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
  localStorage.setItem(SESSION_KEY, stored(ME));

  // Mount is now two calls: /auth/refresh recovers a token from the cookie,
  // then /auth/me says who it belongs to.
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/auth/refresh')
      ? { success: true, data: { access_token: 'recovered-token', expires_at: 1, user_id: ME.id } }
      : { success: true, data: { user: ME } }),
  })));

  vi.resetModules();
  apiMod = await import('../lib/api');
  ({ AuthProvider, useAuth } = await import('./useAuth.jsx'));
});

afterEach(() => vi.unstubAllGlobals());

describe('mount', () => {
  test('restores the session and stamps the identity onto it', async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Asha'));
    expect(apiMod.getUid()).toBe(ME.id);
  });
});

describe('another tab signs in as someone else', () => {
  test('the tab freezes, names the person, and keeps the user rendered behind it', async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Asha'));

    act(() => {
      localStorage.setItem(SESSION_KEY, stored(THEM));
      dispatchStorage(SESSION_KEY, stored(THEM));
    });

    await waitFor(() =>
      expect(screen.getByTestId('takeover')).toHaveTextContent('taken-over-by:Vijay'));
    // Still rendered underneath: an unfinished bill must not vanish before the
    // person is told what happened. Nothing can be SENT — that is enforced by
    // the latch in lib/api.js, covered in api.test.js.
    expect(screen.getByTestId('who')).toHaveTextContent('Asha');
    expect(apiMod.isTakenOver()).toBe(true);
  });

  test('signing in again does NOT sign out the person who now owns the browser', async () => {
    // The trap this design exists to avoid: clearing shared storage from the
    // displaced tab would fire a removal event in the new owner's tab and take
    // down the very session that displaced it.
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Asha'));

    act(() => {
      localStorage.setItem(SESSION_KEY, stored(THEM));
      dispatchStorage(SESSION_KEY, stored(THEM));
    });
    await waitFor(() => expect(screen.getByTestId('takeover')).not.toHaveTextContent('none'));

    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('notice')).toHaveTextContent(/Vijay signed in on this browser/);
    // Their credentials survive untouched.
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).u).toBe(THEM.id);
    // And this tab can sign in again.
    expect(apiMod.isTakenOver()).toBe(false);
  });
});

describe('another tab belonging to the SAME person', () => {
  test('a sibling tab writing the same identity is not a freeze', async () => {
    // Two tabs of one session (billing + inventory) is normal and must keep
    // working. Identity is compared, never "did the token change" — each tab
    // now holds its OWN token in memory and refreshes independently, so a
    // token comparison across tabs would be meaningless as well as wrong.
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Asha'));

    act(() => {
      localStorage.setItem(SESSION_KEY, stored(ME));
      dispatchStorage(SESSION_KEY, stored(ME));
    });

    expect(screen.getByTestId('takeover')).toHaveTextContent('none');
    expect(screen.getByTestId('who')).toHaveTextContent('Asha');
    // This tab keeps the token it recovered at mount — untouched by the sibling.
    expect(apiMod.getToken()).toBe('recovered-token');
    expect(apiMod.isTakenOver()).toBe(false);
  });
});

describe('signed out in another tab', () => {
  test('this tab ends its session and says why', async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Asha'));

    act(() => {
      localStorage.removeItem(SESSION_KEY);
      dispatchStorage(SESSION_KEY, null);
    });

    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('notice')).toHaveTextContent('You were signed out in another tab.');
  });
});

describe('a tab that missed the event', () => {
  test('identity is re-checked when the tab comes back to the foreground', async () => {
    // Backgrounded and frozen tabs (mobile, or a machine left overnight) can
    // miss `storage` entirely, so focus is the belt-and-braces check.
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Asha'));

    act(() => {
      // Storage changes with NO event delivered — the frozen-tab case.
      localStorage.setItem(SESSION_KEY, stored(THEM));
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('takeover')).toHaveTextContent('taken-over-by:Vijay'));
  });
});

describe('unrelated storage keys', () => {
  test('a theme or sidebar write is ignored', async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Asha'));

    act(() => dispatchStorage('pcare.theme', 'dark'));

    expect(screen.getByTestId('takeover')).toHaveTextContent('none');
    expect(screen.getByTestId('who')).toHaveTextContent('Asha');
  });
});
