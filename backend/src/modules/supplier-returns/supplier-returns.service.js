// ── Module 13: Supplier Returns Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { mapDbError } = require('../../utils/dbErrors');
const { logAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

// ── READ
async function listSupplierReturns({ supplierId, status, page=1, limit=30 } = {}) {
  const offset = (page-1)*limit;
  let q = supabase.from('supplier_returns_with_totals').select('*', { count:'exact' })
    .order('created_at', { ascending:false }).range(offset, offset+limit-1);
  if (supplierId) q = q.eq('supplier_id', supplierId);
  if (status)     q = q.eq('status', status);
  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch supplier returns.', 500, 'DB_ERROR');
  return { returns: data, pagination: { page, limit, total: count, pages: Math.ceil(count/limit) } };
}

async function getSupplierReturnById(id) {
  const { data, error } = await supabase.from('supplier_returns_with_totals').select('*').eq('id', id).single();
  if (error || !data) throw new AppError('Return not found.', 404, 'RETURN_NOT_FOUND');
  const { data: items } = await supabase.from('supplier_return_items')
    .select('*, medicines(name, unit), inventory_batches(batch_no, exp_date)').eq('return_id', id);
  return { ...data, items: items||[] };
}

// ── CREATE SUPPLIER RETURN
async function createSupplierReturn({ supplier_id, purchase_id, reason, notes, items }, userId) {
  if (!items?.length) throw new AppError('At least one item is required.', 422, 'NO_ITEMS');

  // Validate each batch belongs to this supplier and has enough stock
  for (const item of items) {
    const { data: batch } = await supabase.from('batches_with_stock').select('*').eq('id', item.batch_id).single();
    if (!batch) throw new AppError(`Batch ${item.batch_id} not found.`, 404, 'BATCH_NOT_FOUND');
    if (batch.stock_qty < item.qty_returned) throw new AppError(`Insufficient stock in batch ${batch.batch_no}. Available: ${batch.stock_qty}.`, 409, 'INSUFFICIENT_STOCK');
    item._batch = batch;
  }

  const { data: rn } = await supabase.rpc('next_supplier_return_number');
  const debitTotal = items.reduce((s,i) => s + i.qty_returned * (i._batch.unit_cost||0), 0);

  const { data: sr, error } = await supabase.from('supplier_returns')
    .insert({ return_number: rn, supplier_id, purchase_id: purchase_id||null, reason: reason.trim(), debit_note_amount: debitTotal, notes: notes?.trim()||null, created_by: userId })
    .select().single();
  if (error) throw new AppError('Failed to create supplier return.', 500, 'DB_ERROR');

  // Insert return items
  await supabase.from('supplier_return_items').insert(
    items.map(i => ({ return_id: sr.id, batch_id: i.batch_id, medicine_id: i._batch.medicine_id, qty_returned: i.qty_returned, unit_cost: i._batch.unit_cost }))
  );

  await logAudit(userId, 'supplier_return_created', { returnId: sr.id, supplierId: supplier_id, debitTotal });
  return await getSupplierReturnById(sr.id);
}

// ── SEND (owner confirms — posts ledger + debit note)
// Atomic: the RPC claims draft → sent (no concurrent double-send), posts the
// outward ledger entries, and stores debit_note_amount on the return row in
// one transaction. The old code additionally wrote to a "billing_cycles"
// table that exists in no migration — that insert failed silently on every
// send and has been removed; supplier outstanding is derived from views.
async function sendSupplierReturn(id, userId) {
  const { data: debitAmount, error } = await supabase.rpc('send_supplier_return_atomic', {
    p_return_id: id,
    p_user_id: userId,
  });
  if (error) {
    const mapped = mapDbError(error);
    if (mapped) {
      if (mapped.code === 'INVALID_STATUS') throw new AppError('Only draft returns can be sent.', 409, 'INVALID_STATUS');
      throw mapped;
    }
    throw new AppError('Failed to send supplier return.', 500, 'DB_ERROR');
  }

  await logAudit(userId, 'supplier_return_sent', { returnId: id, debitAmount });
  logger.info({ userId, returnId: id, debitAmount }, 'Supplier return sent');
  return await getSupplierReturnById(id);
}

// ── ACKNOWLEDGE (supplier confirms receipt)
async function acknowledgeSupplierReturn(id, userId) {
  const ret = await getSupplierReturnById(id);
  if (ret.status !== 'sent') throw new AppError('Only sent returns can be acknowledged.', 409, 'INVALID_STATUS');
  await supabase.from('supplier_returns').update({ status: 'acknowledged' }).eq('id', id);
  await logAudit(userId, 'supplier_return_acknowledged', { returnId: id });
  return await getSupplierReturnById(id);
}

module.exports = { listSupplierReturns, getSupplierReturnById, createSupplierReturn, sendSupplierReturn, acknowledgeSupplierReturn };
