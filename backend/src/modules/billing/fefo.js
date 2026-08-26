// ── Billing domain logic: FEFO allocation. Pure functions — no I/O.
// Extracted from billing.service so the core sell-flow invariants
// (nearest-expiry-first, spillover, shortfall detection, duplicate-line
// merging) are unit-testable without a database.

const { roundPaise, finiteOrNull } = require('../../utils/money');

/* ── Loose units (Module 27) ───────────────────────────────────────────────
 *
 * A cart line can now ask for whole sealed units, loose content units out of
 * an opened pack, or both:
 *
 *     { medicine_id, qty: 2, loose_qty: 3 }   → 2 strips and 3 tablets
 *
 * `qty` keeps its original meaning everywhere — sealed saleable units, the
 * denomination inventory_ledger counts and medicines.unit names. Loose units
 * are a SECOND denomination tracked in loose_unit_ledger, and the only bridge
 * between the two is opening a pack, which costs one sealed unit and yields
 * `content_quantity` loose ones.
 */

/** Content units that describe discrete objects a customer can buy one of.
 *  The same three perContentUnitPrice() tests in Module 23's normalize.js —
 *  30GM of ointment and 100ML of syrup are measured contents of a sealed
 *  container, not a hundred saleable things. */
const COUNTABLE_CONTENT_UNITS = ['TABLET', 'CAPSULE', 'PIECE'];

function isCountableContent(unit) {
  return COUNTABLE_CONTENT_UNITS.includes(String(unit || '').toUpperCase());
}

/**
 * The price of one content unit, from the price of one sealed unit.
 *
 * Half-up through roundPaise, which matters more here than anywhere else in
 * the app because this divides. A ₹10.00 strip of 7 is ₹1.43 a tablet, so the
 * seventh tablet sold singly earns ₹10.01 rather than ₹9.99 — the paisa lands
 * with the pharmacy rather than against it, and it is visible on the line
 * either way.
 *
 * Floored at ₹0.01 because bill_items.unit_price and .mrp both carry
 * `check (> 0)`: a ₹0.50 pack of 100 would otherwise derive a price of zero and
 * abort the sale at the database rather than at the counter.
 */
function perUnitPrice(sealedPrice, contentQuantity) {
  const price = finiteOrNull(sealedPrice);
  const content = finiteOrNull(contentQuantity);
  if (price === null || content === null || content <= 0) return null;
  const per = roundPaise(price / content);
  return per === null ? null : Math.max(per, 0.01);
}

// Merge duplicate medicine lines in a cart. Without this, two lines for the
// same medicine were each FEFO-resolved against a fresh stock read, so both
// could claim the same units and the second ledger write blew up mid-bill.
//
// `loose_qty` is summed alongside `qty` and omitted entirely when zero, so a
// cart that never mentions loose units produces exactly the object shape it
// always did.
function mergeCartItems(items) {
  const byMedicine = new Map();
  for (const item of items) {
    const qty = Number(item.qty) || 0;
    const looseQty = Number(item.loose_qty) || 0;
    const existing = byMedicine.get(item.medicine_id);
    if (existing) {
      existing.qty += qty;
      if (looseQty) existing.loose_qty = (existing.loose_qty || 0) + looseQty;
    } else {
      const merged = { medicine_id: item.medicine_id, qty };
      if (looseQty) merged.loose_qty = looseQty;
      byMedicine.set(item.medicine_id, merged);
    }
  }
  return [...byMedicine.values()];
}

// FEFO: consume nearest-expiry batch first, spill to the next as needed.
// `batches` must already be sorted by exp_date ascending with stock_qty > 0
// (the batches_with_stock query guarantees both).
// Returns { lines, shortfall } — shortfall > 0 means insufficient stock.
function allocateFefo(batches, requestedQty) {
  const lines = [];
  let remaining = requestedQty;

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.stock_qty);
    if (take <= 0) continue;
    lines.push({
      batch_id: batch.id,
      qty: take,
      unit_price: parseFloat(batch.selling_price),
      mrp: parseFloat(batch.mrp),
    });
    remaining -= take;
  }

  return { lines, shortfall: remaining > 0 ? remaining : 0 };
}

/**
 * A mutable working copy of the FEFO batch list.
 *
 * Sealed and loose stock have to be allocated against ONE shared view of each
 * batch, because they compete: a strip handed over whole is a strip that can no
 * longer be opened for tablets. Resolving the two passes independently against
 * separate stock reads is the same defect mergeCartItems exists to prevent, one
 * level down.
 */
function toPool(batches) {
  return batches.map((batch) => ({
    id: batch.id,
    sealed: Number(batch.sealed_qty ?? batch.stock_qty ?? 0),
    loose: Number(batch.loose_qty ?? 0),
    content: Number(batch.effective_content_quantity) || null,
    // The view computes this: countable content unit AND more than one of them.
    // A pack of 1 is already its own smallest unit and opening it would create
    // a second denomination for one physical object.
    splittable: Boolean(batch.loose_sale_supported),
    selling_price: parseFloat(batch.selling_price),
    mrp: parseFloat(batch.mrp),
  }));
}

