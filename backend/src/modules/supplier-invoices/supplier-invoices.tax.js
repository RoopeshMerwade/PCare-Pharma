// ── Module 23: Supplier Invoices — tax arithmetic
//
// Pure functions. No Supabase, no config, no clock — the same contract as
// .normalize.js, .validate.js and .extraction.js, and for the same reason:
// tests/unit/ has to be able to exercise every branch with no credentials and
// no network.
//
// WHAT THIS FILE IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR
//
// It computes a tax view of an invoice. It does NOT compute a cost. Nothing
// here touches `unit_cost`, and nothing here reaches inventory_batches or
// inventory_ledger. PCare is GST-registered, so input tax is reclaimed and is
// not part of what stock cost — that rule predates this file and is unchanged
// by it. If a figure computed here ever ends up in a batch's cost, the bug is
// that it was plumbed there, not that the arithmetic was wrong.
//
// THE RULE THIS FILE MOST NEEDS TO GET RIGHT — printed beats derived.
//
// Every function comes in two flavours and the difference is load-bearing:
//
//   compute*   arithmetic ONLY, from rates and bases. Never consults a
//              printed amount. This is the second opinion.
//   resolve*   the printed amount when the vendor gave one, the computed one
//              when they did not. This is what the screen and the slab rollup
//              use.
//
// Keeping them apart is what lets `reconcile*` say "the vendor printed ₹71.62
// and 18% of the base is ₹71.61" instead of silently agreeing with itself. A
// single function that overwrote a printed total with a computed one would
// make PCare's arithmetic authoritative over a figure the pharmacy actually
// pays against and a GST officer actually compares — which is exactly the
// wrong way round.
//
// MULTIPLE RATES PER INVOICE IS THE NORMAL CASE, NOT AN EDGE CASE.
// MEDICO M002948 carries nineteen lines at 12% and one at 18%. Nothing here
// takes a rate as a document-level parameter; the rate belongs to the line,
// and the document's view of tax is a rollup GROUPED BY that rate.

const { roundPaise, finiteOrNull } = require('../../utils/money');

/** Rupee tolerance when comparing a printed figure against a computed one.
 *  Distributors round per line and per slab, and those roundings accumulate in
 *  different orders than ours do — see the −₹0.39 divergence documented for
 *  M002948. A tolerance below this reports arithmetic noise as a finding. */
const TAX_TOLERANCE = 1;

/** Proportional tolerance for document-level comparisons, floored at
 *  TAX_TOLERANCE. A forty-line invoice accumulates more rounding than a
 *  two-line one, so a flat rupee tolerance is too strict at the top. */
const TAX_TOLERANCE_RATIO = 0.01;

function tolerance(base) {
  const n = finiteOrNull(base);
  return n === null ? TAX_TOLERANCE : Math.max(TAX_TOLERANCE, Math.abs(n) * TAX_TOLERANCE_RATIO);
}

/** Sum that stays null when EVERY contribution is null.
 *
 *  `[null, null].reduce((a,b) => a + (b||0), 0)` is 0, and 0 is a claim: it
 *  says the vendor charged no tax. Absent is not zero, and on a tax figure the
 *  difference is the difference between an exempt line and an unread one. */
function sumOrNull(values) {
  let total = null;
  for (const value of values) {
    const n = finiteOrNull(value);
    if (n === null) continue;
    total = (total === null ? 0 : total) + n;
  }
  return total === null ? null : roundPaise(total);
}

/* ── One line ─────────────────────────────────────────────────────────────── */

/**
 * The line's gross, before discount and before tax.
 *
 * Prefers the printed amount. `line_total` already holds this on every invoice
 * Module 23 has seen — a vendor's "Gross Amount" column and its "Amount"
 * column are the same concept, and the identity qty × rate = line_total is
 * verified on all 18 legible lines of M002948 and M002277.
 */
function resolveGross(item) {
  const printed = finiteOrNull(item?.line_total);
  if (printed !== null) return roundPaise(printed);
  const qty = finiteOrNull(item?.qty_billed);
  const rate = finiteOrNull(item?.printed_rate);
  if (qty === null || rate === null) return null;
  return roundPaise(qty * rate);
}

/**
 * The line's discount in rupees.
 *
 * Printed amount first, then the percentage applied to the gross. Both are
 * real columns on real invoices and plenty of vendors print only one of them.
 */
function computeDiscountAmount(item) {
  const gross = resolveGross(item);
  const pct = finiteOrNull(item?.discount_pct);
  if (gross === null || pct === null) return null;
  if (pct < 0 || pct > 100) return null;
  return roundPaise(gross * (pct / 100));
}

