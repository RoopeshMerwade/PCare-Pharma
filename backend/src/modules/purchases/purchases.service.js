// ── Module 07 + 08: Purchases & Purchase Items Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { mapDbError } = require('../../utils/dbErrors');
const { logAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

// ── READ ──────────────────────────────────────────────────

async function listPurchases({ supplierId, status, page = 1, limit = 30 } = {}) {
  const offset = (page - 1) * limit;
  let q = supabase.from('purchases_with_totals').select('*', { count: 'exact' })
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (supplierId) q = q.eq('supplier_id', supplierId);
  if (status)     q = q.eq('status', status);
  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch purchases.', 500, 'DB_ERROR');
  return { purchases: data, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function getPurchaseById(id) {
  const { data, error } = await supabase.from('purchases_with_totals').select('*').eq('id', id).single();
  if (error || !data) throw new AppError('Purchase order not found.', 404, 'PURCHASE_NOT_FOUND');
  // default_selling_price is joined so the receiving screen can pre-fill each
  // batch's selling price from the medicine's standard price. Purchases are
  // owner-only end to end (see routes), so no A9 field-gating applies here.
  const { data: items } = await supabase
    .from('purchase_items')
    .select('*, medicines(name, unit, default_selling_price)')
    .eq('purchase_id', id);
  return { ...data, items: items || [] };
}

// ── CREATE PO ─────────────────────────────────────────────

async function createPurchase({ supplier_id, expected_delivery_date, notes, items }, createdBy) {
  if (!items?.length) throw new AppError('At least one item is required.', 422, 'NO_ITEMS');

  // Generate PO number
  const { data: numData } = await supabase.rpc('next_purchase_number');
  const purchase_number = numData;

  const { data: po, error } = await supabase.from('purchases')
    .insert({ purchase_number, supplier_id, expected_delivery_date: expected_delivery_date || null, notes: notes?.trim(), created_by: createdBy })
    .select().single();
  if (error) throw new AppError('Failed to create purchase order.', 500, 'DB_ERROR');

  // Insert items
  const { error: itemErr } = await supabase.from('purchase_items').insert(
    items.map(i => ({ purchase_id: po.id, medicine_id: i.medicine_id, qty_ordered: i.qty_ordered, unit_cost: i.unit_cost }))
  );
  if (itemErr) {
    await supabase.from('purchases').delete().eq('id', po.id); // rollback
    throw new AppError('Failed to add purchase items.', 500, 'DB_ERROR');
  }

  await logAudit(createdBy, 'purchase_created', { purchaseId: po.id, purchaseNumber: purchase_number });
  return await getPurchaseById(po.id);
}

// ── UPDATE PO (only while draft) ──────────────────────────

async function updatePurchase(id, { expected_delivery_date, notes }, userId) {
  const po = await getPurchaseById(id);
  if (po.status !== 'draft') throw new AppError('Only draft purchase orders can be edited.', 409, 'NOT_DRAFT');
  const { data, error } = await supabase.from('purchases').update({ expected_delivery_date: expected_delivery_date || null, notes: notes?.trim() }).eq('id', id).select().single();
  if (error) throw new AppError('Failed to update purchase order.', 500, 'DB_ERROR');
  return data;
}

// ── STATUS TRANSITIONS ────────────────────────────────────

async function sendPurchase(id, userId) {
  const po = await getPurchaseById(id);
  if (po.status !== 'draft') throw new AppError('Only draft orders can be sent.', 409, 'INVALID_STATUS');
  const { data } = await supabase.from('purchases').update({ status: 'sent' }).eq('id', id).select().single();
  await logAudit(userId, 'purchase_sent', { purchaseId: id });
  return data;
}

async function cancelPurchase(id, userId) {
  const po = await getPurchaseById(id);
  if (po.status === 'received') throw new AppError('Received orders cannot be cancelled.', 409, 'ALREADY_RECEIVED');
  const { data } = await supabase.from('purchases').update({ status: 'cancelled' }).eq('id', id).select().single();
  await logAudit(userId, 'purchase_cancelled', { purchaseId: id });
  return data;
}

// ── RECEIVE PO (creates inventory batches + ledger entries) ─
// One transaction via receive_purchase_atomic: batches, ledger entries,
// item updates and the status flip all commit together. The FOR UPDATE
// claim inside the RPC also makes concurrent double-receiving impossible.

async function receivePurchase(id, { items, invoice_no }, userId) {
  if (!items?.length) throw new AppError('Receipt items are required.', 422, 'NO_ITEMS');

  const { error } = await supabase.rpc('receive_purchase_atomic', {
    p_purchase_id: id,
    p_user_id: userId,
    p_items: items.map(i => ({
      purchase_item_id: i.purchase_item_id,
      batch_no: i.batch_no,
      qty_received: i.qty_received,
      exp_date: i.exp_date,
      mfg_date: i.mfg_date || null,
      mrp: i.mrp ?? null,
      selling_price: i.selling_price ?? null,
    })),
    p_invoice_no: invoice_no?.trim() || null,
  });

  if (error) {
    const mapped = mapDbError(error, {
      duplicateMessage: 'One of the batch numbers already exists for that medicine.',
      duplicateCode: 'DUPLICATE_BATCH',
    });
    if (mapped) throw mapped;
    throw new AppError('Failed to receive purchase order.', 500, 'DB_ERROR');
  }

  await logAudit(userId, 'purchase_received', { purchaseId: id, batchCount: items.length, invoiceNo: invoice_no?.trim() || null });
  logger.info({ userId, purchaseId: id, invoiceNo: invoice_no }, 'Purchase received');
  return await getPurchaseById(id);
}

// ── PURCHASE ITEMS: add/remove while draft ────────────────

async function addItem(purchaseId, { medicine_id, qty_ordered, unit_cost }, userId) {
  const po = await getPurchaseById(purchaseId);
  if (po.status !== 'draft') throw new AppError('Can only add items to draft orders.', 409, 'NOT_DRAFT');
  const { data, error } = await supabase.from('purchase_items').insert({ purchase_id: purchaseId, medicine_id, qty_ordered, unit_cost }).select().single();
  if (error) throw new AppError('Failed to add item.', 500, 'DB_ERROR');
  return data;
}

async function removeItem(purchaseId, itemId, userId) {
  const po = await getPurchaseById(purchaseId);
  if (po.status !== 'draft') throw new AppError('Can only remove items from draft orders.', 409, 'NOT_DRAFT');
  await supabase.from('purchase_items').delete().eq('id', itemId).eq('purchase_id', purchaseId);
}

module.exports = { listPurchases, getPurchaseById, createPurchase, updatePurchase, sendPurchase, cancelPurchase, receivePurchase, addItem, removeItem };
