// ── Module: Inventory (Batch-wise)
// ── Role: Service

const { supabase } = require('../../config/supabase');
const { hasLooseUnits } = require('../../config/capabilities');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const { ilikeTerm } = require('../../utils/postgrest');
const logger = require('../../utils/logger');

const VALID_REASONS = ['purchase_receipt','opening_stock','sale','return_inward','return_outward','adjustment','expiry_writeoff','strip_opened'];

// loose_unit_ledger's own CHECK. Deliberately shorter than the sealed list:
// loose stock is never delivered by a distributor ('purchase_receipt') and
// cannot be sent back to one ('return_outward') — it only ever comes into
// existence by opening a pack here.
const VALID_LOOSE_REASONS = ['strip_opened','sale','return_inward','adjustment','expiry_writeoff'];

// ────────────────────────────────────────────────
// BATCHES — READ
// ────────────────────────────────────────────────

async function listBatchesForMedicine(medicineId, { includeExpired = false } = {}) {
  let query = supabase
    .from('batches_with_stock')
    .select('*')
    .eq('medicine_id', medicineId)
    .order('exp_date', { ascending: true });

  if (!includeExpired) query = query.gte('exp_date', new Date().toISOString().slice(0, 10));

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch batches.', 500, 'DB_ERROR');
  return data;
}

// FEFO: batches with stock > 0, nearest expiry first
// Used by Billing module — tells it which batch to sell from
//
// "Has stock" now means sealed OR loose. A batch whose last pack has been
// opened holds no sealed units but may still have eight tablets on the shelf,
// and dropping it here would both hide sellable stock and — because it is the
// nearest-expiry batch — quietly break FEFO for the loose pool.
async function getAvailableBatchesFEFO(medicineId) {
  // Both the extra columns and the loose half of the filter are dropped where
  // schema-27 has not been run — referencing either fails the whole query, and
  // a sale that cannot resolve a batch is a till that cannot take money. With
  // them absent the allocator sees no splittable batch and behaves exactly as
  // it did before Module 27.
  const migrated = await hasLooseUnits();

  let query = supabase
    .from('batches_with_stock')
    .select(
      migrated
        ? 'id, batch_no, exp_date, mrp, selling_price, stock_qty, expiry_status, sealed_qty, loose_qty, effective_content_quantity, effective_content_unit, loose_sale_supported'
        : 'id, batch_no, exp_date, mrp, selling_price, stock_qty, expiry_status'
    )
    .eq('medicine_id', medicineId)
    .gte('exp_date', new Date().toISOString().slice(0, 10)) // exclude expired
    .order('exp_date', { ascending: true });

  query = migrated
    ? query.or('stock_qty.gt.0,loose_qty.gt.0')
    : query.gt('stock_qty', 0);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch available batches.', 500, 'DB_ERROR');
  return data;
}

async function getBatchById(batchId) {
  const { data, error } = await supabase
    .from('batches_with_stock')
    .select('*')
    .eq('id', batchId)
    .single();

  if (error || !data) throw new AppError('Batch not found.', 404, 'BATCH_NOT_FOUND');
  return data;
}

// Overview: all medicines with aggregated stock — powers the Inventory page
async function getInventoryOverview({ search, categoryId, stockFilter } = {}) {
  let query = supabase
    .from('medicines_with_stock')
    .select('*')
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (categoryId)          query = query.eq('category_id', categoryId);
  if (stockFilter === 'low') query = query.eq('is_low_stock', true);
  if (stockFilter === 'out') query = query.lte('total_stock', 0);
  if (stockFilter === 'near_expiry') query = query.gt('near_expiry_batch_count', 0);
  if (search?.trim()) {
    const term = ilikeTerm(search);
    query = query.or(`name.ilike.${term},generic_name.ilike.${term}`);
  }

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch inventory.', 500, 'DB_ERROR');
  return data;
}

// Expired batches — owner dashboard
async function getExpiredBatches() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('batches_with_stock')
    .select('*')
    .lt('exp_date', today)
    .gt('stock_qty', 0)  // expired but still has physical stock
    .order('exp_date', { ascending: true });

  if (error) throw new AppError('Failed to fetch expired batches.', 500, 'DB_ERROR');
  return data;
}

// ────────────────────────────────────────────────
// BATCHES — WRITE
// ────────────────────────────────────────────────

