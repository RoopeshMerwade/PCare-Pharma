// ── Module: User Management
// ── Role: Service (business logic only — no HTTP knowledge)

const { supabase, createAuthClient } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const crypto = require('crypto');

// ────────────────────────────────────────────────
// READ
// ────────────────────────────────────────────────
async function listUsers() {
  const { data, error } = await supabase
    .from('staff_summary')       // view with last_login_at
    .select('*')
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Failed to fetch users.', 500, 'DB_ERROR');
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, phone, role, is_active, avatar_url, created_at, updated_at')
    .eq('id', id)
    .single();

  if (error || !data) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  return data;
}

// ────────────────────────────────────────────────
// CREATE — owner invites a new staff member
// ────────────────────────────────────────────────
async function createUser({ full_name, email, phone, role = 'staff' }, createdBy) {
  // Check staff limit before doing anything
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'staff')
    .eq('is_active', true);

  if (count >= 4) throw new AppError('Maximum 4 active staff accounts allowed.', 409, 'STAFF_LIMIT_REACHED');

  // Create Supabase Auth user with a random temp password. Duplicate email is
  // detected from the createUser error itself — the previous listUsers() scan
  // only saw the first page of accounts, and its companion check compared the
  // uuid id column against an email (never matched anything).
  const tempPassword = crypto.randomBytes(12).toString('base64url');
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true, // skip email verification for owner-created accounts
    user_metadata: { full_name }
  });

  if (authError) {
    if (authError.code === 'email_exists' || /already.*(registered|exists)/i.test(authError.message || '')) {
      throw new AppError('An account with this email already exists.', 409, 'EMAIL_TAKEN');
    }
    logger.error({ reason: authError.message }, 'Supabase Auth createUser failed');
    throw new AppError('Failed to create user account.', 500, 'AUTH_CREATE_FAILED');
  }

  // Insert public profile
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .insert({ id: authUser.user.id, full_name, phone, role, is_active: true })
    .select()
    .single();

  if (profileError) {
    // Rollback: remove auth user
    await supabase.auth.admin.deleteUser(authUser.user.id);
    logger.error({ profileError }, 'Profile insert failed — auth user rolled back');
    throw new AppError('Failed to create user profile.', 500, 'PROFILE_CREATE_FAILED');
  }

  // Send password-reset email so staff sets their own password.
  // Fresh anon client — auth operations never run on the shared
  // service-role client (see config/supabase.js).
  //
  // resetPasswordForEmail resolves with { data, error } — it does not throw
  // on a Supabase-side failure (no SMTP provider configured, the built-in
  // sender's rate limit, an address it rejects). Leaving `error` unchecked
  // meant every one of those failed completely silently: the account was
  // real, the response said "email sent", and nothing anywhere recorded that
  // it hadn't been. The account is still valid regardless, so this logs
  // rather than failing the request — but now there's something to look at.
  const { error: emailError } = await createAuthClient().auth.resetPasswordForEmail(email, {
    redirectTo: `${config.frontendUrl}/reset-password`
  });
  if (emailError) {
    logger.error({ email, reason: emailError.message }, 'Staff setup email failed to send');
  }

  await logAudit(createdBy, 'user_created', { targetUserId: profile.id, email, role });
  logger.info({ createdBy, targetId: profile.id, role }, 'User created');
  return profile;
}

// ────────────────────────────────────────────────
// UPDATE — owner updates any user; staff updates own
// ────────────────────────────────────────────────
async function updateUser(id, updates, requestingUser) {
  const isOwner = requestingUser.role === 'owner';
  const isSelf  = requestingUser.id === id;

  if (!isOwner && !isSelf) throw new AppError('Forbidden.', 403, 'FORBIDDEN');

  // Staff can only update their own name, phone, avatar
  const allowedForSelf = ['full_name', 'phone', 'avatar_url'];
  const safeUpdates = isOwner ? updates : Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowedForSelf.includes(k))
  );

  if (Object.keys(safeUpdates).length === 0) throw new AppError('No updatable fields provided.', 422, 'NO_FIELDS');

  const { data, error } = await supabase
    .from('users')
    .update(safeUpdates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.message?.includes('STAFF_LIMIT_REACHED')) throw new AppError('Maximum 4 active staff allowed.', 409, 'STAFF_LIMIT_REACHED');
    throw new AppError('Failed to update user.', 500, 'UPDATE_FAILED');
  }

  await logAudit(requestingUser.id, 'user_updated', { targetUserId: id, fields: Object.keys(safeUpdates) });
  return data;
}

// ────────────────────────────────────────────────
// ACTIVATE / DEACTIVATE
// ────────────────────────────────────────────────
async function setActiveStatus(id, isActive, requestingUser) {
  // Prevent deactivating the owner
  const target = await getUserById(id);
  if (target.role === 'owner') throw new AppError('The owner account cannot be deactivated.', 403, 'CANNOT_DEACTIVATE_OWNER');

  const { data, error } = await supabase
    .from('users')
    .update({ is_active: isActive })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new AppError('Failed to update account status.', 500, 'UPDATE_FAILED');

  const action = isActive ? 'user_activated' : 'user_deactivated';
  await logAudit(requestingUser.id, action, { targetUserId: id });
  logger.info({ requestedBy: requestingUser.id, targetId: id, isActive }, action);
  return data;
}

// ────────────────────────────────────────────────
// SEND PASSWORD RESET (owner-triggered for staff)
// ────────────────────────────────────────────────
async function sendPasswordReset(id, requestingUser) {
  const target = await getUserById(id);

  // Get auth email from Supabase Auth admin API
  const { data: authUser } = await supabase.auth.admin.getUserById(id);
  if (!authUser?.user?.email) throw new AppError('Could not find user email.', 404, 'EMAIL_NOT_FOUND');

  const { error: emailError } = await createAuthClient().auth.resetPasswordForEmail(authUser.user.email, {
    redirectTo: `${config.frontendUrl}/reset-password`
  });

  await logAudit(requestingUser.id, 'password_reset_sent', { targetUserId: id });
  if (emailError) {
    logger.error({ requestedBy: requestingUser.id, targetId: id, reason: emailError.message }, 'Password reset email failed to send');
  } else {
    logger.info({ requestedBy: requestingUser.id, targetId: id }, 'Password reset email sent');
  }
}

module.exports = { listUsers, getUserById, createUser, updateUser, setActiveStatus, sendPasswordReset };
