// ── Module: Inventory (Batch-wise)
// ── Role: Service

const { supabase } = require('../../config/supabase');
const { hasLooseUnits } = require('../../config/capabilities');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const { applySearch, paginationMeta } = require('../../utils/postgrest');
const { getISTDateString } = require('../../utils/date');
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

// What a staff session may see of a batch (criterion A9): the fields
// BatchDrawer's batch card renders for staff, and nothing else. An ALLOW-list,
// so a column added to batches_with_stock later stays out of staff responses
// until someone decides otherwise — the direction an accident should fail in.
// unit_cost, supplier_id, po_id and created_by are the reason it exists.
const STAFF_BATCH_COLUMNS = [
  'id', 'medicine_id', 'batch_no', 'mfg_date', 'exp_date', 'mrp', 'selling_price',
  'medicine_name', 'medicine_unit', 'stock_qty', 'expiry_status',
];
// schema-27's columns, requested only where that migration is present — the
// same gate getAvailableBatchesFEFO uses.
const STAFF_LOOSE_BATCH_COLUMNS = [
  'sealed_qty', 'loose_qty', 'effective_content_quantity', 'effective_content_unit', 'loose_sale_supported',
];

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

/**
 * Every batch of one medicine, shaped by who is asking.
 *
 * `actor` is req.user and is REQUIRED. An optional actor would let a future
 * caller leave it out and quietly receive the owner's view, cost included.
 */
async function listBatchesForMedicine(medicineId, actor, { includeExpired = false } = {}) {
  if (!actor?.role) throw new AppError('Authorisation context missing.', 500, 'ACTOR_REQUIRED');
  const isOwner = actor.role === 'owner';
  const staffColumns = isOwner
    ? null
    : [...STAFF_BATCH_COLUMNS, ...((await hasLooseUnits()) ? STAFF_LOOSE_BATCH_COLUMNS : [])];

  let query = supabase
    .from('batches_with_stock')
    .select(isOwner ? '*' : staffColumns.join(', '))
    .eq('medicine_id', medicineId)
    .order('exp_date', { ascending: true });

  if (!includeExpired) query = query.gte('exp_date', getISTDateString());

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch batches.', 500, 'DB_ERROR');
  if (isOwner) return data;
  // The select already keeps cost inside Postgres. This keeps it out of the
  // response even if that select is ever widened back to '*'.
  return (data || []).map((row) => pick(row, staffColumns));
}

// What the FEFO allocator (billing/fefo.js) reads from a batch. Shared by the
// single-medicine and the bulk lookup so the two cannot drift apart.
const FEFO_COLUMNS = 'id, batch_no, exp_date, mrp, selling_price, stock_qty, expiry_status';
const FEFO_LOOSE_COLUMNS = `${FEFO_COLUMNS}, sealed_qty, loose_qty, effective_content_quantity, effective_content_unit, loose_sale_supported`;

/* Which batch is sold first. Nearest expiry first (FEFO); among batches with
   the SAME expiry, the one entered first (created_at), then id so the order
   is total.

   created_at is when the batch row was written — the column default now(),
   set on every path (manual entry, purchase receipt, invoice approval) — NOT
   when the goods physically arrived. Batches written in one transaction (one
   receipt, one invoice) share it, and id decides between them. This rule is
   for determinism; no business rule for equal-expiry batches has been
   defined, and choosing one (receipt order, price) is the owner's decision.

   Same-expiry batches are common, not an edge case: invoice import normalises
   every expiry to the last day of its month. Ordered by exp_date alone, their
   order was whatever the query plan produced — and it differs between plans:
   on PostgreSQL 16 the single-medicine and the bulk query returned tied
   batches in different orders for about a third of medicines. Those batches
   can carry different prices, so the plan was choosing what a bill charged.
   A total order makes the choice the same on every path and every run. */
const fefoOrder = (query) => query
  .order('exp_date', { ascending: true })
  .order('created_at', { ascending: true })
  .order('id', { ascending: true });

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

  let query = fefoOrder(supabase
    .from('batches_with_stock')
    .select(migrated ? FEFO_LOOSE_COLUMNS : FEFO_COLUMNS)
    .eq('medicine_id', medicineId)
    .gte('exp_date', getISTDateString())); // exclude expired

  query = migrated
    ? query.or('stock_qty.gt.0,loose_qty.gt.0')
    : query.gt('stock_qty', 0);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch available batches.', 500, 'DB_ERROR');
  return data;
}

