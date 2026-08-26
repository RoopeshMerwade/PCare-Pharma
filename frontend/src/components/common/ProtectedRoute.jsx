import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import AppShell from './AppShell';
import PageErrorBoundary from './PageErrorBoundary';
import SessionTakeoverOverlay from './SessionTakeoverOverlay';
import Spinner from '../../ui/Spinner';

// Usage: <ProtectedRoute role="owner" title="Dashboard"> <OwnerDashboard /> </ProtectedRoute>
export default function ProtectedRoute({ children, role, title }) {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();

  if (loading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center gap-s2 bg-background text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Spinner />
        <span className="text-base">Checking your session…</span>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/unauthorized" replace />;

  return (
    <>
      <AppShell title={title}>
        <PageErrorBoundary resetKey={pathname}>{children}</PageErrorBoundary>
      </AppShell>
      {/* Mounted here rather than in App so it can never appear over /login —
          and inside the authenticated tree so the page it is freezing stays
          rendered behind it. */}
      <SessionTakeoverOverlay />
    </>
  );
}
