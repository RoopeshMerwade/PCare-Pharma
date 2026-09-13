// ── Modules 09+10: Billing — application service (workflows).
// Data access lives in billing.repository; pure FEFO/warning logic in fefo.js.
// Cross-module calls go through the other modules' public services only.

const repo = require('./billing.repository');
const {
  mergeCartItems, allocateCartLine, looseAvailable, supportsLooseSale, partitionWarnings,
} = require('./fefo');
const { AppError } = require('../../utils/AppError');
const { assertCanAccess } = require('../../utils/authz');
const { logAudit } = require('../../utils/audit');
const { getAvailableBatchesFEFO } = require('../inventory/inventory.service');
const { checkAdherenceWarnings, recordAcknowledgments } = require('../chronic-care/chronic-care.service');
const logger = require('../../utils/logger');

// ── READ ──────────────────────────────────────────────────

async function listBills({ search, paymentMode, dateFrom, dateTo, createdBy, page = 1, limit = 30 } = {}) {
  const { bills, count } = await repo.listBills({ search, paymentMode, dateFrom, dateTo, createdBy, page, limit });
  return { bills, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

/**
 * Load a bill with no authorisation check. INTERNAL ONLY.
 *
 * The one legitimate caller is createBill, which re-reads the bill it has just
 * written for the actor who wrote it. Not exported — every path that can be
 * reached from a request must go through getBillById.
 */
async function loadBill(id) {
  const bill = await repo.getBillWithTotals(id);
  if (!bill) throw new AppError('Bill not found.', 404, 'BILL_NOT_FOUND');
  const items = await repo.getBillItems(id);
  return { ...bill, items };
}

/**
 * Read one bill, subject to the SAME ownership rule listBills applies.
 *
 * listBills scopes staff to `created_by = <self>`, so a staff member never sees
 * a colleague's bill in a list — but the by-id read had no check at all, and a
 * bill id is a UUID in the URL of every receipt. Anyone who kept a link, or
 * guessed nothing at all and simply re-used one, could read a sale rung up by
 * somebody else: customer name, phone, and every line item.
 *
 * `actor` is req.user, derived from the verified JWT. It is REQUIRED — an
 * optional actor would let a future caller omit it and silently reopen this.
 */
async function getBillById(id, actor) {
  const bill = await loadBill(id);
  assertCanAccess(bill, actor, { label: 'bill' });
  return bill;
}

// ── Sales dashboard totals ────────────────────────────────
async function getSalesTotals(dateFrom, dateTo) {
  return await repo.getSalesTotalsSummary(dateFrom, dateTo);
}

// ── CREATE BILL (the core sell flow) ─────────────────────

async function createBill({ customer_name, customer_phone, customer_id, payment_mode, payment_status, discount_amount, notes, items, acknowledged_warnings }, createdBy) {
  if (!items?.length) throw new AppError('A bill must have at least one item.', 422, 'NO_ITEMS');

  // ── Chronic medication adherence gate ───────────────────
  // If this customer has a tracked medication schedule for something in the
  // cart and the timing looks wrong (too early / overdue), staff must
  // explicitly acknowledge before the sale proceeds. This never BLOCKS a
  // sale outright — the pharmacist's judgment stays in control — but an
  // unacknowledged warning stops the request here with 409, and the
  // frontend shows the warning modal using err.details.
  const warnings = await checkAdherenceWarnings(customer_phone, items);
  if (warnings.length) {
    const { unacknowledged } = partitionWarnings(warnings, acknowledged_warnings);
    if (unacknowledged.length) {
      throw new AppError(
        'This customer has medication timing that needs your attention before completing the sale.',
        409, 'ADHERENCE_ACK_REQUIRED', { warnings: unacknowledged }
      );
    }
  }

  // Resolve FEFO allocation per medicine. Duplicate cart lines are merged
  // first so one medicine's lines can't compete for the same batch stock.
  //
  // Sealed units and loose units are resolved together, against ONE view of
  // each batch: a strip sold whole is a strip that can no longer be opened for
  // tablets, and two independent passes would each believe they had it.
  const cart = mergeCartItems(items);
  const resolvedItems = [];
  for (const item of cart) {
    const looseQty = Number(item.loose_qty) || 0;
    const batches = await getAvailableBatchesFEFO(item.medicine_id);

    // "This product is not sold loose" and "there aren't enough of it" are
    // different problems with different remedies, so they get different errors
    // rather than one shortfall count that reads as a stock issue.
    if (looseQty > 0 && !supportsLooseSale(batches)) {
      const name = await repo.getMedicineName(item.medicine_id);
      throw new AppError(
        `"${name || item.medicine_id}" is not sold in single units — no countable pack contents are recorded for it. Sell it by the whole pack instead.`,
        422, 'LOOSE_SALE_UNSUPPORTED'
      );
    }

    const { lines, sealedShortfall, looseShortfall } = allocateCartLine(batches, { qty: item.qty, looseQty });

    if (sealedShortfall > 0) {
      const name = await repo.getMedicineName(item.medicine_id);
      throw new AppError(
        `Insufficient stock for "${name || item.medicine_id}". Available: ${item.qty - sealedShortfall}, requested: ${item.qty}.`,
        409, 'INSUFFICIENT_STOCK'
      );
    }

    if (looseShortfall > 0) {
      const name = await repo.getMedicineName(item.medicine_id);
      // looseAvailable counts what the WHOLE medicine could yield; the
      // shortfall is what is left after this line's own sealed units were
      // already committed above. Reporting both keeps the message honest when
      // a mixed line is what exhausted the stock.
      throw new AppError(
        `Insufficient loose units for "${name || item.medicine_id}". Available: ${looseAvailable(batches)}, requested: ${looseQty}.`,
        409, 'INSUFFICIENT_LOOSE_STOCK'
      );
    }

    resolvedItems.push(...lines.map((l) => ({ medicine_id: item.medicine_id, ...l })));
  }

  // A discount may not exceed the bill. bills_with_totals computes
  // total = subtotal − discount with no floor, so a larger discount stored a
  // negative sale that every sales figure then summed. create_bill_atomic
  // refuses it too (schema-39); checking here first is what lets the message
  // carry the amounts. Compared in paise, so float drift in the sum cannot
  // decide it.
  const subtotalPaise = resolvedItems.reduce((sum, line) => sum + Math.round(line.qty * line.unit_price * 100), 0);
  const discountPaise = Math.round((Number(discount_amount) || 0) * 100);
  if (discountPaise > subtotalPaise) {
    const rupees = (paise) => (paise / 100).toFixed(2);
    throw new AppError(
      `The discount (₹${rupees(discountPaise)}) cannot be more than the bill total (₹${rupees(subtotalPaise)}).`,
      422, 'DISCOUNT_EXCEEDS_TOTAL'
    );
  }

  // One transaction: bill header + items + negative ledger entries all
  // commit together. A concurrent sale that empties a batch between the
  // FEFO read and here trips the DB trigger and the WHOLE bill rolls back —
  // no half-created bills, ever.
  const billId = await repo.createBillAtomic(
    { customer_name, customer_phone, customer_id, payment_mode, payment_status, discount_amount, notes, created_by: createdBy },
    resolvedItems
  );

  // loadBill, not getBillById: the actor demonstrably owns this bill — they
  // just created it — and routing it through the guard would mean constructing
  // a fake actor object here, which is how guards get weakened.
  const bill = await loadBill(billId);

  await logAudit(createdBy, 'bill_created', {
    billId, billNumber: bill.bill_number,
    total: resolvedItems.reduce((s, i) => s + i.qty * i.unit_price, 0),
  });

  // Log which adherence warnings were shown and acknowledged for THIS sale
  if (warnings.length) await recordAcknowledgments(billId, warnings, createdBy);

  logger.info({ createdBy, billId, billNumber: bill.bill_number }, 'Bill created');
  return bill;
}

// ── DELETE (owner only, permanent — schema-38) ───────────
//
// The one exception to "a bill is forever". Deleting removes the bill, its
// lines, any rejected returns and its adherence acknowledgments. It NEVER
// touches inventory_ledger or loose_unit_ledger, so the stock a bill sold stays
// sold. Every total, report and customer figure is computed live from bills and
// bill_items, so they all follow on their own.
//
// There is no logAudit call here, on purpose: the RPC writes the audit row —
// with a snapshot of every deleted bill — in the same transaction as the
// delete. utils/audit.js is fire-and-forget, which is the wrong guarantee for
// an irreversible act.

function requireOwner(actor) {
  if (!actor || !actor.id || !actor.role) {
    throw new AppError('Authorisation context missing.', 500, 'ACTOR_REQUIRED');
  }
  if (actor.role !== 'owner') throw new AppError('Only the owner can delete bills.', 403, 'FORBIDDEN');
}

// The RPC re-checks returns under a row lock and is the final word. This read
// exists so the refusal can NAME the returns in the way, which an exception
// raised inside Postgres cannot carry.
function refuseIfBlocked(preview) {
  if (preview.blocked?.length) {
    throw new AppError(
      'Bills with a pending or approved customer return cannot be deleted.',
      409, 'BILL_HAS_RETURNS', { blocked: preview.blocked }
    );
  }
}

async function previewBillDeletion(id) {
  const preview = await repo.previewBillDeletion([id]);
  if (!preview.bill_count) throw new AppError('Bill not found.', 404, 'BILL_NOT_FOUND');
  return preview;
}

async function previewRangeDeletion(dateFrom, dateTo) {
  // YYYY-MM-DD strings (the route validates the format) compare correctly as text.
  if (dateFrom > dateTo) {
    throw new AppError('The start date must be on or before the end date.', 422, 'INVALID_DATE_RANGE');
  }
  return repo.previewRangeDeletion(dateFrom, dateTo);
}

async function deleteBill(id, reason, actor, ctx = {}) {
  requireOwner(actor);
  refuseIfBlocked(await previewBillDeletion(id));

  const result = await repo.deleteBillAtomic({
    billId: id, actorId: actor.id, reason, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  logger.info({ actorId: actor.id, billId: id, billNumbers: result.bill_numbers, total: result.total_amount },
    'Bill deleted (stock not returned)');
  return result;
}

async function deleteBillsInRange({ dateFrom, dateTo, reason, expectedCount, expectedTotal }, actor, ctx = {}) {
  requireOwner(actor);
  const preview = await previewRangeDeletion(dateFrom, dateTo);
  if (!preview.bill_count) throw new AppError('There are no bills in that date range.', 404, 'NO_BILLS_IN_RANGE');
  refuseIfBlocked(preview);

  const result = await repo.deleteBillsInRangeAtomic({
    dateFrom, dateTo, actorId: actor.id, reason, expectedCount, expectedTotal,
    ip: ctx.ip, userAgent: ctx.userAgent,
  });
  logger.info({ actorId: actor.id, dateFrom, dateTo, deleted: result.deleted_bills, total: result.total_amount },
    'Bills deleted by date range (stock not returned)');
  return result;
}

module.exports = {
  listBills, getBillById, createBill, getSalesTotals,
  previewBillDeletion, previewRangeDeletion, deleteBill, deleteBillsInRange,
};
