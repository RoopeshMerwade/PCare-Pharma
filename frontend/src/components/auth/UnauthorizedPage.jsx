import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import AuthLayout from './AuthLayout';
import Button from '../../ui/Button';

/* ProtectedRoute has always redirected here on a role mismatch; the route
   simply did not exist, so it fell through to "/" and the user was silently
   bounced to their own dashboard with no explanation. */

export default function UnauthorizedPage() {
  const navigate = useNavigate();
  const { user, isOwner } = useAuth();

  return (
    <AuthLayout
      title="That page is owner-only"
      subtitle={user ? `You're signed in as ${user.full_name}, a ${user.role} account.` : undefined}
    >
      <div className="flex flex-col gap-s4">
        <p className="text-base text-muted-foreground">
          Vendor payments, cost prices and reports are limited to the owner account.
          If you need something from one of those pages, ask the owner to open it for you.
        </p>
        <Button variant="primary" size="block" onClick={() => navigate(isOwner ? '/dashboard' : '/staff')}>
          Back to my dashboard
        </Button>
      </div>
    </AuthLayout>
  );
}