function resolveDiscountAmount(item) {
  const printed = finiteOrNull(item?.discount_amount);
  if (printed !== null) return roundPaise(printed);
  return computeDiscountAmount(item);
}

/**
 * The taxable value of the line: gross less discount.
 *
 * This is the base every tax component is charged on, and it is the number
 * that has to agree with the vendor's own slab summary. Printed first — a
 * vendor that prints a taxable column has already settled the rounding
 * question for this line, and we should not re-open it.
 */
function computeTaxableAmount(item) {
  const gross = resolveGross(item);
  if (gross === null) return null;
  const discount = resolveDiscountAmount(item) ?? 0;
  return roundPaise(gross - discount);
}

function resolveTaxableAmount(item) {
  const printed = finiteOrNull(item?.taxable_amount);
  if (printed !== null) return roundPaise(printed);
  return computeTaxableAmount(item);
}

/**
 * The line's TOTAL tax rate — the key the summary groups on.
 *
 * `gst_pct` when the vendor printed a single rate column, otherwise
 * reconstructed from whichever half of the split is present. CGST and SGST are
 * each half the rate, so they are ADDED; IGST is the whole rate on its own and
 * is never added to them.
 *
 * Returns null rather than 0 when nothing is readable: a rate of zero is a
 * real answer (an exempt line) and must not be indistinguishable from an
 * unread one.
 */
function resolveTaxRate(item) {
  const gst = finiteOrNull(item?.gst_pct);
  if (gst !== null) return gst;

  const igst = finiteOrNull(item?.igst_pct);
  if (igst !== null) return igst;

  const cgst = finiteOrNull(item?.cgst_pct);
  const sgst = finiteOrNull(item?.sgst_pct);
  if (cgst !== null || sgst !== null) return roundPaise((cgst ?? 0) + (sgst ?? 0));

  return null;
}

/**
 * Which side of the intra/inter-state line this row sits on.
 *
 *   'INTRA'    CGST + SGST — the seller and the pharmacy are in one state
 *   'INTER'    IGST — they are not
 *   'EXEMPT'   a rate is stated and it is zero
 *   'MIXED'    both are present, which no legitimate line ever is
 *   'UNKNOWN'  nothing readable
 *
 * MIXED exists so it can be reported. A line carrying both is a misread of a
 * column header — the two schemes are mutually exclusive by statute — and it
 * would otherwise be double-counted into the slab rollup.
 */
function gstMode(item) {
  const hasIgst = finiteOrNull(item?.igst_pct) > 0 || finiteOrNull(item?.igst_amount) > 0;
  const hasIntra =
    finiteOrNull(item?.cgst_pct) > 0 || finiteOrNull(item?.sgst_pct) > 0 ||
    finiteOrNull(item?.cgst_amount) > 0 || finiteOrNull(item?.sgst_amount) > 0;

  if (hasIgst && hasIntra) return 'MIXED';
  if (hasIgst) return 'INTER';
  if (hasIntra) return 'INTRA';

  const rate = resolveTaxRate(item);
  if (rate === 0) return 'EXEMPT';
  return 'UNKNOWN';
}

/**
 * Every tax component computed from its own rate — the second opinion.
 *
 * Never reads a printed amount, so `reconcileLine` below has something
 * independent to compare against. A component whose percentage is absent
 * stays null rather than becoming zero.
 */
function computeLineTax(item) {
  const taxable = resolveTaxableAmount(item);
  const at = (pct) => {
    const p = finiteOrNull(pct);
    if (p === null || taxable === null) return null;
    return roundPaise(taxable * (p / 100));
  };
  return {
    cgst_amount: at(item?.cgst_pct),
    sgst_amount: at(item?.sgst_pct),
    igst_amount: at(item?.igst_pct),
    cess_amount: at(item?.cess_pct),
  };
}

/**
 * The line's full money picture, printed where printed, computed where not.
 *
 * This is what the slab rollup consumes and what the review screen shows. It
 * is NOT written back over the printed columns — the service persists only
 * what a human or the extractor put there.
 */
