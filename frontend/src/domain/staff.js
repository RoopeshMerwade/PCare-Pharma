// ═══════════════════════════════════════════════════════════════════════════
// Staff account setup — has this person ever actually signed in?
//
// A staff account is created with a random password nobody is told
// (users.service.js createUser) plus a setup email. Until they follow that
// link, choose a password and sign in, the account exists but nobody can use
// it — and the owner needs to see that, or a new hire's first shift starts
// with a login that does not work.
//
// Neither obvious field can say so. `email_confirmed_at` is stamped at
// creation, because owner-created accounts skip verification, and
// `auth.users.last_sign_in_at` is also stamped by merely verifying a reset
// link. `last_login_at` on staff_summary is derived from the app's own `login`
// audit rows, written only after a correct password — so "no login on record"
// is exactly "setup not finished", with nothing extra stored.
// ═══════════════════════════════════════════════════════════════════════════

export const SETUP_PENDING = { tone: 'warning', label: 'Setup pending' };

// A deactivated account is not pending: nobody is waiting on it, and its own
// Deactivated badge already says what matters. The owner row never qualifies.
export function isSetupPending(user) {
  return user?.role === 'staff' && Boolean(user.is_active) && !user.last_login_at;
}
