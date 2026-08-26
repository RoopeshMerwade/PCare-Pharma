import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input from '../../ui/Input';
import Link from '../../ui/Link';
import ErrorState from '../../ui/ErrorState';
import ThemeToggle from '../common/ThemeToggle';
import pharmacyIllustration from '../../assets/illustrations/pharmacy-counter.png';

/* ═══════════════════════════════════════════════════════════════════════════
   LoginPage — Shadcn login-02 split-screen authentication page.

   - Left column: Brand header, theme switch, structured login form with
     session notice, error feedback, and password assistance.
   - Right column: Hero illustration showcasing the pharmacy counter,
     with a contextual quote and pharmacy details.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function LoginPage() {
  const { login, sessionNotice } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await login(form.email, form.password);
      navigate(user.role === 'owner' ? '/dashboard' : '/staff', { replace: true });
    } catch (err) {
      setError(err.message || 'Could not sign in. Check your email and password, then try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      {/* ── Left column: Login form & actions ─────────────────────────── */}
      <div className="flex flex-col justify-between p-s4 sm:p-s6 lg:p-s8">
        {/* Header brand & Theme Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-s2">
            <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-primary text-sm font-bold text-primary-foreground shadow-1">
              P
            </span>
            <div>
              <span className="block text-base font-bold leading-tight text-foreground">P.Care Pharma</span>
              <span className="block text-base leading-tight text-muted-foreground">Gadag · Karnataka</span>
            </div>
          </div>
          <ThemeToggle />
        </div>

        {/* Form Container */}
        <div className="mx-auto my-s6 flex w-full max-w-sm flex-1 flex-col justify-center animate-fade-in">
          <div className="flex flex-col gap-s5">
            <div className="flex flex-col gap-s1">
              <h1 className="text-lg font-bold text-foreground">Welcome back</h1>
              <p className="text-base text-muted-foreground">
                Sign in to access your dispensary counter and inventory
              </p>
            </div>

            {sessionNotice && !error && (
              <p
                role="status"
                className="rounded-control border border-warning/30 bg-warning-wash px-s3 py-s2 text-base text-warning-ink"
              >
                {sessionNotice}
              </p>
            )}

            {error && <ErrorState message={error} />}

            <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-s4">
              <Field label="Email" required>
                <Input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  value={form.email}
                  onChange={set('email')}
                  placeholder="you@pcare.in"
                />
              </Field>

              <div className="flex flex-col gap-s1">
                <Field label="Password" required>
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    autoComplete="current-password"
                    required
                    value={form.password}
                    onChange={set('password')}
                    suffix={
                      <Button
                        type="button"
                        variant="ghost"
                        size="compact"
                        onClick={() => setShowPassword((s) => !s)}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </Button>
                    }
                  />
                </Field>
                <div className="flex justify-end">
                  <Link to="/forgot-password" variant="standalone" padded>
                    Forgot your password?
                  </Link>
                </div>
              </div>

              <Button type="submit" variant="primary" size="block" loading={loading} className="mt-s1">
                Sign in
              </Button>
            </form>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-base text-muted-foreground">
          P.Care Pharmacy Management &middot; Dispensary &amp; Inventory System
        </div>
      </div>

      {/* ── Right column: Hero illustration (lg+) ───────────────────────── */}
      <div className="relative hidden flex-col justify-between border-l border-border bg-card/60 p-s6 lg:flex">
        {/* Background illustration container */}
        <div className="my-auto flex flex-1 items-center justify-center p-s4">
          <img
            src={pharmacyIllustration}
            alt="Pharmacy counter with pharmacist dispensing medicines"
            className="max-h-[480px] w-full max-w-lg object-contain drop-shadow-sm transition-transform duration-instant hover:scale-[1.01]"
          />
        </div>

        {/* Hero Quote Card */}
        <div className="relative z-10 rounded-card border border-border/80 bg-card/90 p-s4 shadow-1 backdrop-blur-sm">
          <blockquote className="flex flex-col gap-s1">
            <p className="text-base font-bold text-foreground">
              &ldquo;Fast counter billing, live inventory batches with FEFO tracking, and automated supplier invoice processing.&rdquo;
            </p>
            <footer className="text-base text-muted-foreground">
              P.Care Pharma &middot; Retail &amp; Dispensary Management
            </footer>
          </blockquote>
        </div>
      </div>
    </div>
  );
}
