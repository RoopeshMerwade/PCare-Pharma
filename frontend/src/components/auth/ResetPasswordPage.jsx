import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import AuthLayout from './AuthLayout';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input from '../../ui/Input';
import Link from '../../ui/Link';
import ErrorState from '../../ui/ErrorState';

/* Password rules mirror the backend's resetRules exactly (8+ chars, one
   uppercase, one digit). Checking them here as well means the requirement is
   stated before the user commits rather than after the round trip — §5's rule
   that an error says how to fix it works better as a rule stated up front. */
function validate(password, confirmation) {
  const errors = {};
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (!/[A-Z]/.test(password)) errors.password = 'Include at least one capital letter.';
  else if (!/[0-9]/.test(password)) errors.password = 'Include at least one number.';
  if (confirmation && password !== confirmation) errors.confirmation = 'Both passwords must match.';
  return errors;
}

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Extract token from either query params (?token_hash=...) or URL hash fragment (#access_token=...)
  const hashParams = typeof window !== 'undefined' && window.location.hash
    ? new URLSearchParams(window.location.hash.replace(/^#/, ''))
    : null;

  const token = params.get('token_hash')
    || params.get('token')
    || params.get('access_token')
    || hashParams?.get('token_hash')
    || hashParams?.get('access_token')
    || hashParams?.get('token')
    || '';

  const [form, setForm] = useState({ password: '', confirmation: '' });
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (key) => (event) => {
    setForm((f) => ({ ...f, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const found = validate(form.password, form.confirmation);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setApiError('');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, new_password: form.password });
      navigate('/login', { replace: true });
    } catch (err) {
      setApiError(err.message || 'Could not update the password. The link may have expired — request a new one.');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout
        title="This link is no longer valid"
        subtitle="Reset links expire an hour after they're sent."
        footer={<Link to="/forgot-password" variant="standalone" padded>Request a new link</Link>}
      >
        <p className="text-base text-muted-foreground">
          Open the most recent email, or request a fresh link and use that one instead.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set a new password" subtitle="You'll sign in with this from now on.">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-s4">
        {apiError && <ErrorState message={apiError} />}

        <Field
          label="New password"
          error={errors.password}
          hint="8+ characters, one capital, one number"
        >
          <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>

        <Field label="Confirm new password" error={errors.confirmation}>
          <Input type="password" autoComplete="new-password" value={form.confirmation} onChange={set('confirmation')} />
        </Field>

        <Button type="submit" variant="primary" size="block" loading={loading}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
