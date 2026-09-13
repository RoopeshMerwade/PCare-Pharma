// ── Module 12: Customer Returns Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { assertCanAccess } = require('../../utils/authz');
const { mapDbError } = require('../../utils/dbErrors');
const { logAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

// ── READ
async function listReturns({ createdBy, status, page=1, limit=30 } = {}) {
  const offset = (page-1)*limit;
  let q = supabase.from('customer_returns_with_totals').select('*', { count:'exact' })
    .order('created_at', { ascending:false }).range(offset, offset+limit-1);
  if (createdBy) q = q.eq('created_by', createdBy);
  if (status)    q = q.eq('status', status);
  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch returns.', 500, 'DB_ERROR');
  return { returns: data, pagination: { page, limit, total: count, pages: Math.ceil(count/limit) } };
}

/**
 * Load a return with no authorisation check. INTERNAL ONLY — not exported.
 * Its callers are createReturn (re-reading what the actor just wrote) and the
 * owner-only approve/reject paths, both of which are already authorised.
 */
async function loadReturn(id) {
  const { data, error } = await supabase.from('customer_returns_with_totals').select('*').eq('id', id).single();
  if (error || !data) throw new AppError('Return not found.', 404, 'RETURN_NOT_FOUND');
  const { data: items } = await supabase.from('customer_return_items')
    .select('*, medicines(name, unit), inventory_batches(batch_no)').eq('return_id', id);
  return { ...data, items: items||[] };
}

/**
 * Read one return, subject to the SAME ownership rule listReturns applies.
 *
 * The identical gap bills had: `listReturns` scopes staff to their own rows via
 * `created_by`, the by-id read did not. A return carries the customer's name,
 * phone and the full refund breakdown of somebody else's sale.
 *
 * `actor` is req.user from the verified JWT and is required.
 */
async function getReturnById(id, actor) {
  const ret = await loadReturn(id);
  assertCanAccess(ret, actor, { label: 'return' });
  return ret;
}

// ── CREATE RETURN
async function createReturn({ bill_id, reason, refund_mode, notes, items }, createdBy) {
  if (!items?.length) throw new AppError('At least one return item is required.', 422, 'NO_ITEMS');

  // Validate bill exists
  const { data: bill } = await supabase.from('bills').select('id, customer_name, customer_phone').eq('id', bill_id).single();
  if (!bill) throw new AppError('Original bill not found.', 404, 'BILL_NOT_FOUND');

  // Validate each item against the original bill — including quantities
  // already claimed by earlier returns for the same bill item. Without the
  // cumulative check, the same strip could be "returned" repeatedly across
  // separate return requests (over-refund + stock inflation).
  for (const item of items) {
    const { data: bi } = await supabase.from('bill_items').select('id, qty, unit_price, batch_id, medicine_id').eq('id', item.bill_item_id).eq('bill_id', bill_id).single();
    if (!bi) throw new AppError(`Bill item ${item.bill_item_id} not found on this bill.`, 404, 'BILL_ITEM_NOT_FOUND');

    const { data: prior } = await supabase.from('customer_return_items')
      .select('qty_returned, customer_returns!inner(status)')
      .eq('bill_item_id', item.bill_item_id)
      .neq('customer_returns.status', 'rejected');
    const alreadyReturned = (prior || []).reduce((s, r) => s + r.qty_returned, 0);

    const remaining = bi.qty - alreadyReturned;
    if (item.qty_returned > remaining) {
      throw new AppError(
        `Cannot return more than sold: ${alreadyReturned} of ${bi.qty} already returned, max ${Math.max(remaining, 0)} remaining.`,
        422, 'QTY_EXCEEDS_SOLD'
      );
    }
    item._bi = bi; // cache for insert
  }

  const { data: rn } = await supabase.rpc('next_customer_return_number');
  const { data: cr, error } = await supabase.from('customer_returns')
    .insert({ return_number: rn, bill_id, customer_name: bill.customer_name, customer_phone: bill.customer_phone, reason: reason.trim(), refund_mode, notes: notes?.trim()||null, created_by: createdBy })
    .select().single();
  if (error) {
    // The owner can delete the bill between the lookup above and this insert.
    // The foreign key is what catches it: schema-38 locks the bill row, so this
    // insert waits for the delete to commit and then fails here.
    if (error.code === '23503') throw new AppError('This bill has been deleted.', 404, 'BILL_NOT_FOUND');
    throw new AppError('Failed to create return.', 500, 'DB_ERROR');
  }

  // Insert return items
  await supabase.from('customer_return_items').insert(
    items.map(i => ({ return_id: cr.id, bill_item_id: i.bill_item_id, batch_id: i._bi.batch_id, medicine_id: i._bi.medicine_id, qty_returned: i.qty_returned, unit_price: i._bi.unit_price }))
  );

  await logAudit(createdBy, 'customer_return_created', { returnId: cr.id, billId: bill_id });
  return await loadReturn(cr.id);
}

// ── APPROVE RETURN (owner only — posts stock and refund)
// Atomic: the RPC claims the pending row first (conditional UPDATE), so two
// concurrent approvals can't both post ledger entries; stock restore and
// refund computation commit in the same transaction.
async function approveReturn(id, userId) {
  const { data: refundAmount, error } = await supabase.rpc('approve_customer_return_atomic', {
    p_return_id: id,
    p_user_id: userId,
  });
  if (error) {
    const mapped = mapDbError(error);
    if (mapped) {
      if (mapped.code === 'INVALID_STATUS') throw new AppError('Only pending returns can be approved.', 409, 'INVALID_STATUS');
      throw mapped;
    }
    throw new AppError('Failed to approve return.', 500, 'DB_ERROR');
  }

  await logAudit(userId, 'customer_return_approved', { returnId: id, refundAmount });
  logger.info({ userId, returnId: id, refundAmount }, 'Customer return approved');
  return await loadReturn(id);
}

// ── REJECT RETURN (owner only)
async function rejectReturn(id, rejectionNote, userId) {
  const ret = await loadReturn(id);
  if (ret.status !== 'pending') throw new AppError('Only pending returns can be rejected.', 409, 'INVALID_STATUS');
  await supabase.from('customer_returns').update({ status: 'rejected', rejection_note: rejectionNote?.trim(), approved_by: userId, approved_at: new Date().toISOString() }).eq('id', id);
  await logAudit(userId, 'customer_return_rejected', { returnId: id });
  return await loadReturn(id);
}

module.exports = { listReturns, getReturnById, createReturn, approveReturn, rejectReturn };