/**
 * Loose allocation, nearest expiry first.
 *
 * Per batch, in FEFO order:
 *
 *   1. Consume tablets already loose in this batch. An opened pack is the most
 *      perishable stock in the shop — its foil is broken — so it is spent
 *      before anything else is disturbed.
 *   2. Only if that is not enough, open the MINIMUM number of sealed packs to
 *      cover the rest: ceil(remaining / content). Three tablets from a batch of
 *      10s opens one pack, never three.
 *   3. Whatever the opened pack does not sell stays loose against this batch,
 *      which is what keeps it tied to this expiry date.
 *
 * Only moves to the next batch when this one is exhausted in BOTH pools, so a
 * later-expiring batch is never touched while the nearest one can still be
 * opened. That is the same invariant allocateFefo enforces for sealed units.
 *
 * Mutates `pool`, which is what lets a mixed line's two passes see each other's
 * consumption.
 */
function allocateLooseFromPool(pool, requestedLooseQty) {
  const lines = [];
  let remaining = requestedLooseQty;

  for (const batch of pool) {
    if (remaining <= 0) break;
    if (!batch.splittable || !batch.content) continue;

    let taken = 0;
    let stripsToOpen = 0;

    const fromExistingLoose = Math.min(remaining, batch.loose);
    if (fromExistingLoose > 0) {
      batch.loose -= fromExistingLoose;
      taken += fromExistingLoose;
      remaining -= fromExistingLoose;
    }

    if (remaining > 0 && batch.sealed > 0) {
      stripsToOpen = Math.min(Math.ceil(remaining / batch.content), batch.sealed);
      const freed = stripsToOpen * batch.content;
      const fromOpened = Math.min(remaining, freed);
      batch.sealed -= stripsToOpen;
      batch.loose += freed - fromOpened;
      taken += fromOpened;
      remaining -= fromOpened;
    }

    if (taken > 0) {
      lines.push({
        batch_id: batch.id,
        qty: taken,
        unit_price: perUnitPrice(batch.selling_price, batch.content),
        mrp: perUnitPrice(batch.mrp, batch.content),
        is_loose: true,
        content_quantity: batch.content,
        strips_to_open: stripsToOpen,
      });
    }
  }

  return { lines, shortfall: remaining > 0 ? remaining : 0 };
}

/**
 * Resolves one cart line — sealed units, loose units, or both — into the
 * batch-level lines create_bill_atomic writes.
 *
 * Sealed goes first, deliberately. When one pack is left and the line wants
 * both a whole pack and a tablet, the whole pack wins: `qty` is a request for
 * intact goods, and satisfying it by opening the pack and counting out ten
 * tablets would hand the customer something different from what was rung up.
 * Neither ordering can satisfy both, so the one that reports a shortfall on the
 * loose half — the half that can be filled another way — is the useful one.
 */
function allocateCartLine(batches, { qty = 0, looseQty = 0 } = {}) {
  const pool = toPool(batches);

  const sealed = allocateFefo(pool.map((b) => ({ ...b, stock_qty: b.sealed })), qty);
  // Apply pass 1's consumption to the shared pool before pass 2 reads it.
  const byId = new Map(pool.map((b) => [b.id, b]));
  for (const line of sealed.lines) byId.get(line.batch_id).sealed -= line.qty;

  const loose = allocateLooseFromPool(pool, looseQty);

  return {
    lines: [
      ...sealed.lines.map((line) => ({ ...line, is_loose: false })),
      ...loose.lines,
    ],
    sealedShortfall: sealed.shortfall,
    looseShortfall: loose.shortfall,
  };
}

/**
 * How many loose units a medicine could supply right now, across every batch
 * that may be split: what is already open, plus what every sealed pack would
 * yield if it were.
 *
 * For error messages and the availability figure the counter sees — never for
 * allocation, which has to respect batch boundaries and expiry order.
 */
function looseAvailable(batches) {
  return toPool(batches).reduce((total, batch) => {
    if (!batch.splittable || !batch.content) return total;
    return total + batch.loose + batch.sealed * batch.content;
  }, 0);
}

/** Whether any in-date batch of this medicine can be split at all. Separates
 *  "this product is not sold loose" from "not enough of it" — two different
 *  answers for the person at the counter. */
function supportsLooseSale(batches) {
  return toPool(batches).some((batch) => batch.splittable && batch.content > 1);
}

// Splits adherence warnings into acknowledged / unacknowledged given the
// schedule ids the staff has confirmed. Pure so the 409 gate is testable.
function partitionWarnings(warnings, acknowledgedWarnings) {
  const acknowledgedIds = new Set((acknowledgedWarnings || []).map((w) => w.schedule_id));
  return {
    acknowledged: warnings.filter((w) => acknowledgedIds.has(w.schedule_id)),
    unacknowledged: warnings.filter((w) => !acknowledgedIds.has(w.schedule_id)),
  };
}

module.exports = {
  mergeCartItems,
  allocateFefo,
  allocateCartLine,
  allocateLooseFromPool,
  looseAvailable,
  supportsLooseSale,
  isCountableContent,
  perUnitPrice,
  partitionWarnings,
  COUNTABLE_CONTENT_UNITS,
};
