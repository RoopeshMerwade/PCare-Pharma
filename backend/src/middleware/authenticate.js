// ── Middleware: JWT Authentication + Role enforcement

const { supabase } = require('../config/supabase');
const { AppError } = require('../utils/AppError');
const { asyncHandler } = require('../utils/asyncHandler');

// Verify JWT and attach user to req
const authenticate = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw new AppError('Authentication token required.', 401, 'TOKEN_MISSING');

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) throw new AppError('Invalid or expired token. Please log in again.', 401, 'TOKEN_INVALID');

  // Fetch fresh profile (catches suspension mid-session)
  const { data: profile } = await supabase.from('users').select('id, role, is_active, full_name').eq('id', user.id).single();
  if (!profile?.is_active) throw new AppError('Account suspended.', 403, 'ACCOUNT_SUSPENDED');

  req.user = profile;
  next();
});

// Role guard factory — usage: authorize('owner')  or  authorize('owner','staff')
const authorize = (...roles) => asyncHandler(async (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    throw new AppError('You do not have permission to perform this action.', 403, 'FORBIDDEN');
  }
  next();
});

module.exports = { authenticate, authorize };
