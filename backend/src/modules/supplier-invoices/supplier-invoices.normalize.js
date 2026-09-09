// ── Module 23: Supplier Invoices — normalisation
//
// Pure functions. No Supabase, no config, no clock beyond an injectable
// `today` — so tests/unit/ can exercise every branch without credentials.
//
// This layer sits between the model's answer and the staging tables. Its job is
// to turn what a distributor printed into what the schema stores, and to return
// null wherever it cannot do that honestly. Nothing here guesses: a value it
// does not recognise becomes null and reaches a human, because a wrong expiry
// date silently coerced into a valid-looking one is the single most expensive
// mistake this feature could make.

// roundPaise and finiteOrNull moved to utils/money.js when loose-unit pricing
// (Module 27) needed the same half-up paise rounding to divide a strip price by
// its tablet count. Re-exported below, so this module's surface is unchanged.
const { roundPaise, finiteOrNull } = require('../../utils/money');

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Last calendar day of a month, as YYYY-MM-DD. Day 0 of the NEXT month. */
function lastDayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

function firstDayOfMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Two-digit years on a pharmacy strip are always this century. "26" is 2026;
 * there is no batch on any shelf that expired in 1926.
 */
function expandYear(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (raw.length <= 2) return 2000 + n;
  return n;
}

function isRealDate(year, month, day) {
  if (!(month >= 1 && month <= 12)) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Parses whatever a strip prints into { year, month, day? }.
 *
 * Accepts: 2027-04, 2027-04-30, 04/27, 04-2027, APR27, Apr 2027, 04/2027.
 * Rejects everything else by returning null.
 *
 * Deliberately does NOT accept a bare `04/27/2027`-style US date or any form
 * where day and month are ambiguous — 03/04 could be either, and the cost of
 * choosing wrong is stock that expires eleven months before the system thinks.
 */
function parseMonthish(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  // YYYY-MM-DD
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(year, month, day) ? { year, month, day } : null;
  }

  // YYYY-MM
  m = /^(\d{4})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const [year, month] = [Number(m[1]), Number(m[2])];
    return month >= 1 && month <= 12 ? { year, month } : null;
  }

  // MM/YY or MM/YYYY or MM-YY …
  m = /^(\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const month = Number(m[1]);
    const year = expandYear(m[2]);
    return year && month >= 1 && month <= 12 ? { year, month } : null;
  }

  // APR27, Apr-2027, APRIL 27
  m = /^([A-Za-z]{3,9})[\s\-/.]*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const year = expandYear(m[2]);
    return year && month ? { year, month } : null;
  }

  return null;
}

/**
 * Expiry, normalised to the LAST calendar day of its month.
 *
 * A strip printed "EXP 04/27" is good through the whole of April 2027 — Indian
 * labelling convention, and the same rule FEFO billing sorts on. Normalising to
 * the 1st would write off a month of shelf life on every batch this feature
 * imports.
 */
function normalizeExpiry(value) {
  const parsed = parseMonthish(value);
  if (!parsed) return null;
  if (parsed.day) return `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
  return lastDayOfMonth(parsed.year, parsed.month);
}

/** Manufacture date, normalised to the FIRST day of its month — the mirror of
 *  the expiry rule, and the conservative end of the same interval. */
function normalizeMfg(value) {
  const parsed = parseMonthish(value);
  if (!parsed) return null;
  if (parsed.day) return `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
  return firstDayOfMonth(parsed.year, parsed.month);
}

