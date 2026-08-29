import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { dateTime, initials } from '../../lib/format';
import PageHeader from '../../patterns/PageHeader';
import FormDialog from '../../patterns/FormDialog';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Field from '../../ui/Field';
import Input from '../../ui/Input';
import EmptyState from '../../ui/EmptyState';
import ErrorState from '../../ui/ErrorState';
import { SkeletonRegion, SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';

const MAX_STAFF = 4;

export default function UsersPage() {
  const toast = useToast();
  const deactivate = useConfirm();
  const resetPassword = useConfirm();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/users');
      setUsers(res.data.users);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const activeCount = users.filter((u) => u.is_active).length;
  const atCap = activeCount >= MAX_STAFF;

  const handleDeactivate = async () => {
    const user = deactivate.target;
    await api.patch(`/users/${user.id}/${user.is_active ? 'deactivate' : 'activate'}`);
    toast.success(`${user.full_name} ${user.is_active ? 'deactivated' : 'activated'}.`);
    fetchUsers();
  };

  const handleActivate = async (user) => {
    try {
      await api.patch(`/users/${user.id}/activate`);
      toast.success(`${user.full_name} activated.`);
      fetchUsers();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleResetPassword = async () => {
    const user = resetPassword.target;
    await api.post(`/users/${user.id}/reset-password`);
    toast.success(`Reset email sent to ${user.full_name}.`);
  };

  return (
    <div>
      <PageHeader
        title="Staff Accounts"
        subtitle={`${activeCount} of ${MAX_STAFF} slots used`}
        actions={
          <Button
            variant="primary"
            onClick={() => setModalOpen(true)}
            blockedReason={atCap ? `All ${MAX_STAFF} staff slots are in use. Deactivate an account below to free one up.` : null}
          >
            <PlusIcon className="h-4 w-4" />
            Add staff
          </Button>
        }
      />

      {/* Slot meter. The count beside it carries the same information in
          words, so the bars are decorative and the state never depends on
          colour alone (A4). */}
      <div className="mb-s5 flex gap-s2" aria-hidden="true">
        {Array.from({ length: MAX_STAFF }, (_, i) => (
          <div
            key={i}
            className={cn('h-1.5 flex-1 rounded-pill', i < activeCount ? 'bg-primary' : 'bg-border')}
          />
        ))}
      </div>

      {error ? (
        <ErrorState title="Couldn't load staff accounts" message={error.message} onRetry={fetchUsers} />
      ) : loading ? (
        <SkeletonRegion label="Loading staff accounts…">
          <SkeletonRows count={3} leading />
        </SkeletonRegion>
      ) : users.length === 0 ? (
        <EmptyState
          title="No staff accounts yet"
          body="Staff accounts let counter hands ring up sales without seeing cost prices, margins or vendor payments."
          action={<Button variant="primary" onClick={() => setModalOpen(true)}>Add the first staff member</Button>}
        />
      ) : (
        <ul className="flex flex-col gap-s2">
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              onDeactivate={() => deactivate.ask(user)}
              onActivate={() => handleActivate(user)}
              onResetPassword={() => resetPassword.ask(user)}
            />
          ))}
        </ul>
      )}

      <CreateUserModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreated={() => {
          fetchUsers();
          toast.success('Staff account created. Setup email sent.');
        }}
      />

      <ConfirmDialog
        {...deactivate.props}
        destructive
        title={`Deactivate ${deactivate.target?.full_name}?`}
        body="They'll be signed out immediately and won't be able to log back in. Bills they've already rung up are unaffected, and you can reactivate the account at any time."
        confirmLabel="Deactivate account"
        onConfirm={handleDeactivate}
      />

      <ConfirmDialog
        {...resetPassword.props}
        title={`Send a reset email to ${resetPassword.target?.full_name}?`}
        body={`They'll get a link at ${resetPassword.target?.email} to set a new password. Their current password keeps working until they use it.`}
        confirmLabel="Send reset email"
        onConfirm={handleResetPassword}
      />
    </div>
  );
}

function UserRow({ user, onDeactivate, onActivate, onResetPassword }) {
  const isOwnerAccount = user.role === 'owner';

  return (
    // Stacked on phones (identity above, actions below), one line from sm up —
    // flex-wrap squeezed the details into one-word columns beside the buttons.
    <li className="flex flex-col gap-s2 rounded-card border border-border bg-card p-s3 sm:flex-row sm:items-start sm:gap-s3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-pill bg-primary text-base font-bold text-primary-foreground">
        {user.avatar_url
          ? <img src={user.avatar_url} alt="" className="h-11 w-11 object-cover" />
          : initials(user.full_name)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-s2">
          <span className={cn('text-base font-bold', user.is_active ? 'text-foreground' : 'text-muted-foreground')}>
            {user.full_name}
          </span>
          <Badge tone={isOwnerAccount ? 'flag' : 'neutral'}>{isOwnerAccount ? 'Owner' : 'Staff'}</Badge>
          {!user.is_active && <Badge tone="critical">Deactivated</Badge>}
        </div>
        <p className="text-base text-muted-foreground">{user.email}</p>
        {user.phone && <p className="text-base text-muted-foreground">{user.phone}</p>}
        <p className="text-base text-muted-foreground">
          Last signed in: {user.last_login_at ? dateTime(user.last_login_at) : 'never'}
        </p>
      </div>

      {/* The owner account cannot deactivate or reset itself from here —
          rendering nothing is deliberate, per §3.6's rule that an unavailable
          action is absent rather than shown disabled. Actions sit under the
          details on phones and never steal their width. */}
      {!isOwnerAccount && (
        <div className="flex shrink-0 items-center justify-end gap-s1 border-t border-border pt-s2 sm:border-t-0 sm:pt-0">
          <Button variant="ghost" size="compact" onClick={onResetPassword}>Reset password</Button>
          {user.is_active ? (
            <Button variant="ghost" size="compact" className="text-destructive" onClick={onDeactivate}>Deactivate</Button>
          ) : (
            <Button variant="ghost" size="compact" className="text-accent" onClick={onActivate}>Activate</Button>
          )}
        </div>
      )}
    </li>
  );
}

function CreateUserModal({ open, onOpenChange, onCreated }) {
  const [form, setForm] = useState({ full_name: '', email: '', phone: '' });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) { setForm({ full_name: '', email: '', phone: '' }); setErrors({}); }
  }, [open]);

  const set = (key) => (event) => {
    setForm((f) => ({ ...f, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const found = {};
    if (form.full_name.trim().length < 2) found.full_name = 'Enter their full name, at least 2 characters.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) found.email = 'Enter a valid email — the setup link is sent here.';
    if (form.phone && !/^[6-9]\d{9}$/.test(form.phone.replace(/\s/g, ''))) {
      found.phone = 'Enter a 10-digit Indian mobile number starting 6–9.';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    await api.post('/users', form);
    onCreated();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add staff member"
      description="They'll get an email to set their own password. The account is active as soon as they do."
      submitLabel="Create account"
      onSubmit={handleSubmit}
    >
      <Field label="Full name" required error={errors.full_name}>
        <Input value={form.full_name} onChange={set('full_name')} placeholder="e.g. Priya Nair" autoComplete="name" />
      </Field>

      <Field label="Email" required error={errors.email}>
        <Input type="email" value={form.email} onChange={set('email')} placeholder="priya@pcare.in" autoComplete="email" />
      </Field>

      <Field label="Phone" hint="(optional)" error={errors.phone}>
        <Input type="tel" inputMode="numeric" value={form.phone} onChange={set('phone')} placeholder="98xxxxxxx0" />
      </Field>
    </FormDialog>
  );
}