// Medicine ids per request. Keeps the `in.(…)` list well inside URL limits for
// the largest cart a 10kb JSON body can carry; a normal bill is one request.
const FEFO_IN_CHUNK = 100;
// A runaway guard for the paged fallback below, not a business limit.
const FEFO_MAX_PAGES = 50;

/* The one error this lookup raises. When the DATABASE refused the query, the
   PostgREST error rides along as `fefoQueryError`, so a caller can tell "the
   read failed" from "the read came back but cannot be trusted" (no row count,
   too many pages) — and log the cause. It never reaches the HTTP response:
   errorHandler serialises only code, message and details. */
const fefoLookupFailed = (queryError) => Object.assign(
  new AppError('Failed to fetch available batches.', 500, 'DB_ERROR'),
  queryError ? { fefoQueryError: queryError } : {}
);

/**
 * getAvailableBatchesFEFO for a whole cart: the same filter, columns and
 * order, one query for every medicine instead of one query each. Returns a Map
 * holding an entry for EVERY requested id, in the order given — an empty array
 * for a medicine with nothing on sale.
 *
 * Grouping keeps each medicine's rows in the order the query returned them, so
 * every group is in fefoOrder, exactly as getAvailableBatchesFEFO returns it.
 *
 * NEVER SILENTLY TRUNCATED. PostgREST caps a response at the project's
 * max_rows (1000 by default on Supabase, and configurable), and a cut list
 * would read as "insufficient stock". Without a count a capped response is
 * indistinguishable from a complete one (Content-Range: 0-999/*), so the exact
 * count travels in the same request; when it says rows were withheld, the rest
 * are read in pages of the size the server just proved it returns, continuing
 * in the same total order.
 *
 * The count is not free: to produce it PostgREST evaluates the filtered view a
 * second time in the same statement.
 */
