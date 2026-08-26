import { useState } from 'react';
import { api } from '../../lib/api';
import AuthLayout from './AuthLayout';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input from '../../ui/Input';
import Link from '../../ui/Link';
import ErrorState from '../../ui/ErrorState';

/* One of the three routes LoginPage and ProtectedRoute linked to that did not
   exist — they fell through path="*" to "/". The backend has had
   POST /auth/forgot-password all along, so the fix is the missing route
   rather than removing the link. */

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      setError(err.message || 'Could not send the reset link. Check the email address and try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="If that address is registered, a reset link is on its way."
        footer={<Link to="/login" variant="standalone" padded>Back to sign in</Link>}
      >
        <p className="text-base text-muted-foreground">
          The link expires in one hour. If it doesn&rsquo;t arrive within a few minutes, check the spam
          folder or ask the owner to reset it for you from Staff settings.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a link to set a new one."
      footer={<Link to="/login" variant="standalone" padded>Back to sign in</Link>}
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-s4">
        {error && <ErrorState message={error} />}
        <Field label="Email">
          <Input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@pcare.in"
          />
        </Field>
        <Button type="submit" variant="primary" size="block" loading={loading}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}
