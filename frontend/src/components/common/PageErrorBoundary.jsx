import { Component } from 'react';
import ErrorState from '../../ui/ErrorState';

/* ═══════════════════════════════════════════════════════════════════════════
   PageErrorBoundary — the app had none of these until a real upload crashed
   the whole tree to a blank screen.

   React 18 unmounts the entire root on an uncaught render error. With no
   boundary anywhere, that is indistinguishable from the app simply failing to
   load — no message, no nav, nothing to click, and no clue what broke.

   Placed around each route's `children` inside ProtectedRoute — INSIDE
   AppShell, not around it — so a crash in one page's content loses only that
   content. The sidebar, the "back to invoices" link, the logged-in session:
   all still there, because AppShell itself is outside this boundary.
   ═══════════════════════════════════════════════════════════════════════════ */

export default class PageErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Page crashed:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Navigating away from a crashed page must not carry the crash forward
    // onto whatever loads next — `resetKey` is the route path, so a fresh
    // location clears it.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <ErrorState
        title="This page hit an error and stopped"
        message={
          // Dev: the real message, so whoever is looking at this can act on it
          // immediately. Prod: no internals in what a user reads, mirroring the
          // same NODE_ENV gate the backend's errorHandler uses for stack traces.
          import.meta.env.DEV
            ? error.message
            : 'Reload the page. If it happens again, tell the owner exactly what you were doing right before this appeared.'
        }
        onRetry={() => window.location.reload()}
      />
    );
  }
}
