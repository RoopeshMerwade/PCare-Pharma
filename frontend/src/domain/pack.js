/* ═══════════════════════════════════════════════════════════════════════════
   Pack contents and loose units — Module 27.

   domain/, not components/: "can this be split", "what is one tablet worth"
   and "how do I say 24 strips + 6 tablets" are pharmacy meaning, and the
   billing screen, the inventory drawer and any future receipt all have to
   agree on them.

   Mirrored from the backend's billing/fefo.js ON PURPOSE, the same way
   invoice.js mirrors the Module 23 normaliser: the cashier has to watch
   "Total: ₹27.15" update as they type into the Tablets box, and a round-trip
   per keystroke would make the field feel broken.

   THE SERVER IS STILL THE AUTHORITY. Nothing here allocates stock, picks a
   batch or decides what a sale costs — FEFO runs server-side and the bill's
   real figures come back in the response. These are display arithmetic over
   numbers the API already sent.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── What may be split ──────────────────────────────────────────────────────

   The one rule this file exists to hold: a "10'S" strip contains ten things a
   customer can buy one of; a "100ML" bottle and a "30GM" tube do not. The
   number after the digits is the whole signal, and it is not inferable from
   the digits — 100'S, 100ML, 100GM and 100MD share one and mean four
   different things.

   Same three units as is_countable_content() in the database and
   isCountableContent() in fefo.js. Keep all three in step. */
export const COUNTABLE_CONTENT_UNITS = ['TABLET', 'CAPSULE', 'PIECE'];

export function isCountableContent(unit) {
  return COUNTABLE_CONTENT_UNITS.includes(String(unit || '').toUpperCase());
}

function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether a medicine can be sold in single units.
 *
 * Prefers the server's own answer (`loose_sale_supported`, computed by
 * medicines_with_stock) and falls back to the same test locally for payloads
 * that predate the column — the pattern stockStatus() already uses for
 * `is_low_stock`.
 */
export function supportsLooseSale(medicine) {
  if (medicine?.loose_sale_supported !== undefined && medicine?.loose_sale_supported !== null) {
    return Boolean(medicine.loose_sale_supported);
  }
  return isCountableContent(medicine?.pack_content_unit) && num(medicine?.pack_content_quantity) > 1;
}

/** How many content units are in one sealed unit, or 0 when unrecorded. */
export function packContents(medicine) {
  return num(medicine?.pack_content_quantity);
}

/**
 * The price of one content unit.
 *
 * Half-up to paise, mirroring roundPaise in the backend's utils/money.js —
 * `Math.round(x * 100) / 100` is not enough once division is involved, because
 * ₹24.25 ÷ 10 is exactly 2.425, which has no exact double and silently rounds
 * DOWN to ₹2.42. The counter would then quote a price a paisa under what the
 * bill charges.
 *
 * Floored at ₹0.01 for the same reason the backend floors it: a price of zero
 * is refused by the database, so it must never be shown as if it were valid.
 */
export function perUnitPrice(sealedPrice, contentQuantity) {
  const price = num(sealedPrice);
  const content = num(contentQuantity);
  if (!price || content <= 0) return null;
  const per = Math.round(Number(((price / content) * 100).toFixed(4))) / 100;
  return Math.max(per, 0.01);
}

/** "tablet" / "capsule" / "unit" — the noun for a single content unit, for
 *  labels and error messages. §5 wants a unit beside every quantity, and
 *  "3 units" is the honest fallback when the pack never said what it holds. */
export function contentNoun(unit, { plural = false } = {}) {
  const key = String(unit || '').toUpperCase();
  const noun = key === 'TABLET' ? 'tablet' : key === 'CAPSULE' ? 'capsule' : 'unit';
  return plural ? `${noun}s` : noun;
}

/** The singular of a sealed unit — "strips" → "strip". */
export function sealedNoun(unit, { plural = false } = {}) {
  const base = String(unit || 'unit').replace(/s$/, '');
  return plural ? `${base}s` : base;
}

/** "10 tablets per strip" — the line under a medicine name that tells the
 *  cashier what splitting it would actually produce. Null when the pack is
 *  unrecorded, so the caller renders nothing rather than "0 units per strip". */
export function packLabel(medicine) {
  const contents = packContents(medicine);
  if (!contents) return null;
  const noun = contentNoun(medicine?.pack_content_unit, { plural: contents !== 1 });
  return `${contents} ${noun} per ${sealedNoun(medicine?.unit)}`;
}