function resolveLineTax(item) {
  const computed = computeLineTax(item);
  const pick = (printed, fallback) => {
    const p = finiteOrNull(printed);
    return p === null ? fallback : roundPaise(p);
  };

  const cgst_amount = pick(item?.cgst_amount, computed.cgst_amount);
  const sgst_amount = pick(item?.sgst_amount, computed.sgst_amount);
  const igst_amount = pick(item?.igst_amount, computed.igst_amount);
  const cess_amount = pick(item?.cess_amount, computed.cess_amount);

  const gross_amount = resolveGross(item);
  const discount_amount = resolveDiscountAmount(item);
  const taxable_amount = resolveTaxableAmount(item);
  const total_tax = sumOrNull([cgst_amount, sgst_amount, igst_amount, cess_amount]);

  // Printed net first: a vendor's "Net Amount" column has already settled how
  // they rounded this line, and it is what their slab summary will add up.
  const printedNet = finiteOrNull(item?.net_amount);
  const net_amount = printedNet !== null
    ? roundPaise(printedNet)
    : (taxable_amount === null ? null : roundPaise(taxable_amount + (total_tax ?? 0)));

  return {
    tax_rate: resolveTaxRate(item),
    gst_mode: gstMode(item),
    gross_amount,
    discount_amount,
    taxable_amount,
    cgst_amount,
    sgst_amount,
    igst_amount,
    cess_amount,
    total_tax,
    net_amount,
  };
}

/**
 * Disagreements between what a line PRINTS and what its own rates imply.
 *
 * Returns bare {field, printed, computed} records; validate.js turns them into
 * warnings with severities and messages. Kept as data here so this file stays
 * free of user-facing prose and stays testable as arithmetic.
 */
function reconcileLine(item) {
  const found = [];
  if (!item || item.is_excluded) return found;

  const computed = computeLineTax(item);
  for (const field of ['cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount']) {
    const printed = finiteOrNull(item[field]);
    const derived = computed[field];
    if (printed === null || derived === null) continue;
    if (Math.abs(printed - derived) > tolerance(derived)) {
      found.push({ field, printed, computed: derived });
    }
  }

  // The taxable base itself: gross − discount is arithmetic the vendor also
  // did, and a disagreement here moves every component above it.
  const printedTaxable = finiteOrNull(item.taxable_amount);
  const computedTaxable = computeTaxableAmount(item);
  if (printedTaxable !== null && computedTaxable !== null
      && Math.abs(printedTaxable - computedTaxable) > tolerance(computedTaxable)) {
    found.push({ field: 'taxable_amount', printed: printedTaxable, computed: computedTaxable });
  }

  return found;
}

/* ── The document ─────────────────────────────────────────────────────────── */

/**
 * The slab rollup: one row per distinct tax rate across the invoice's lines.
 *
 * THIS is the answer to "multiple GST rates in one invoice". The rate is never
 * a property of the document — it is a property of the line, and the document
 * gets as many summary rows as its lines have distinct rates. A 5/12/18
 * invoice produces three rows and needs no special handling anywhere.
 *
 * Excluded lines are left out: a line the reviewer dropped is not being bought
 * and must not appear in the tax the pharmacy claims.
 *
 * Lines with no readable rate are left out too, and `unresolvedLines` counts
 * them so the caller can say so rather than quietly rolling them into a slab
 * they may not belong to.
 */
function summariseByRate(items = []) {
  const buckets = new Map();
  let unresolvedLines = 0;

  for (const item of items) {
    if (!item || item.is_excluded) continue;
    const resolved = resolveLineTax(item);
    if (resolved.tax_rate === null) {
      // Only counted as unresolved when the line actually carries money;
      // a wholly blank staged line has nothing to classify yet.
      if (resolved.gross_amount !== null) unresolvedLines += 1;
      continue;
    }

    const key = roundPaise(resolved.tax_rate);
    const bucket = buckets.get(key) || {
      tax_rate: key,
      basic_amount: [], discount_amount: [], taxable_amount: [],
      cgst_amount: [], sgst_amount: [], igst_amount: [], cess_amount: [],
      line_count: 0,
    };

    bucket.basic_amount.push(resolved.gross_amount);
    bucket.discount_amount.push(resolved.discount_amount);
    bucket.taxable_amount.push(resolved.taxable_amount);
    bucket.cgst_amount.push(resolved.cgst_amount);
    bucket.sgst_amount.push(resolved.sgst_amount);
    bucket.igst_amount.push(resolved.igst_amount);
    bucket.cess_amount.push(resolved.cess_amount);
    bucket.line_count += 1;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()]
    .map((b) => {
      const cgst = sumOrNull(b.cgst_amount);
      const sgst = sumOrNull(b.sgst_amount);
      const igst = sumOrNull(b.igst_amount);
      const cess = sumOrNull(b.cess_amount);
      return {
        tax_rate: b.tax_rate,
        basic_amount: sumOrNull(b.basic_amount),
        discount_amount: sumOrNull(b.discount_amount),
        taxable_amount: sumOrNull(b.taxable_amount),
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: igst,
        cess_amount: cess,
        total_tax: sumOrNull([cgst, sgst, igst, cess]),
        line_count: b.line_count,
      };
    })
    .sort((a, b) => a.tax_rate - b.tax_rate);

  return { rows, unresolvedLines };
}