/** Invoice date — a full date or nothing. A month alone is not an invoice date. */
function normalizeDate(value) {
  const parsed = parseMonthish(value);
  if (!parsed?.day) return null;
  return `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
}

/**
 * A money/decimal figure, or null. Strips ₹, commas and spaces; refuses
 * anything that is not then a finite non-negative number.
 */
function normalizeAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * A money figure that MAY be negative, or null.
 *
 * `normalizeAmount` rejects negatives, which is right for a rate and wrong for
 * a round-off. MEDICO M002948 rounds ₹11590.21 DOWN to ₹11590.00 — a round-off
 * of −0.21 — and rounding down is the commoner direction, so a non-negative
 * guard would make the ordinary case unstorable. Used only for `round_off` and
 * `adjustment_amount`, the two columns whose CHECK constraints are unsigned to
 * match.
 */
function normalizeSignedAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return roundPaise(n);
}

/**
 * A time of day as HH:MM:SS, or null.
 *
 * Accepts "14:35", "14:35:20", "2:35 PM", "02:35:20 pm". Rejects anything else
 * rather than guessing — an invoice time is a convenience field and a wrong one
 * is worse than a blank.
 */
function normalizeTime(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase();
  if (!s) return null;

  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/.exec(s);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] ? Number(m[3]) : 0;
  const meridiem = m[4];

  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  if (hour > 23 || minute > 59 || second > 59) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * A GST state code — two digits, zero-padded.
 *
 * "29" (Karnataka) is printed as 29, 029 and sometimes "29 - Karnataka". Kept
 * as text rather than an int because the leading zero is part of the code:
 * Jammu & Kashmir is "01", not 1.
 */
function normalizeStateCode(value) {
  if (value === null || value === undefined) return null;
  const m = /(\d{1,2})/.exec(String(value).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  return String(n).padStart(2, '0');
}

/** A whole count, or null. Fractional quantities are rounded down rather than
 *  rejected — "2.00" is common in a Qty column, "2.5 boxes" is a misread. */
function normalizeInt(value, { min = 0 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i < min ? null : i;
}

/* ── The Pack column ───────────────────────────────────────────────────────
 *
 * THE RULE THIS FILE MOST NEEDS TO GET RIGHT: the Pack column describes what is
 * INSIDE one saleable unit. It is never a count of saleable units, and it never
 * enters the money.
 *
 * Verified across every legible line of MEDICO M002948 and M002277 — 18 lines,
 * six different pack shapes:
 *
 *     qty_billed × printed_rate = line_total,  every time
 *
 * The rate applies to one invoice-Qty unit, which IS the saleable unit. So:
 *
 *     "100'S" qty 5   → 5 STRIPS on the shelf, ₹103.12 each   (NOT 500 tablets)
 *     "100ML" qty 6   → 6 BOTTLES,             ₹68.74 each    (NOT 600 bottles)
 *     "30GM"  qty 5   → 5 TUBES,               ₹58.43 each    (NOT 150 tubes)
 *     "120MD" qty 2   → 2 INHALERS,            ₹285.11 each   (NOT 240 inhalers)
 *     "7X2ML" qty 20  → 20 PACKS of 7 ampoules, ₹45.01 each   (NOT 140 packs)
 *
 * Getting this wrong writes the wrong DENOMINATION into inventory_ledger, which
 * is shared with billing, FEFO and returns and is counted in `medicines.unit`.
 * Nothing outside this module knows about pack contents, so a line that posts
 * 500 where the rest of the app means 5 is silent stock corruption, not a
 * rounding error.
 *
 * The suffix is the whole signal, and it is not inferable from the number:
 * 100'S, 100ML, 100GM and 100MD share a digit and mean four different things.
 */

/** Suffix → what one unit of content is. Order matters in the alternation:
 *  longer tokens first, so "MCG" is not consumed by "MG" and "LTR" not by "L". */
const CONTENT_UNITS = [
  { match: /^(?:TABS?|TAB|T)$/i,        unit: 'TABLET' },
  { match: /^(?:CAPS?|CAP)$/i,          unit: 'CAPSULE' },
  { match: /^(?:'?S|NOS?|PCS?)$/i,      unit: 'PIECE' },
  { match: /^(?:MCG)$/i,                unit: 'MCG' },
  { match: /^(?:MG)$/i,                 unit: 'MG' },
  { match: /^(?:KGS?)$/i,               unit: 'KG' },
  { match: /^(?:GMS?|GM|G)$/i,          unit: 'GM' },
  { match: /^(?:ML)$/i,                 unit: 'ML' },
  { match: /^(?:LTRS?|LTR|L)$/i,        unit: 'L' },
  { match: /^(?:MD|MDI|DOSES?|DOSE)$/i, unit: 'DOSE' },
  { match: /^(?:IU|U)$/i,               unit: 'IU' },
];

function contentUnitFor(suffix) {
  const s = String(suffix || '').trim();
  if (!s) return null;
  const hit = CONTENT_UNITS.find((c) => c.match.test(s));
  return hit ? hit.unit : null;
}

/**
 * Parses the printed Pack column into its content description.
 *
 * Returns `{ content_quantity, content_unit, sub_pack_quantity, sub_pack_unit,
 * recognised }`. Every field may be null: an unrecognised pack is marked
 * `recognised: false` and surfaces as PACK_UNPARSEABLE for a human, rather than
 * being coerced into a number that would look authoritative and be wrong.
 *
 * Crucially it does NOT return a multiplier for stock. There isn't one. Stock
 * is the Qty column.
 *
 *   "10'S"    → 10 PIECE
 *   "100'S"   → 100 PIECE
 *   "10S"     → 10 PIECE
 *   "100ML"   → 100 ML
 *   "30GM"    → 30 GM
 *   "120MD"   → 120 DOSE
 *   "7X2ML"   → 7 AMPOULE of 2 ML each        (nested, never flattened)
 *   "10X10'S" → 10 PACK of 10 PIECE each
 *   "1X200ML" → 1 of 200 ML
 */
function parsePack(value) {
  const empty = {
    content_quantity: null, content_unit: null,
    sub_pack_quantity: null, sub_pack_unit: null,
    recognised: false,
  };
  if (value === null || value === undefined || value === '') return { ...empty, recognised: true };

  const s = String(value).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return { ...empty, recognised: true };

  // Nested: "7X2ML", "10X10'S", "1X200ML" — N outer items, each holding M units.
  // Rule 5: never flattened. The rate belongs to the whole expression.
  const nested = /^(\d+(?:\.\d+)?)[X*](\d+(?:\.\d+)?)\s*([A-Z']*)$/.exec(s);
  if (nested) {
    const outer = Number(nested[1]);
    const inner = Number(nested[2]);
    const unit = contentUnitFor(nested[3]);
    if (!Number.isFinite(outer) || !Number.isFinite(inner)) return empty;

    // "1X200ML" is not nested packaging — it is one 200ml bottle written the
    // long way. Recording a sub-pack of 1 would put "1 AMPOULE" on a syrup.
    if (outer === 1) {
      return { content_quantity: inner, content_unit: unit, sub_pack_quantity: null, sub_pack_unit: null, recognised: unit !== null };
    }

    return {
      // The inner measurement is the content of one sub-item.
      content_quantity: inner,
      content_unit: unit,
      // The outer count is how many sub-items are in one saleable pack. An
      // ampoule when the content is a volume, a generic PACK otherwise.
      sub_pack_quantity: outer,
      sub_pack_unit: unit === 'ML' || unit === 'L' ? 'AMPOULE' : 'PACK',
      recognised: unit !== null,
    };
  }

  // Simple: "100'S", "120MD", "30GM", "100ML".
  const simple = /^(\d+(?:\.\d+)?)\s*([A-Z']+)$/.exec(s);
  if (simple) {
    const qty = Number(simple[1]);
    const unit = contentUnitFor(simple[2]);
    if (!Number.isFinite(qty) || !unit) return empty;
    return { content_quantity: qty, content_unit: unit, sub_pack_quantity: null, sub_pack_unit: null, recognised: true };
  }

  // A bare number with no suffix. Rule 11: the suffix is mandatory for
  // interpretation, so this is recorded as a count of pieces but flagged —
  // it is the one case where a guess would be invisible.
  const bare = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (bare) {
    return { content_quantity: Number(bare[1]), content_unit: 'PIECE', sub_pack_quantity: null, sub_pack_unit: null, recognised: false };
  }

  return empty;
}

/**
 * The physical thing one Qty unit is, inferred from the product description
 * first and the pack shape second (Rule 6).
 *
 * Falls back to 'PACK' rather than inventing a container: a wrong sale_unit is
 * a label on a shelf that does not match the box in someone's hand.
 */
const SALE_UNIT_HINTS = [
  { match: /\b(?:INHALER|ROTACAP|MDI|RESPULE)\b/i,       unit: 'INHALER' },
  { match: /\b(?:SYP|SYRUP|SUSP|SUSPENSION|LIQUID)\b/i,  unit: 'BOTTLE' },
  { match: /\b(?:DROPS?|EYE\s*DROPS?)\b/i,               unit: 'BOTTLE' },
  { match: /\b(?:OINT|OINTMENT|CREAM|GEL|LOTION)\b/i,    unit: 'TUBE' },
  { match: /\b(?:INJ|INJECTION|VIAL|AMP|AMPOULE)\b/i,    unit: 'VIAL' },
  { match: /\b(?:TABS?|TABLET|CAPS?|CAPSULE)\b/i,        unit: 'STRIP' },
];

function deriveSaleUnit(description, pack) {
  const desc = String(description || '');
  const hit = SALE_UNIT_HINTS.find((h) => h.match.test(desc));
  if (hit) return hit.unit;

  // Nothing in the name — fall back on what the content unit implies.
  switch (pack?.content_unit) {
    case 'DOSE': return 'INHALER';
    case 'ML':
    case 'L': return pack?.sub_pack_quantity ? 'PACK' : 'BOTTLE';
    case 'GM':
    case 'KG': return 'TUBE';
    case 'TABLET':
    case 'CAPSULE':
    case 'PIECE': return 'STRIP';
    default: return 'PACK';
  }
}

/**
 * The printed description with a leading tax-class letter removed, for matching
 * only. MARG prints "a CLONAFIT PLUS TAB" / "b ENERZAL PET ORANGE", where the
 * letter keys the HSN/GST class in the footer summary. Trigram similarity
 * against a catalogue holding "Clonafit Plus" is measurably hurt by it.
 *
 * Only a LOWERCASE letter followed by an uppercase word is stripped. That is
 * what protects "B COMPLEX FORTE" and "D RISE 60K" — real products whose first
 * word is a single capital letter — from being silently renamed to "COMPLEX
 * FORTE" and "RISE 60K", which would match the wrong medicine rather than none.
 *
 * The stored raw_description always keeps the prefix: it is what was printed.
 */
function descriptionForMatching(value) {
  const s = normalizeText(value, 300);
  if (!s) return null;
  const stripped = s.replace(/^[a-z]\s+(?=[A-Z0-9])/, '');
  return stripped.length >= 3 ? stripped : s;
}

/**
 * Purchase cost of ONE SALEABLE UNIT, net of the line discount.
 *
 * The rate is already per saleable unit — that is what `qty × rate = line_total`
 * on all 18 verified lines means — so there is no conversion to do. The only
 * adjustment is the discount, because the pharmacy did not pay the headline
 * rate:
 *
 *   LIV 52 TAB, "100'S": ₹103.12 a strip less 3% = ₹100.03 a strip
 *
 * NOT ₹1.00 a tablet. Rule 9: a per-tablet figure may be derived for display,
 * but it must never replace the invoice rate, and it must never be what reaches
 * inventory_batches — the ledger counts strips.
 *
 * GST is deliberately NOT added. PCare is GST-registered, so input tax is
 * reclaimed and is not a cost. A pharmacy on the composition scheme would need
 * the opposite treatment — a settings-level decision, not a per-line one.
 *
 * Free goods are not spread across the cost: qty_free units enter stock at the
 * same cost as billed ones, and lineValue charges only for billed units.
 */
/**
 * The discount percentage that should actually be applied to this line.
 *
 * `discount_pct` when the vendor printed one — in which case NOTHING changes
 * and this function is a pass-through. That is the whole backward-compatibility
 * story: every invoice that worked before produces exactly the same cost.
 *
 * The fallback exists because a vendor who prints a "Dis.Amt" column and no
 * "Dis.%" column used to produce a cost at the FULL printed rate, silently.
 * Nothing caught it: LINE_TOTAL_MISMATCH reconciles qty × printed_rate against
 * the printed gross, and both of those are gross, so they agreed while the
 * pharmacy's recorded cost was too high by the whole discount. An overstated
 * cost understates every margin computed from it, which is the opposite of the
 * direction roundPaise is careful to lean.
 *
 * Deriving a percentage rather than subtracting an amount is deliberate: it
 * feeds the SAME `deriveUnitCost` below, so there is exactly one costing
 * formula and one rounding step no matter which column the vendor printed.
 *
 * Returns null — not 0 — when neither is readable, so an absent discount stays
 * absent rather than becoming an assertion that none was given.
 */
function resolveDiscountPct({ discount_pct, discount_amount, gross }) {
  const pct = finiteOrNull(discount_pct);
  if (pct !== null) return pct;

  const amount = finiteOrNull(discount_amount);
  const base = finiteOrNull(gross);
  if (amount === null || base === null || base <= 0 || amount <= 0) return null;

  const derived = (amount / base) * 100;
  // A discount above 100% is a misread of the column, not a deal — the same
  // judgement normalizePercent already makes. Refused rather than clamped.
  if (!Number.isFinite(derived) || derived > 100) return null;
  return derived;
}

function deriveUnitCost({ printed_rate, discount_pct }) {
  const rate = finiteOrNull(printed_rate);
  if (rate === null || rate < 0) return null;

  const discount = Number(discount_pct);
  const net = Number.isFinite(discount) && discount > 0 && discount <= 100
    ? rate * (1 - discount / 100)
    : rate;

  return roundPaise(net);
}

/**
 * A per-content-unit price, for DISPLAY only (Rule 9).
 *
 * ₹103.12 a strip of 100 is ₹1.03 a tablet. Useful beside the field so a
 * reviewer can sanity-check against what they know a tablet costs — and
 * explicitly never written to unit_cost, never sent to the commit RPC, and
 * never used in any total.
 *
 * Null unless the pack states a countable content: dividing a rate by millilitres
 * gives a price per ml, which is not a thing anyone prices against.
 */
function perContentUnitPrice(rate, pack) {
  const r = finiteOrNull(rate);
  const qty = finiteOrNull(pack?.content_quantity);
  const countable = pack?.content_unit === 'TABLET' || pack?.content_unit === 'CAPSULE' || pack?.content_unit === 'PIECE';
  if (r === null || qty === null || qty <= 0 || !countable) return null;
  return roundPaise(r / qty);
}

/**
 * MRP per STOCK unit. Same basis as the rate — a distributor that counts packs
 * in the Qty column prints the pack's MRP beside it, which is why M002948 heads
 * the column "MRP on Pack". No discount: MRP is the price on the strip, and
 * discount is something the distributor gave the pharmacy, not the patient.
 */
function deriveUnitMrp({ printed_mrp }) {
  const mrp = finiteOrNull(printed_mrp);
  if (mrp === null || mrp < 0) return null;
  // No conversion and no discount. The MRP column already states the price of
  // one saleable unit — M002948 heads it "MRP on Pack" — and the discount is
  // something the distributor gave the pharmacy, not the patient.
  return roundPaise(mrp);
}

/** A percentage, or null. Refuses anything outside 0–100 rather than clamping:
 *  a discount read as 300% is a misread, and clamping it to 100 would hide that. */
function normalizePercent(value) {
  const n = normalizeAmount(value);
  if (n === null) return null;
  return n > 100 ? null : n;
}

/** Batch numbers are stored uppercase (inventory_batches unique-indexes on
 *  lower(batch_no), and receive_purchase_atomic uppercases too) — matching
 *  here keeps what the reviewer typed identical to what the shelf shows. */
function normalizeBatchNo(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase();
  return s === '' ? null : s.slice(0, 60);
}

function normalizeText(value, max = 200) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s.slice(0, max);
}

/** GSTIN is 15 chars, alphanumeric, uppercase. Anything else is a misread and
 *  is kept as raw text rather than dropped — the reviewer can see it was wrong. */
function normalizeGstin(value) {
  const s = normalizeText(value, 20);
  return s ? s.toUpperCase().replace(/\s/g, '') : null;
}

/** Phone numbers keep their printed punctuation (+, -, spaces) but drop
 *  anything that is not plausibly part of a number — letters, labels. */
function normalizePhone(value) {
  const s = normalizeText(value, 30);
  if (!s) return null;
  const cleaned = s.replace(/[^0-9+\-\s()]/g, '').trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * Turns one raw extracted line into a staging row's worth of fields.
 * `lineNo` is 1-based and comes from the array position, not the model — the
 * model's own numbering is not trustworthy enough to key anything on.
 */
function normalizeItem(raw, lineNo) {
  // Transcribed, untouched. These are the tie-back to the paper.
  const pack_raw = normalizeText(raw?.pack_raw, 40);
  const printed_rate = normalizeAmount(raw?.unit_cost);
  const printed_mrp = normalizeAmount(raw?.mrp);
  const discount_pct = normalizePercent(raw?.discount_pct);
  const discount_amount = normalizeAmount(raw?.discount_amount);
  const line_total = normalizeAmount(raw?.line_total);
  const qty_billed = normalizeInt(raw?.qty_billed, { min: 0 });

  // The Pack column, parsed into CONTENT. Nothing here multiplies stock.
  const raw_description = normalizeText(raw?.description, 300);
  const pack = parsePack(pack_raw);
  const mrp = deriveUnitMrp({ printed_mrp });

  // The gross this line's discount applies to, used ONLY to rescue a discount
  // printed as an amount. Prefers the printed total for the same reason
  // tax.js does: the vendor has already settled that line's rounding.
  const gross = line_total ?? (
    qty_billed !== null && printed_rate !== null ? roundPaise(qty_billed * printed_rate) : null
  );
  const effective_discount_pct = resolveDiscountPct({ discount_pct, discount_amount, gross });

  return {
    line_no: lineNo,
    raw_description,
    mfg_code_raw: normalizeText(raw?.mfg_code, 40),
    batch_no: normalizeBatchNo(raw?.batch_no),
    mfg_date: normalizeMfg(raw?.mfg_date),
    exp_date: normalizeExpiry(raw?.exp_date),

    // The invoice quantity, in saleable units. This IS the stock quantity.
    qty_billed,
    qty_free: normalizeInt(raw?.qty_free, { min: 0 }) ?? 0,

    // What one of those units is, and what is inside it. Informational: shown to
    // the reviewer, carried for traceability, never multiplied into stock or money.
    pack_raw,
    sale_unit: deriveSaleUnit(raw_description, pack),
    content_quantity: pack.content_quantity,
    content_unit: pack.content_unit,
    sub_pack_quantity: pack.sub_pack_quantity,
    sub_pack_unit: pack.sub_pack_unit,
    pack_recognised: pack.recognised,

    // Transcribed money, per saleable unit, exactly as printed.
    printed_rate,
    printed_mrp,
    // A THIRD price, not a synonym for either of the two above: PTR/Trade
    // Price is the list price for the trade, printed_rate is what this
    // pharmacy was actually charged, printed_mrp is what the patient pays.
    trade_price: normalizeAmount(raw?.trade_price),
    discount_pct,
    discount_amount,
    gst_pct: normalizePercent(raw?.gst_pct),
    line_total,

    // ── Transcribed tax, per line. Captured for the slab summary and GSTR-2
    // reconciliation; deliberately absent from the costing chain below, because
    // a GST-registered pharmacy reclaims input tax and it is therefore not a
    // cost. See deriveUnitCost.
    hsn_code: normalizeText(raw?.hsn_code, 20),
    taxable_amount: normalizeAmount(raw?.taxable_amount),
    cgst_pct: normalizePercent(raw?.cgst_pct),
    cgst_amount: normalizeAmount(raw?.cgst_amount),
    sgst_pct: normalizePercent(raw?.sgst_pct),
    sgst_amount: normalizeAmount(raw?.sgst_amount),
    igst_pct: normalizePercent(raw?.igst_pct),
    igst_amount: normalizeAmount(raw?.igst_amount),
    cess_pct: normalizePercent(raw?.cess_pct),
    cess_amount: normalizeAmount(raw?.cess_amount),
    net_amount: normalizeAmount(raw?.net_amount),

    // Derived money, also per saleable unit. Cost is net of discount; MRP is not.
    // GST takes no part — that is unchanged and must stay unchanged.
    unit_cost: deriveUnitCost({ printed_rate, discount_pct: effective_discount_pct }),
    mrp,
    selling_price: mrp,
  };
}

/**
 * Recomputes the derived fields after a review edit.
 *
 * Takes the whole merged row — stored values with the reviewer's changes already
 * applied — and returns only what should change. Far smaller than it used to be:
 * with the rate already per saleable unit, the only thing that moves the cost is
 * the rate itself or the discount.
 *
 * Re-parses pack_raw so a corrected Pack column updates the content description,
 * but that has no effect on cost or stock — by design.
 */
function rederiveLine(merged) {
  const printed_rate = normalizeAmount(merged.printed_rate);
  const printed_mrp = normalizeAmount(merged.printed_mrp);
  const discount_pct = normalizePercent(merged.discount_pct);
  const discount_amount = normalizeAmount(merged.discount_amount);
  const line_total = normalizeAmount(merged.line_total);
  const qty_billed = normalizeInt(merged.qty_billed, { min: 0 });
  const pack = parsePack(merged.pack_raw);
  const mrp = deriveUnitMrp({ printed_mrp });

  // Same gross basis as normalizeItem, so a corrected discount amount moves the
  // cost exactly as a corrected percentage does.
  const gross = line_total ?? (
    qty_billed !== null && printed_rate !== null ? roundPaise(qty_billed * printed_rate) : null
  );
  const effective_discount_pct = resolveDiscountPct({ discount_pct, discount_amount, gross });

  return {
    sale_unit: deriveSaleUnit(merged.raw_description, pack),
    content_quantity: pack.content_quantity,
    content_unit: pack.content_unit,
    sub_pack_quantity: pack.sub_pack_quantity,
    sub_pack_unit: pack.sub_pack_unit,
    pack_recognised: pack.recognised,
    unit_cost: deriveUnitCost({ printed_rate, discount_pct: effective_discount_pct }),
    mrp,
    // A price the reviewer already set is a decision; only fill a blank.
    selling_price: merged.selling_price ?? mrp,
  };
}

/** The invoice's own tax-summary block, one row per rate, transcribed.
 *
 *  Rows with no readable rate are dropped rather than bucketed into a rate
 *  they may not belong to — an unassignable slab row is worse than a missing
 *  one, because it looks reconciled. Duplicate rates are collapsed to the
 *  first: the table has a unique (invoice_id, tax_rate) index, so a second row
 *  at the same rate would fail the whole insert. */
function normalizeTaxSummary(raw) {
  const rows = Array.isArray(raw?.tax_summary) ? raw.tax_summary : [];
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const tax_rate = normalizePercent(row?.tax_rate);
    if (tax_rate === null) continue;
    if (seen.has(tax_rate)) continue;
    seen.add(tax_rate);

    out.push({
      tax_rate,
      basic_amount: normalizeAmount(row?.basic_amount),
      discount_amount: normalizeAmount(row?.discount_amount),
      taxable_amount: normalizeAmount(row?.taxable_amount),
      cgst_amount: normalizeAmount(row?.cgst_amount),
      sgst_amount: normalizeAmount(row?.sgst_amount),
      igst_amount: normalizeAmount(row?.igst_amount),
      cess_amount: normalizeAmount(row?.cess_amount),
      total_tax: normalizeAmount(row?.total_tax),
    });
  }

  return out.sort((a, b) => a.tax_rate - b.tax_rate);
}

/** Turns the model's whole answer into { invoice, items, taxSummary } in schema shape. */
function normalizeExtraction(raw) {
  const items = Array.isArray(raw?.line_items) ? raw.line_items : [];
  const normalizedItems = items.map((item, i) => normalizeItem(item, i + 1));
  const computedLinesTotal = normalizedItems.reduce((sum, item) => sum + (lineValue(item) || 0), 0);
  const roundedLinesTotal = computedLinesTotal > 0 ? roundPaise(computedLinesTotal) : null;

  // Invoice type defaults rather than falling back to null: the column is NOT
  // NULL, and 'TAX_INVOICE' is what every document this pipeline has ever
  // handled actually was. An unreadable type on a genuine credit note is
  // caught by the reviewer, who has the paper in hand.
  const printedType = normalizeText(raw?.invoice_type, 20);
  const invoice_type = printedType && ['TAX_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'].includes(printedType.toUpperCase())
    ? printedType.toUpperCase()
    : 'TAX_INVOICE';

  // Payment terms are a SEPARATE axis from document type. "CREDIT" here means
  // the pharmacy has not paid yet; it never means the document is a credit
  // note. Null when unreadable — an unpaid delivery guessed as CASH would
  // silently clear a payable.
  const printedPayment = normalizeText(raw?.payment_type, 20);
  const payment_type = printedPayment && ['CASH', 'CREDIT'].includes(printedPayment.toUpperCase())
    ? printedPayment.toUpperCase()
    : null;

  return {
    invoice: {
      // ── Vendor snapshot, as printed on the letterhead
      supplier_name_raw: normalizeText(raw?.supplier_name, 200),
      supplier_gstin: normalizeGstin(raw?.supplier_gstin),
      supplier_dl_no: normalizeText(raw?.supplier_dl_no, 100),
      supplier_phone: normalizePhone(raw?.supplier_phone),
      supplier_address: normalizeText(raw?.supplier_address, 400),
      supplier_pan: normalizeGstin(raw?.supplier_pan),
      supplier_email: normalizeText(raw?.supplier_email, 120),
      supplier_state: normalizeText(raw?.supplier_state, 60),
      supplier_state_code: normalizeStateCode(raw?.supplier_state_code),

      // ── Buyer snapshot: this pharmacy, as the vendor printed it
      buyer_name: normalizeText(raw?.buyer_name, 200),
      buyer_address: normalizeText(raw?.buyer_address, 400),
      buyer_gstin: normalizeGstin(raw?.buyer_gstin),
      buyer_pan: normalizeGstin(raw?.buyer_pan),
      buyer_dl_no: normalizeText(raw?.buyer_dl_no, 100),
      buyer_phone: normalizePhone(raw?.buyer_phone),
      buyer_state: normalizeText(raw?.buyer_state, 60),
      buyer_state_code: normalizeStateCode(raw?.buyer_state_code),

      // ── Document identity and references
      invoice_no: normalizeText(raw?.invoice_no, 60),
      invoice_date: normalizeDate(raw?.invoice_date),
      invoice_time: normalizeTime(raw?.invoice_time),
      invoice_type,
      payment_type,
      due_date: normalizeDate(raw?.due_date),
      transaction_date: normalizeDate(raw?.transaction_date),
      order_number: normalizeText(raw?.order_number, 60),
      order_date: normalizeDate(raw?.order_date),
      lr_number: normalizeText(raw?.lr_number, 60),
      lr_date: normalizeDate(raw?.lr_date),
      page_number: normalizeInt(raw?.page_number, { min: 1 }),
      total_pages: normalizeInt(raw?.total_pages, { min: 1 }),
      sales_executive: normalizeText(raw?.sales_executive, 120),
      printed_item_count: normalizeInt(raw?.printed_item_count, { min: 0 }),

      // ── Printed money. Transcribed, never computed here.
      //
      // taxable_total and net_total keep their long-standing fallback to the
      // lines sum so an unreadable footer still yields a usable draft. That
      // fallback is EX-GST, which is why validateInvoice now says so out loud
      // rather than letting a silent zero-GST reconciliation confirm it.
      subtotal: normalizeAmount(raw?.subtotal),
      total_discount: normalizeAmount(raw?.total_discount),
      taxable_total: normalizeAmount(raw?.taxable_total) ?? roundedLinesTotal,
      total_cgst: normalizeAmount(raw?.total_cgst),
      total_sgst: normalizeAmount(raw?.total_sgst),
      total_igst: normalizeAmount(raw?.total_igst),
      total_cess: normalizeAmount(raw?.total_cess),
      gst_total: normalizeAmount(raw?.gst_total),
      invoice_total: normalizeAmount(raw?.invoice_total),
      additional_amount: normalizeAmount(raw?.additional_amount),
      deduction_amount: normalizeAmount(raw?.deduction_amount),
      // Signed — see normalizeSignedAmount. A round-off is negative more often
      // than positive.
      adjustment_amount: normalizeSignedAmount(raw?.adjustment_amount),
      round_off: normalizeSignedAmount(raw?.round_off),
      net_total: normalizeAmount(raw?.net_total) ?? roundedLinesTotal,
    },
    items: normalizedItems,
    taxSummary: normalizeTaxSummary(raw),
  };
}

/**
 * Stock a line takes in, in SALEABLE UNITS — the denomination inventory_ledger
 * is counted in, and the one every other module means.
 *
 * The Pack column does not appear. "100'S" qty 5 is five strips, not five
 * hundred tablets. Multiplying here would post a quantity in a different
 * denomination to the one billing and FEFO decrement, which is silent stock
 * corruption rather than an arithmetic slip.
 *
 * Free goods are stock: they go on the shelf and they get sold.
 */
function totalUnits(item) {
  const billed = Number(item?.qty_billed) || 0;
  const free = Number(item?.qty_free) || 0;
  return billed + free;
}

/**
 * Total content received, for display only: 5 strips × 100 = 500 tablets.
 *
 * Kept strictly apart from totalUnits (Rule 7 and Rule 14: the invoice
 * calculation and the content calculation never mix). Nothing downstream
 * consumes this — it exists so a reviewer can check "500 tablets" against the
 * carton without that number ever reaching the ledger.
 *
 * For a nested pack it counts the sub-items through: 20 packs × 7 = 140 ampoules.
 */
function totalContent(item) {
  const units = totalUnits(item);
  const perUnit = Number(item?.sub_pack_quantity) || Number(item?.content_quantity);
  if (!units || !Number.isFinite(perUnit) || perUnit <= 0) return null;
  return {
    quantity: units * perUnit,
    unit: item?.sub_pack_quantity ? (item?.sub_pack_unit || 'PACK') : (item?.content_unit || null),
  };
}

/**
 * What the line costs, in rupees: billed saleable units at the per-unit cost.
 *
 * Net of discount, because `unit_cost` is. Compared against the PRINTED total,
 * which is gross, so on a discounted invoice the two legitimately differ by the
 * discount — validateItem reconciles against printedLineValue instead.
 *
 * Free goods are free, so they are excluded here even though totalUnits counts
 * them. That asymmetry is the point of tracking scheme quantity separately.
 */
function lineValue(item) {
  const billed = Number(item?.qty_billed) || 0;
  const cost = Number(item?.unit_cost) || 0;
  return roundPaise(billed * cost);
}

/**
 * What the invoice says this line costs: qty × rate as printed.
 *
 * The identity that holds on every line of every MARG invoice checked so far,
 * and the reconciliation LINE_TOTAL_MISMATCH runs. No pack multiplier, no basis
 * question — the rate applies to one Qty unit because that is what a rate is.
 */
function printedLineValue(item) {
  const billed = Number(item?.qty_billed) || 0;
  const rate = finiteOrNull(item?.printed_rate);
  if (rate === null) return null;
  return roundPaise(billed * rate);
}

module.exports = {
  normalizeExtraction,
  normalizeItem,
  normalizeTaxSummary,
  rederiveLine,
  normalizeExpiry,
  normalizeMfg,
  normalizeDate,
  normalizeAmount,
  normalizeSignedAmount,
  normalizeTime,
  normalizeStateCode,
  normalizeInt,
  normalizePercent,
  normalizeBatchNo,
  normalizeText,
  normalizeGstin,
  resolveDiscountPct,
  descriptionForMatching,
  parsePack,
  deriveSaleUnit,
  deriveUnitCost,
  deriveUnitMrp,
  perContentUnitPrice,
  roundPaise,
  totalUnits,
  totalContent,
  lineValue,
  printedLineValue,
};