/**
 * "24 strips + 6 tablets" — what is actually on the shelf, in both
 * denominations.
 *
 * Deliberately NOT a single total. Folding loose tablets into the strip count
 * would mean 24 strips and 6 tablets reads as "24.6 strips" or "246 tablets",
 * and neither is a number anyone can act on. The two pools are physically
 * different things and the label keeps them apart.
 */
export function availabilityLabel(medicine) {
  const sealed = num(medicine?.total_stock);
  const loose = num(medicine?.total_loose_stock);
  const sealedPart = `${sealed} ${sealedNoun(medicine?.unit, { plural: sealed !== 1 })}`;
  if (loose <= 0) return sealedPart;
  const noun = contentNoun(medicine?.pack_content_unit, { plural: loose !== 1 });
  return `${sealedPart} + ${loose} ${noun}`;
}

/**
 * The most single units this medicine could supply right now: what is already
 * open, plus what every sealed pack would yield if it were opened.
 *
 * Mirrors looseAvailable() in fefo.js. Advisory only — it ignores batch
 * boundaries and expiry order, which the server's allocator does not.
 */
export function looseAvailable(medicine) {
  if (!supportsLooseSale(medicine)) return 0;
  return num(medicine?.total_loose_stock) + num(medicine?.total_stock) * packContents(medicine);
}

/**
 * What a mixed line costs, and what it consumes.
 *
 * `looseUnits` is priced per tablet rather than as a fraction of a strip, so
 * the two halves are added at their own rates — which is exactly what the
 * server will do, line for line.
 */
export function lineTotals(item) {
  const qty = num(item?.qty);
  const looseQty = num(item?.loose_qty);
  const contents = packContents(item);
  const unitPrice = num(item?.unit_price);
  const loosePrice = perUnitPrice(unitPrice, contents) ?? 0;

  return {
    sealedTotal: qty * unitPrice,
    looseTotal: looseQty * loosePrice,
    total: qty * unitPrice + looseQty * loosePrice,
    loosePrice,
    // For the "Total units" readout: what the customer walks out with, counted
    // in single units. A display figure — never a stock figure.
    contentUnits: contents ? qty * contents + looseQty : null,
  };
}

/**
 * "2 strips + 3 tablets" — what is actually being handed over on one cart line.
 *
 * Same reasoning as availabilityLabel, applied to the outgoing side: the two
 * denominations are kept apart because they are physically different things,
 * and the count of loose pieces is the number a pharmacist checks against what
 * they are about to cut off a strip.
 *
 * Lives here rather than in the billing screen because the line item and the
 * pre-submit summary must not word it differently — the summary is the last
 * screen anyone reads before an immutable bill exists.
 *
 * Null for an empty line, so the caller renders nothing rather than "0 strips".
 */
export function dispensedLabel(item) {
  const sealed = num(item?.qty);
  const loose = num(item?.loose_qty);
  const parts = [];
  if (sealed > 0) parts.push(`${sealed} ${sealedNoun(item?.unit, { plural: sealed !== 1 })}`);
  if (loose > 0) parts.push(`${loose} ${contentNoun(item?.pack_content_unit, { plural: loose !== 1 })}`);
  return parts.length ? parts.join(' + ') : null;
}

/**
 * Whether a loose quantity is a whole pack or more, and what that is in packs.
 *
 * Advisory, and deliberately not enforced. Asking for ten tablets from a pack
 * of ten is a legitimate request — the batch may already have ten loose from
 * an earlier sale, in which case no pack needs opening at all, and rewriting
 * it to "1 strip" would fail a sale the shop can actually fill. So the counter
 * is told, and decides.
 */
export function wholePackHint(item) {
  const contents = packContents(item);
  const looseQty = num(item?.loose_qty);
  if (!contents || looseQty < contents) return null;
  const packs = Math.floor(looseQty / contents);
  const remainder = looseQty % contents;
  const noun = sealedNoun(item?.unit, { plural: packs !== 1 });
  const remainderNoun = contentNoun(item?.pack_content_unit, { plural: remainder !== 1 });
  return remainder === 0
    ? `That's ${packs} full ${noun} — adding it as a ${sealedNoun(item?.unit)} keeps the pack sealed.`
    : `That's ${packs} full ${noun} and ${remainder} ${remainderNoun}.`;
}
