// ── Module 20: Audit Logs
// ── Role: Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');

// Human-readable action labels
const ACTION_LABELS = {
  login: 'Signed in', logout: 'Signed out', login_failed: 'Failed login',
  user_created: 'Created staff account', user_updated: 'Updated profile',
  user_deactivated: 'Deactivated account', user_activated: 'Activated account',
  medicine_created: 'Added medicine to catalog', medicine_updated: 'Updated medicine',
  medicine_deactivated: 'Deactivated medicine',
  category_created: 'Created category', category_updated: 'Updated category',
  category_deactivated: 'Deactivated category',
  batch_created: 'Added inventory batch', stock_adjusted: 'Adjusted stock manually',
  expiry_writeoff: 'Wrote off expired batch',
  supplier_created: 'Added supplier', supplier_updated: 'Updated supplier',
  purchase_created: 'Created purchase order', purchase_sent: 'Sent purchase order',
  purchase_received: 'Received goods from supplier',
  bill_created: 'Created bill (sale)',
  customer_created: 'Registered customer', customer_updated: 'Updated customer',
  customer_return_created: 'Submitted customer return', customer_return_approved: 'Approved customer return',
  customer_return_rejected: 'Rejected customer return',
  supplier_return_created: 'Created supplier return', supplier_return_sent: 'Sent supplier return',
  staff_check_in: 'Staff checked in', staff_check_out: 'Staff checked out',
  // Module 30. `_exported` earns its place beside the four workflow actions:
  // it is the moment a priced vendor list leaves the system, it is owner-only,
  // and nothing else in the trail records it.
  stock_requisition_created: 'Raised a stock request',
  stock_requisition_approved: 'Approved a stock request',
  stock_requisition_rejected: 'Rejected a stock request',
  stock_requisition_cancelled: 'Withdrew a stock request',
  stock_requisition_exported: 'Downloaded a stock request',
};

// All distinct action types (for filter dropdown)
const ACTION_TYPES = Object.keys(ACTION_LABELS);

async function listAuditLogs({ action, userId, dateFrom, dateTo, page=1, limit=50 } = {}) {
  const offset = (page-1)*limit;
  let q = supabase.from('audit_logs')
    .select('*, users(full_name, role)', { count:'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset+limit-1);
  if (action)   q = q.eq('action', action);
  if (userId)   q = q.eq('user_id', userId);
  if (dateFrom) q = q.gte('created_at', dateFrom);
  if (dateTo)   q = q.lte('created_at', dateTo+'T23:59:59');

  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch audit logs.', 500, 'DB_ERROR');

  const logs = (data||[]).map(l => ({
    ...l,
    action_label: ACTION_LABELS[l.action] || l.action,
    user_name: l.users?.full_name || 'System',
    user_role: l.users?.role,
  }));

  return { logs, action_types: ACTION_TYPES, pagination: { page, limit, total: count, pages: Math.ceil(count/limit) } };
}

module.exports = { ACTION_LABELS, ACTION_TYPES, listAuditLogs };
