// ── Module 14: Expiry Management Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const { appendLedger } = require('../inventory/inventory.service');
const logger = require('../../utils/logger');

// ── EXPIRY DASHBOARD (all batches with stock, grouped by urgency)
async function getExpiryDashboard() {
  const { data, error } = await supabase.from('expiry_summary').select('*').order('exp_date', { ascending: true });
  if (error) throw new AppError('Failed to fetch expiry data.', 500, 'DB_ERROR');

  const summary = { expired: [], critical: [], warning: [], watch: [], ok: [] };
  const totals  = { expired: 0, critical: 0, warning: 0, watch: 0, potential_loss: 0 };

  data.forEach(b => {
    const bucket = b.urgency;
    if (summary[bucket]) summary[bucket].push(b);
    if (bucket !== 'ok') {
      totals[bucket] = (totals[bucket] || 0) + 1;
      totals.potential_loss += parseFloat(b.potential_loss_value || 0);
    }
  });

  return { summary, totals };
}

// ── FILTER BY URGENCY
async function getBatchesByUrgency(urgency) {
  const valid = ['expired','critical','warning','watch'];
  if (!valid.includes(urgency)) throw new AppError(`Urgency must be one of: ${valid.join(', ')}`, 422, 'INVALID_URGENCY');

  const { data, error } = await supabase.from('expiry_summary').select('*').eq('urgency', urgency).order('exp_date', { ascending: true });
  if (error) throw new AppError('Failed to fetch batches.', 500, 'DB_ERROR');
  return { batches: data, count: data.length, total_loss_value: data.reduce((s,b) => s + parseFloat(b.potential_loss_value||0), 0) };
}

// ── WRITE OFF EXPIRED BATCH (delegates to inventory module)
async function writeOffBatch(batchId, userId) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: batch } = await supabase.from('batches_with_stock').select('*').eq('id', batchId).single();
  if (!batch) throw new AppError('Batch not found.', 404, 'BATCH_NOT_FOUND');
  if (batch.exp_date >= today) throw new AppError('Batch has not expired yet.', 422, 'BATCH_NOT_EXPIRED');
  if (batch.stock_qty <= 0) throw new AppError('No stock remaining in this batch.', 422, 'NO_STOCK');

  const ledgerEntry = await appendLedger({
    batch_id: batchId, change_qty: -batch.stock_qty, reason: 'expiry_writeoff',
    note: `Expiry write-off: ${batch.batch_no} (expired ${batch.exp_date}). Units: ${batch.stock_qty}. Value: ₹${(batch.stock_qty * batch.unit_cost).toFixed(2)}`,
    created_by: userId
  });

  await logAudit(userId, 'expiry_writeoff', { batchId, batchNo: batch.batch_no, qty: batch.stock_qty, valueWrittenOff: batch.stock_qty * batch.unit_cost });
  logger.info({ userId, batchId, qty: batch.stock_qty }, 'Expiry write-off');
  return { ledgerEntry, batch: { ...batch, stock_qty: 0 } };
}

// ── BULK WRITE-OFF (all expired batches with stock)
async function bulkWriteOffExpired(userId) {
  const { data: expired } = await supabase.from('expiry_summary').select('*').eq('urgency', 'expired').gt('stock_qty', 0);
  if (!expired?.length) return { written_off: 0, total_value: 0 };

  let totalValue = 0;
  for (const batch of expired) {
    await writeOffBatch(batch.id, userId);
    totalValue += batch.stock_qty * parseFloat(batch.unit_cost);
  }

  return { written_off: expired.length, total_value: totalValue };
}

// ── EXPIRY REPORT (summary for period)
async function getExpiryReport() {
  const today = new Date().toISOString().slice(0,10);
  const d90 = new Date(); d90.setDate(d90.getDate() + 90);

  const { data } = await supabase.from('expiry_summary').select('urgency, potential_loss_value, medicine_name, batch_no, exp_date, stock_qty, unit').order('exp_date');

  const report = { generated_at: new Date().toISOString(), today, batches_expiring_90d: data.filter(b=>b.urgency!=='ok'), total_at_risk_value: data.reduce((s,b) => b.urgency!=='ok' ? s + parseFloat(b.potential_loss_value||0) : s, 0) };
  return report;
}

module.exports = { getExpiryDashboard, getBatchesByUrgency, writeOffBatch, bulkWriteOffExpired, getExpiryReport };