async function getAvailableBatchesFEFOForMedicines(medicineIds) {
  const ids = [...new Set(medicineIds || [])];
  const groups = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return groups;

  const migrated = await hasLooseUnits();
  const today = getISTDateString();

  const scope = (part, options) => {
    const query = fefoOrder(supabase
      .from('batches_with_stock')
      .select(`medicine_id, ${migrated ? FEFO_LOOSE_COLUMNS : FEFO_COLUMNS}`, options)
      .in('medicine_id', part)
      .gte('exp_date', today)); // exclude expired, same IST "today" as the single lookup
    return migrated ? query.or('stock_qty.gt.0,loose_qty.gt.0') : query.gt('stock_qty', 0);
  };

  for (let i = 0; i < ids.length; i += FEFO_IN_CHUNK) {
    const part = ids.slice(i, i + FEFO_IN_CHUNK);
    const { data, error, count } = await scope(part, { count: 'exact' });
    if (error) throw fefoLookupFailed(error);

    const rows = data || [];
    if (!Number.isFinite(count)) {
      // Asked for, so its absence means the response cannot vouch for itself.
      logger.error({ medicines: part.length, rows: rows.length }, 'FEFO batch lookup returned no row count');
      throw fefoLookupFailed();
    }

    if (count > rows.length) {
      const pageSize = rows.length;
      if (!pageSize || Math.ceil(count / pageSize) > FEFO_MAX_PAGES) {
        logger.error({ medicines: part.length, count, pageSize }, 'FEFO batch lookup cannot be paged safely');
        throw fefoLookupFailed();
      }
      logger.warn({ medicines: part.length, count, pageSize }, 'FEFO batch lookup exceeded the row cap; paging');

      // The first response is page one of the same total order, so reading
      // continues after it. Pages are separate requests, so a sale between two
      // of them can shift a row across a page boundary; de-duplicating by id
      // keeps one copy. The read is advisory either way — create_bill_atomic
      // re-checks every batch.
      const seen = new Set(rows.map((row) => row.id));
      for (let page = 2, offset = pageSize; ; page += 1, offset += pageSize) {
        const { data: more, error: pageError } = await scope(part).range(offset, offset + pageSize - 1);
        if (pageError) throw fefoLookupFailed(pageError);
        for (const row of more || []) {
          if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
        }
        if (!more || more.length < pageSize || rows.length >= count) break;
        if (page >= FEFO_MAX_PAGES) {
          logger.error({ medicines: part.length, count, pageSize }, 'FEFO batch lookup exceeded the page guard');
          throw fefoLookupFailed();
        }
      }
    }

    for (const row of rows) groups.get(row.medicine_id)?.push(row);
  }

  return groups;
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

// Matches listMedicines. The two searched different column sets — inventory
// two, medicines three — which meant a manufacturer name found a medicine on
// one screen and nothing on the other.
const INVENTORY_SEARCH_COLUMNS = ['name', 'generic_name', 'manufacturer'];

/**
 * The set of medicines this request is ABOUT, before the stock filter narrows
 * it — the population the chip counts describe.
 *
 * A FACTORY, not a shared builder. postgrest-js filter methods mutate the
 * builder's own URL in place and return `this`, so reusing one instance across
 * the five parallel queries below would have each inherit the previous one's
 * filters and every count would be wrong in a different direction.
 */
function overviewScope({ search, categoryId }, columns, options) {
  let q = supabase.from('medicines_with_stock').select(columns, options).eq('is_active', true);
  if (categoryId) q = q.eq('category_id', categoryId);
  return applySearch(q, search, INVENTORY_SEARCH_COLUMNS);
}

/**
 * One page of the catalogue with stock, plus the counts the alert chips need.
 *
 * The stats are scoped to `search` and `categoryId` but NOT to `stockFilter`,
 * and that is load-bearing rather than an oversight: the chips SET the stock
 * filter, so a count narrowed by it would redraw the moment you clicked one —
 * "12 running low" would become low=12, out=0, near=0 and the other two chips
 * would vanish. A control cannot be used to navigate if using it changes what
 * it says.
 */
async function getInventoryOverview({ search, categoryId, stockFilter, page = 1, limit = 30 } = {}) {
  const HEAD = { count: 'exact', head: true };
  const offset = (page - 1) * limit;
  const scope = { search, categoryId };

  // `.order('id')` is not decoration. medicines.name is not unique — only
  // (name, manufacturer, pack) is — so name alone is a partial order, and a
  // partial order under LIMIT/OFFSET repeats rows on one page and drops them
  // from another.
  let rowsQuery = overviewScope(scope, '*', { count: 'exact' })
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  // `is_low_stock` is `coalesce(total_stock,0) < low_stock_threshold`, which is
  // TRUE at zero stock — so "low" silently included "out". domain/stock.js says
  // out wins over low, so without the guard the chip would read N and filter to
  // a list of N + out rows.
  if (stockFilter === 'low')         rowsQuery = rowsQuery.eq('is_low_stock', true).gt('total_stock', 0);
  if (stockFilter === 'out')         rowsQuery = rowsQuery.lte('total_stock', 0);
  if (stockFilter === 'near_expiry') rowsQuery = rowsQuery.gt('near_expiry_batch_count', 0);

  const [rowsRes, totalRes, outRes, lowRes, nearRes] = await Promise.all([
    rowsQuery,
    overviewScope(scope, '*', HEAD),
    overviewScope(scope, '*', HEAD).lte('total_stock', 0),
    overviewScope(scope, '*', HEAD).eq('is_low_stock', true).gt('total_stock', 0),
    overviewScope(scope, '*', HEAD).gt('near_expiry_batch_count', 0),
  ]);

  if (rowsRes.error) throw new AppError('Failed to fetch inventory.', 500, 'DB_ERROR');

  // A failed COUNT must not take the list down — the same rule listSuppliers
  // already applies to its balance merge. null renders as an absent chip,
  // which is honest; 0 would be a claim.
  const n = (res) => (res.error ? null : res.count ?? 0);

  return {
    inventory: rowsRes.data,
    pagination: paginationMeta(page, limit, rowsRes.count),
    stats: { total: n(totalRes), out: n(outRes), low: n(lowRes), near: n(nearRes) },
  };
}

// Expired batches — owner dashboard
async function getExpiredBatches() {
  const today = getISTDateString();
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
  if (exp_date <= getISTDateString()) {
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
  const today = getISTDateString();
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
  getAvailableBatchesFEFOForMedicines,
  getBatchById, getExpiredBatches, addBatch, adjustStock,
  writeOffExpiredBatch, getLedgerMovements, appendLedger,
  appendLooseLedger, getLooseMovements,
};
