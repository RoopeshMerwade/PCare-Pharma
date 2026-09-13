// ── Module 14: Expiry Management Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const { appendLedger } = require('../inventory/inventory.service');
const { paginationMeta } = require('../../utils/postgrest');
const logger = require('../../utils/logger');

const URGENCIES = ['expired', 'critical', 'warning', 'watch'];

/**
 * Counts and the value at risk. Deliberately returns NO rows.
 *
 * The four bucket ARRAYS are gone — the page now pages each bucket from
 * getExpiryBatches, and shipping every batch in the pharmacy so the client
 * could call .length on four arrays was the whole weight of this endpoint.
 *
 * Two columns rather than `*` because PostgREST has no SUM and
 * `potential_loss` must stay exact to the paisa. This is the one whole-table
 * read that survives the refactor, and it is now ~2 numbers per batch instead
 * of ~30. The bucket counts then come from that same array for free, rather
 * than costing four more round trips.
 *
 * `urgency` is a real column on the view (a CASE over exp_date), so the
 * bucketing here is the database's, unchanged — not a second derivation.
 */
async function getExpiryDashboard() {
  const { data, error } = await supabase
    .from('expiry_summary')
    .select('urgency, potential_loss_value')
    .neq('urgency', 'ok');
  if (error) throw new AppError('Failed to fetch expiry data.', 500, 'DB_ERROR');

  const totals = { expired: 0, critical: 0, warning: 0, watch: 0, potential_loss: 0 };
  for (const b of data || []) {
    if (totals[b.urgency] !== undefined) totals[b.urgency] += 1;
    totals.potential_loss += parseFloat(b.potential_loss_value || 0);
  }

  return { totals };
}

/**
 * One page of one urgency bucket.
 *
 * The explicit .order() is required, not cosmetic. expiry_summary carries
 * `order by exp_date asc` INSIDE its own definition, and Postgres does not
 * guarantee a view's ORDER BY survives an outer LIMIT/OFFSET — under paging an
 * unstable sort silently repeats rows on one page and drops them from another.
 * `.order('id')` then makes it total: exp_date is nowhere near unique.
 *
 * `total_loss_value` is gone from this response. It was a sum over every row
 * of the bucket; as a per-page figure it would be a lie about the page. The
 * whole-bucket number lives in getExpiryDashboard().totals.potential_loss.
 */
async function getExpiryBatches({ urgency, page = 1, limit = 30 } = {}) {
  if (!URGENCIES.includes(urgency)) {
    throw new AppError(`Urgency must be one of: ${URGENCIES.join(', ')}`, 422, 'INVALID_URGENCY');
  }
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from('expiry_summary')
    .select('*', { count: 'exact' })
    .eq('urgency', urgency)
    .order('exp_date', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw new AppError('Failed to fetch batches.', 500, 'DB_ERROR');
  return { batches: data || [], pagination: paginationMeta(page, limit, count) };
}

/** Kept so GET /expiry/urgency/:urgency — a documented route in the generated
 *  Postman collection — keeps answering. */
async function getBatchesByUrgency(urgency) {
  return getExpiryBatches({ urgency });
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
  // Three columns, not `*` — writeOffBatch re-reads the batch itself, so
  // everything else on the row was fetched and thrown away.
  const { data: expired } = await supabase.from('expiry_summary')
    .select('id, stock_qty, unit_cost').eq('urgency', 'expired').gt('stock_qty', 0);
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

module.exports = { getExpiryDashboard, getExpiryBatches, getBatchesByUrgency, writeOffBatch, bulkWriteOffExpired, getExpiryReport, URGENCIES };