/**
 * The document's derived money, rolled up from its lines.
 *
 * Every field here is DERIVED and none of it is written over the transcribed
 * header. The service returns it beside the printed values so a reviewer sees
 * both, and validate.js compares them.
 *
 * `net_payable` folds in the four document-level adjustments. Two of them are
 * signed on purpose: a round-off is negative more often than positive, and an
 * adjustment can go either way.
 */
function deriveInvoiceTotals(items = [], header = {}) {
  const { rows } = summariseByRate(items);

  const active = (items || []).filter((i) => i && !i.is_excluded);
  const resolved = active.map(resolveLineTax);

  const subtotal = sumOrNull(resolved.map((r) => r.gross_amount));
  const total_discount = sumOrNull(resolved.map((r) => r.discount_amount));
  const taxable_total = sumOrNull(resolved.map((r) => r.taxable_amount));
  const total_cgst = sumOrNull(rows.map((r) => r.cgst_amount));
  const total_sgst = sumOrNull(rows.map((r) => r.sgst_amount));
  const total_igst = sumOrNull(rows.map((r) => r.igst_amount));
  const total_cess = sumOrNull(rows.map((r) => r.cess_amount));
  const gst_total = sumOrNull([total_cgst, total_sgst, total_igst, total_cess]);

  const invoice_total = taxable_total === null
    ? null
    : roundPaise(taxable_total + (gst_total ?? 0));

  const additional = finiteOrNull(header?.additional_amount) ?? 0;
  const deduction = finiteOrNull(header?.deduction_amount) ?? 0;
  const adjustment = finiteOrNull(header?.adjustment_amount) ?? 0;   // signed
  const roundOff = finiteOrNull(header?.round_off) ?? 0;             // signed

  const net_payable = invoice_total === null
    ? null
    : roundPaise(invoice_total + additional - deduction + adjustment + roundOff);

  return {
    subtotal,
    total_discount,
    taxable_total,
    total_cgst,
    total_sgst,
    total_igst,
    total_cess,
    gst_total,
    invoice_total,
    net_payable,
    tax_summary: rows,
  };
}

/**
 * Compares the vendor's transcribed slab block against our rollup of the lines.
 *
 * Three kinds of finding, and the first is the one worth having:
 *
 *   'missing'   the vendor printed a slab we found no lines for — a whole rate
 *               band's worth of lines was dropped in extraction, which is the
 *               failure a reviewer cannot see because nothing is on screen to
 *               notice the absence of
 *   'extra'     we found lines at a rate the vendor's summary does not list
 *   'amount'    both agree the slab exists and disagree about a figure
 *
 * Data only; validate.js writes the prose.
 */
function reconcileTaxSummary(printedRows = [], derivedRows = []) {
  const found = [];
  const byRate = (list) => new Map(
    (list || [])
      .filter((r) => finiteOrNull(r?.tax_rate) !== null)
      .map((r) => [roundPaise(Number(r.tax_rate)), r])
  );

  const printed = byRate(printedRows);
  const derived = byRate(derivedRows);
  if (printed.size === 0) return found;

  for (const [rate, row] of printed) {
    const mine = derived.get(rate);
    if (!mine) {
      found.push({ kind: 'missing', tax_rate: rate, printed: finiteOrNull(row.taxable_amount) });
      continue;
    }
    for (const field of ['taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'total_tax']) {
      const p = finiteOrNull(row[field]);
      const d = finiteOrNull(mine[field]);
      if (p === null || d === null) continue;
      if (Math.abs(p - d) > tolerance(d)) {
        found.push({ kind: 'amount', tax_rate: rate, field, printed: p, computed: d });
      }
    }
  }

  for (const [rate, row] of derived) {
    if (!printed.has(rate)) {
      found.push({ kind: 'extra', tax_rate: rate, computed: finiteOrNull(row.taxable_amount) });
    }
  }

  return found;
}

module.exports = {
  resolveGross,
  computeDiscountAmount,
  resolveDiscountAmount,
  computeTaxableAmount,
  resolveTaxableAmount,
  resolveTaxRate,
  gstMode,
  computeLineTax,
  resolveLineTax,
  reconcileLine,
  summariseByRate,
  deriveInvoiceTotals,
  reconcileTaxSummary,
  sumOrNull,
  TAX_TOLERANCE,
  TAX_TOLERANCE_RATIO,
};