async function addBatch({ medicine_id, batch_no, mfg_date, exp_date, unit_cost, mrp, selling_price, supplier_id, po_id, opening_qty, content_quantity, content_unit }, createdBy, reason = 'purchase_receipt') {
  // Verify medicine exists
  const { data: med } = await supabase.from('medicines').select('id, name').eq('id', medicine_id).single();
  if (!med) throw new AppError('Medicine not found.', 404, 'MEDICINE_NOT_FOUND');

  // Validate selling_price ≤ mrp (Indian law)
  if (parseFloat(selling_price) > parseFloat(mrp)) {
    throw new AppError('Selling price cannot exceed MRP (Indian pharmacy law).', 422, 'PRICE_EXCEEDS_MRP');
  }

  // Validate exp_date is in the future
  if (exp_date <= new Date().toISOString().slice(0, 10)) {
    throw new AppError('Batch expiry date must be in the future.', 422, 'EXPIRED_BATCH');
  }

  const { data: batch, error } = await supabase
    .from('inventory_batches')
    .insert({
      medicine_id, batch_no: batch_no.trim().toUpperCase(), mfg_date: mfg_date || null, exp_date,
      unit_cost, mrp, selling_price, supplier_id: supplier_id || null, po_id: po_id || null,
      // What is inside one unit of THIS batch, when it differs from the
      // catalogue's standard pack (a run of 15s under a medicine listed as
      // 10s). Left null, the medicine's own pack applies.
      content_quantity: content_quantity ?? null,
      content_unit: content_unit ?? null,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError(`Batch "${batch_no}" already exists for this medicine.`, 409, 'DUPLICATE_BATCH');
    throw new AppError('Failed to create batch.', 500, 'DB_ERROR');
  }

  // Write the opening/receipt ledger entry
  if (opening_qty > 0) {
    await appendLedger({ batch_id: batch.id, change_qty: opening_qty, reason, note: reason === 'opening_stock' ? 'Opening stock entry' : null, created_by: createdBy });
  }

  await logAudit(createdBy, 'batch_created', { batchId: batch.id, medicineId: medicine_id, batchNo: batch_no, qty: opening_qty });
  logger.info({ createdBy, batchId: batch.id, medicineId: medicine_id }, 'Batch added');
  return { ...batch, stock_qty: opening_qty };
}

// ────────────────────────────────────────────────
// LEDGER — WRITE (core — called by multiple modules)
// ────────────────────────────────────────────────

async function appendLedger({ batch_id, change_qty, reason, ref_id, note, created_by }) {
  if (!VALID_REASONS.includes(reason)) throw new AppError(`Invalid ledger reason: ${reason}`, 422, 'INVALID_REASON');
  if (!note && (reason === 'adjustment' || reason === 'expiry_writeoff')) {
    throw new AppError('A note is required for adjustments and write-offs.', 422, 'NOTE_REQUIRED');
  }

  const { data, error } = await supabase
    .from('inventory_ledger')
    .insert({ batch_id, change_qty, reason, ref_id: ref_id || null, note: note || null, created_by })
    .select()
    .single();

  if (error) {
    if (error.message?.includes('INSUFFICIENT_STOCK')) throw new AppError('Insufficient stock in this batch.', 409, 'INSUFFICIENT_STOCK');
    throw new AppError('Failed to record stock movement.', 500, 'DB_ERROR');
  }

  return data;
}

// ────────────────────────────────────────────────
// LOOSE LEDGER — WRITE (Module 27)
// ────────────────────────────────────────────────

// The loose twin of appendLedger. Same shape, same guarantees, a different
// denomination: change_qty here counts content units (tablets), not packs.
//
// Both of the DB's refusals are mapped rather than surfaced raw. NOT_SPLITTABLE
// is the interesting one — it means nobody has recorded what is inside this
// pack, and the trigger would rather refuse than assume a size.
async function appendLooseLedger({ batch_id, change_qty, reason, ref_id, note, created_by }) {
  if (!VALID_LOOSE_REASONS.includes(reason)) throw new AppError(`Invalid loose ledger reason: ${reason}`, 422, 'INVALID_REASON');
  if (!note && (reason === 'adjustment' || reason === 'expiry_writeoff')) {
    throw new AppError('A note is required for adjustments and write-offs.', 422, 'NOTE_REQUIRED');
  }

  const { data, error } = await supabase
    .from('loose_unit_ledger')
    .insert({ batch_id, change_qty, reason, ref_id: ref_id || null, note: note || null, created_by })
    .select()
    .single();

  if (error) {
    if (error.message?.includes('INSUFFICIENT_LOOSE_STOCK')) {
      throw new AppError('Not enough loose units in this batch.', 409, 'INSUFFICIENT_LOOSE_STOCK');
    }
    if (error.message?.includes('NOT_SPLITTABLE')) {
      throw new AppError(
        'This batch has no recorded pack contents, so it cannot be split. Set the pack size on the medicine first.',
        422, 'NOT_SPLITTABLE'
      );
    }
    throw new AppError('Failed to record loose stock movement.', 500, 'DB_ERROR');
  }

  return data;
}

// ────────────────────────────────────────────────
// MANUAL STOCK ADJUSTMENT (owner only)
// ────────────────────────────────────────────────

// `denomination` defaults to 'sealed', so every existing caller and every
// existing request body behaves exactly as before. 'loose' is what corrects a
// miscount of opened tablets — the recovery path for the states no automated
// flow can produce but a shop floor still can.
async function adjustStock({ batch_id, adjustment_qty, note, denomination = 'sealed' }, requestingUserId) {
  if (adjustment_qty === 0) throw new AppError('Adjustment quantity cannot be zero.', 422, 'ZERO_ADJUSTMENT');
  if (!note?.trim()) throw new AppError('Adjustment note is required.', 422, 'NOTE_REQUIRED');
  if (!['sealed', 'loose'].includes(denomination)) {
    throw new AppError('Denomination must be sealed or loose.', 422, 'INVALID_DENOMINATION');
  }

  // Verify batch exists
  await getBatchById(batch_id);

  const append = denomination === 'loose' ? appendLooseLedger : appendLedger;
  const entry = await append({
    batch_id, change_qty: adjustment_qty,
    reason: 'adjustment', note: note.trim(), created_by: requestingUserId
  });

  await logAudit(requestingUserId, 'stock_adjusted', { batchId: batch_id, qty: adjustment_qty, note, denomination });
  logger.info({ requestedBy: requestingUserId, batchId: batch_id, adjustmentQty: adjustment_qty, denomination }, 'Stock adjusted');
  return entry;
}

// ────────────────────────────────────────────────
// EXPIRY WRITE-OFF (owner only)
// ────────────────────────────────────────────────

// Both pools go, in one call. Loose tablets expire on exactly the same date as
// the pack they came out of — leaving them behind would strand stock that is
// unsellable, invisible to the sealed write-off, and still counted as an asset.
async function writeOffExpiredBatch(batchId, requestingUserId) {
  const batch = await getBatchById(batchId);
  const today = new Date().toISOString().slice(0, 10);
  const looseQty = Number(batch.loose_qty) || 0;

  if (batch.exp_date >= today) throw new AppError('Batch has not expired yet. Use stock adjustment if needed.', 422, 'BATCH_NOT_EXPIRED');
  if (batch.stock_qty <= 0 && looseQty <= 0) throw new AppError('Batch has no stock to write off.', 422, 'NO_STOCK_TO_WRITEOFF');

  const noteFor = (qty, unit) =>
    `Expired batch written off. Batch: ${batch.batch_no}. Expiry: ${batch.exp_date}. ${unit}: ${qty}`;

  let entry = null;
  if (batch.stock_qty > 0) {
    entry = await appendLedger({
      batch_id: batchId, change_qty: -batch.stock_qty,
      reason: 'expiry_writeoff',
      note: noteFor(batch.stock_qty, 'Units'),
      created_by: requestingUserId
    });
  }

  let looseEntry = null;
  if (looseQty > 0) {
    looseEntry = await appendLooseLedger({
      batch_id: batchId, change_qty: -looseQty,
      reason: 'expiry_writeoff',
      note: noteFor(looseQty, 'Loose units'),
      created_by: requestingUserId
    });
  }

  await logAudit(requestingUserId, 'batch_written_off', { batchId, batchNo: batch.batch_no, qty: batch.stock_qty, looseQty });
  logger.info({ requestedBy: requestingUserId, batchId, qty: batch.stock_qty, looseQty }, 'Expired batch written off');
  return { ...(entry || {}), looseEntry, batch };
}

// ────────────────────────────────────────────────
// LEDGER HISTORY
// ────────────────────────────────────────────────

async function getLedgerMovements({ batchId, medicineId, reason, limit = 50, page = 1 } = {}) {
  const offset = (page - 1) * limit;

  // inventory_batches!inner: without !inner, PostgREST applies filters on an
  // embedded resource to the embed only — the medicineId filter was silently
  // ignored and every ledger row came back. batch_id is NOT NULL, so the
  // inner join never drops legitimate rows.
  let query = supabase
    .from('inventory_ledger')
    .select(`*, inventory_batches!inner(batch_no, exp_date, medicine_id, medicines(name, unit)), users(full_name)`, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (batchId)    query = query.eq('batch_id', batchId);
  if (reason)     query = query.eq('reason', reason);
  if (medicineId) query = query.eq('inventory_batches.medicine_id', medicineId);

  const { data, error, count } = await query;
  if (error) throw new AppError('Failed to fetch ledger movements.', 500, 'DB_ERROR');
  return { movements: data, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

// ────────────────────────────────────────────────
// LOOSE LEDGER HISTORY
// ────────────────────────────────────────────────

// Kept separate from getLedgerMovements rather than unioned into it. The
// sealed endpoint embeds inventory_batches and users through PostgREST foreign
// keys, which a UNION view has none of — and the sealed side of every opening
// already appears there as a 'strip_opened' row, so the two together tell the
// whole story without either one losing its joins.
async function getLooseMovements(batchId, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('loose_unit_ledger')
    .select('*, users(full_name)')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new AppError('Failed to fetch loose stock movements.', 500, 'DB_ERROR');
  return data;
}

module.exports = {
  getInventoryOverview, listBatchesForMedicine, getAvailableBatchesFEFO,
  getBatchById, getExpiredBatches, addBatch, adjustStock,
  writeOffExpiredBatch, getLedgerMovements, appendLedger,
  appendLooseLedger, getLooseMovements,
};
