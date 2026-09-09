// ── Module 23: Supplier Invoices — deterministic validation
//
// Pure functions, same contract as the normaliser: no Supabase, no clock the
// caller cannot control. Everything the rules need that lives in the database
// — does this batch already exist, is this invoice a duplicate — arrives as a
// plain `context` object the service assembles first. That keeps this file
// unit-testable and keeps the rules readable as rules.
//
// Nothing here is a judgement call by the model. The model reads; these rules
// decide. Two severities, and the difference matters:
//
//   'error'   blocks Approve & Commit. The commit function raises on the same
//             condition, so shipping it would be a rolled-back transaction and
//             a Postgres string in front of a person holding a delivery.
//   'warning' is advisory. It is shown, it does not block. Short-dated stock
//             and an odd-looking total are things a pharmacist decides about,
//             not things software should refuse.
//
// Every code here has a matching human label in the frontend's
// domain/invoice.js. Adding a code without adding the label ships a raw
// SCREAMING_CASE string to the counter.

const { totalUnits, lineValue, printedLineValue } = require('./supplier-invoices.normalize');
const { finiteOrNull } = require('../../utils/money');
const {
  reconcileLine, gstMode,
  summariseByRate, deriveInvoiceTotals, reconcileTaxSummary,
} = require('./supplier-invoices.tax');

/** Batches expiring sooner than this are flagged — not blocked. */
const MIN_SHELF_LIFE_DAYS = 30;
/** Trigram score below which an auto-suggested medicine is called out. */
const LOW_CONFIDENCE = 0.6;
/** Rupee tolerance on printed-vs-computed totals. Distributors round per line. */
const MONEY_TOLERANCE = 1;
/** Proportional tolerance when checking the sum of lines against the taxable
 *  total — a 40-line invoice accumulates more rounding than a 2-line one. */
const TOTALS_TOLERANCE_RATIO = 0.02;

/** UTC midnight for a YYYY-MM-DD string, or NaN. Parsed by hand rather than
 *  through `new Date(str)` so a local timezone can never shift a date across a
 *  day boundary — at IST that would move every expiry one day earlier. */
function utcMidnight(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

/** Whole days from `fromIso` to `toIso`; NaN if either is unparseable, which
 *  every caller guards against before using the result. */
function daysBetween(fromIso, toIso) {
  const from = utcMidnight(fromIso);
  const to = utcMidnight(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  return Math.round((to - from) / 86_400_000);
}

function issue(code, severity, message, field) {
  return field ? { code, severity, message, field } : { code, severity, message };
}

/**
 * Validates one staged line.
 *
 * @param item    staging-row shaped: { medicine_id, batch_no, exp_date, ... }
 * @param context { today: 'YYYY-MM-DD', batchExists: boolean }
 * @returns array of issues, most severe first
 */
function validateItem(item, context = {}) {
  const found = [];
  if (item?.is_excluded) return found; // an excluded line is not going anywhere

  const today = context.today || new Date().toISOString().slice(0, 10);

  if (!item?.medicine_id) {
    found.push(issue(
      'UNMAPPED_MEDICINE', 'error',
      'This line is not linked to a medicine in the catalogue.',
      'medicine_id'
    ));
  } else if (item.match_source === 'auto' && Number(item.match_confidence) < LOW_CONFIDENCE) {
    found.push(issue(
      'LOW_MATCH_CONFIDENCE', 'warning',
      'The catalogue match was guessed from the printed name and is not a close one. Confirm it before importing.',
      'medicine_id'
    ));
  }

  if (!item?.batch_no) {
    found.push(issue('MISSING_BATCH', 'error', 'No batch number was read from this line.', 'batch_no'));
  }

  if (!item?.exp_date) {
    found.push(issue(
      'MISSING_EXPIRY', 'error',
      'No expiry date was read. FEFO billing sells the nearest expiry first, so a batch cannot enter stock without one.',
      'exp_date'
    ));
  } else {
    const shelfLife = daysBetween(today, item.exp_date);
    if (Number.isNaN(shelfLife)) {
      // Only reachable if something wrote a non-ISO expiry straight to the
      // column, bypassing the normaliser. Treated as unreadable, not as valid.
      found.push(issue('MISSING_EXPIRY', 'error', 'The expiry date on this line could not be read as a date.', 'exp_date'));
    } else if (shelfLife <= 0) {
      found.push(issue(
        'EXPIRED', 'error',
        'This batch has already expired. Do not take it into stock — return it to the distributor.',
        'exp_date'
      ));
    } else if (shelfLife < MIN_SHELF_LIFE_DAYS) {
      found.push(issue(
        'EXPIRY_TOO_SOON', 'warning',
        `Only ${shelfLife} day${shelfLife === 1 ? '' : 's'} of shelf life left. Check this was agreed with the distributor before accepting it.`,
        'exp_date'
      ));
    }
    if (item.mfg_date && item.mfg_date >= item.exp_date) {
      found.push(issue(
        'INVALID_DATES', 'error',
        'The manufacture date is on or after the expiry date — one of the two was misread.',
        'mfg_date'
      ));
    }
  }

  const units = totalUnits(item);
  if (units <= 0) {
    found.push(issue('MISSING_QTY', 'error', 'No quantity was read from this line.', 'qty_billed'));
  }

  // ── Pack contents ──────────────────────────────────────────────────────
  //
  // Advisory, not blocking, and that is the right severity now: the pack
  // description is informational. It does not enter the stock quantity or the
  // money, so an unreadable one cannot make an import wrong — it only leaves a
  // gap in what the shelf label will say.
  //
  // Rule 11/13: the suffix is what carries the meaning, and an unrecognised
  // pack is marked for review rather than guessed at. "100" alone could be
  // 100'S, 100ML, 100GM or 100MD, which are four different products.
  if (item?.pack_raw && item?.pack_recognised === false) {
    found.push(issue(
      'PACK_UNPARSEABLE', 'warning',
      `The pack “${item.pack_raw}” could not be read as a quantity and a unit. Stock and cost are unaffected — the quantity column is what counts — but the pack contents will be blank until it is corrected.`,
      'pack_raw'
    ));
  }

  const mrp = item?.mrp === null || item?.mrp === undefined ? null : Number(item.mrp);
  const cost = item?.unit_cost === null || item?.unit_cost === undefined ? null : Number(item.unit_cost);
  const selling = item?.selling_price === null || item?.selling_price === undefined ? null : Number(item.selling_price);

  if (mrp === null || !(mrp > 0)) {
    found.push(issue('MISSING_MRP', 'error', 'No MRP was read. It is needed to price the batch and to check the cost is sane.', 'mrp'));
  }
  if (cost === null) {
    found.push(issue('MISSING_COST', 'error', 'No purchase rate was read from this line.', 'unit_cost'));
  }
  if (mrp !== null && cost !== null && mrp > 0 && cost > mrp) {
    // Both figures are per saleable unit and neither is converted, so this is a
    // real inversion rather than a units artefact: importing it records a
    // loss-making margin on every future sale of the batch.
    const per = item?.sale_unit ? item.sale_unit.toLowerCase() : 'unit';
    found.push(issue(
      'COST_EXCEEDS_MRP', 'error',
      `The cost is ₹${cost.toFixed(2)} per ${per} against an MRP of ₹${mrp.toFixed(2)}. Check the printed rate and MRP on this line.`,
      'unit_cost'
    ));
  }

  // Selling price defaults to MRP if not explicitly specified
  const effectiveSelling = selling ?? mrp;
  if (effectiveSelling !== null && mrp !== null && mrp > 0 && effectiveSelling > mrp) {
    found.push(issue(
      'SELLING_ABOVE_MRP', 'error',
      'Selling price cannot be above the MRP printed on the pack.',
      'selling_price'
    ));
  }

  // ── Printed total reconciliation ───────────────────────────────────────
  //
  // qty × rate = line_total, the identity that holds on every line of every
  // MARG invoice checked so far. All three figures are transcribed and all
  // three are gross of discount, so a disagreement means one of them was
  // misread — there is no basis question and no pack multiplier involved.
  //
  // Skipped when the quantity is missing: MISSING_QTY has already said so, and
  // a second complaint about the total adds noise to a line whose problem is
  // already named.
  if (item?.line_total !== null && item?.line_total !== undefined && Number(item?.qty_billed) > 0) {
    const printed = printedLineValue(item);
    if (printed !== null) {
      if (Math.abs(printed - Number(item.line_total)) > MONEY_TOLERANCE) {
        const per = item?.sale_unit ? `${item.sale_unit.toLowerCase()}(s)` : 'unit(s)';
        found.push(issue(
          'LINE_TOTAL_MISMATCH', 'warning',
          `${Number(item.qty_billed)} ${per} at the printed rate comes to ₹${printed.toFixed(2)}, but the invoice prints ₹${Number(item.line_total).toFixed(2)}. One of the three figures was misread.`,
          'printed_rate'
        ));
      }
    }
  }

  if (context.batchExists) {
    found.push(issue(
      'BATCH_EXISTS', 'warning',
      'A batch with this number already exists for this medicine. Importing will be rejected as a duplicate — change the batch number if the distributor reused it.',
      'batch_no'
    ));
  }

  // ── Line tax ───────────────────────────────────────────────────────────
  //
  // All advisory, without exception. Tax takes no part in what becomes stock —
  // `unit_cost` is GST-exclusive and always has been — so a tax figure that
  // disagrees with itself cannot make an import wrong. It can only make a
  // GSTR-2 reconciliation wrong later, which is a thing a person fixes with
  // the paper in front of them, not a reason to refuse a delivery that is
  // physically standing at the counter.

  const mode = gstMode(item);
  if (mode === 'MIXED') {
    found.push(issue(
      'GST_SPLIT_INCONSISTENT', 'warning',
      'This line carries both IGST and CGST/SGST. A supply is either within the state or across it, never both — one of the columns was misread.',
      'igst_pct'
    ));
  } else if (mode === 'INTRA') {
    // CGST and SGST are each exactly half the rate, by statute. A split that
    // is not even is a column misalignment, and it is invisible in the total.
    const cgst = finiteOrNull(item?.cgst_pct);
    const sgst = finiteOrNull(item?.sgst_pct);
    if (cgst !== null && sgst !== null && Math.abs(cgst - sgst) > 0.001) {
      found.push(issue(
        'GST_SPLIT_INCONSISTENT', 'warning',
        `CGST is ${cgst}% and SGST is ${sgst}%. Within a state the two halves are always equal, so one of them was misread.`,
        'cgst_pct'
      ));
    }
  }

  for (const mismatch of reconcileLine(item)) {
    found.push(issue(
      'LINE_TAX_MISMATCH', 'warning',
      `The printed ${mismatch.field.replace(/_/g, ' ')} is ₹${mismatch.printed.toFixed(2)}, but this line's own rates give ₹${mismatch.computed.toFixed(2)}. Check the tax columns against the paper.`,
      mismatch.field
    ));
  }

  return found.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/**
 * Validates the document itself.
 *
 * @param invoice  staging-row shaped
 * @param items    already-validated staging rows (their own warnings are not
 *                 re-derived here; this is only about the document)
 * @param context  { today, duplicateInvoice: boolean }
 */
function validateInvoice(invoice, items = [], context = {}) {
  const found = [];
  const active = items.filter((i) => !i.is_excluded);

  if (!invoice?.supplier_id) {
    found.push(issue(
      'SUPPLIER_UNRESOLVED', 'error',
      invoice?.supplier_name_raw
        ? `“${invoice.supplier_name_raw}” did not match a supplier on file. Pick the right one, or add them under Suppliers first.`
        : 'No distributor was read from the document. Pick the supplier this invoice came from.',
      'supplier_id'
    ));
  }

  if (!invoice?.invoice_no) {
    found.push(issue('MISSING_INVOICE_NO', 'error', 'No invoice number was read. It is what makes a re-upload detectable as a duplicate.', 'invoice_no'));
  }
  if (context.duplicateInvoice) {
    found.push(issue(
      'DUPLICATE_INVOICE', 'error',
      'This invoice number has already been imported for this distributor. Importing it again would double the stock.',
      'invoice_no'
    ));
  }

  if (!invoice?.invoice_date) {
    found.push(issue('MISSING_INVOICE_DATE', 'warning', 'No invoice date was read. Add it so the purchase record dates correctly.', 'invoice_date'));
  } else if (context.today && daysBetween(context.today, invoice.invoice_date) > 1) {
    found.push(issue('FUTURE_INVOICE_DATE', 'warning', 'The invoice date is in the future — check it was read correctly.', 'invoice_date'));
  }

  if (active.length === 0) {
    found.push(issue(
      'NO_LINE_ITEMS', 'error',
      items.length === 0
        ? 'No line items were read from this document. If it is a photo, retake it square-on with the whole table in frame.'
        : 'Every line has been excluded, so there is nothing to take into stock.'
    ));
  }

  // The invoice's own statement of how many lines it has, against how many were
  // read. A dropped row is the one extraction failure a reviewer cannot see —
  // there is nothing on screen to notice the absence of — so where a format
  // prints the count, it is worth more than any other check here.
  //
  // Counts ALL lines, excluded ones included: a line the reviewer chose to drop
  // was still read, and re-flagging it would punish a decision already made.
  const printedCount = Number(invoice?.printed_item_count);
  if (Number.isFinite(printedCount) && printedCount > 0 && items.length !== printedCount) {
    const readCount = items.length;
    found.push(issue(
      'ITEM_COUNT_MISMATCH', 'warning',
      readCount < printedCount
        ? `The invoice says it has ${printedCount} lines but only ${readCount} were read. ${printedCount - readCount} may have been lost to a fold or a shadow — check the document before importing.`
        : `${readCount} lines were read but the invoice says it has ${printedCount}. Something that is not a product line may have been picked up as one.`
    ));
  }

  // ── Document totals ────────────────────────────────────────────────────
  //
  // finiteOrNull, NOT Number(). `Number(null)` is 0 and 0 is finite, so the
  // bare-Number version of this block read an UNREAD gst_total as "GST is
  // zero" — and then cheerfully confirmed taxable + 0 = net against a
  // net_total that had itself fallen back to the ex-GST lines sum. The one
  // case the reconciliation existed for was the one case it was blind to.
  // utils/money.js documents exactly this trap; the guard belongs here too.
  const taxable = finiteOrNull(invoice?.taxable_total);
  const gst = finiteOrNull(invoice?.gst_total);
  const net = finiteOrNull(invoice?.net_total);

  if (taxable !== null && gst !== null && net !== null) {
    if (Math.abs(taxable + gst - net) > MONEY_TOLERANCE) {
      found.push(issue(
        'TOTALS_MISMATCH', 'warning',
        `Taxable ₹${taxable.toFixed(2)} + GST ₹${gst.toFixed(2)} does not come to the net ₹${net.toFixed(2)}. One of the three was misread.`,
        'net_total'
      ));
    }
  } else if (gst === null && taxable !== null && net !== null && active.length > 0) {
    // The tax footer was not read at all. Say so, because the fallback that
    // filled net_total in its absence is the sum of EX-GST line values — a
    // figure that means "taxable", sitting in a column that means "payable".
    found.push(issue(
      'GST_TOTAL_UNREAD', 'warning',
      'No GST total was read from this document, so the net total may be the pre-tax figure rather than what is actually payable. Enter the tax total from the invoice footer.',
      'gst_total'
    ));
  }

  if (taxable !== null && taxable > 0 && active.length > 0) {
    const summed = active.reduce((sum, item) => sum + lineValue(item), 0);
    const tolerance = Math.max(MONEY_TOLERANCE, taxable * TOTALS_TOLERANCE_RATIO);
    if (Math.abs(summed - taxable) > tolerance) {
      found.push(issue(
        'LINES_TOTAL_MISMATCH', 'warning',
        `The lines add up to ₹${summed.toFixed(2)} but the invoice's taxable total is ₹${taxable.toFixed(2)}. A line may be missing, or a rate may be per pack instead of per unit.`,
        'taxable_total'
      ));
    }
  }

  // ── Document type ──────────────────────────────────────────────────────
  //
  // The one BLOCKING rule added here, and it blocks because the database
  // blocks: commit_supplier_invoice() refuses anything that is not a tax
  // invoice, so letting Approve run would produce a rolled-back transaction
  // and a mapped code where an inline, actionable message belongs.
  //
  // A credit note is not a defective invoice — it is a different document,
  // describing stock going the other way, which is what Supplier Returns is
  // for. The message says that rather than implying the reviewer mis-scanned.
  const invoiceType = invoice?.invoice_type;
  if (invoiceType && invoiceType !== 'TAX_INVOICE') {
    const label = invoiceType === 'CREDIT_NOTE' ? 'credit note' : 'debit note';
    found.push(issue(
      'INVOICE_TYPE_NOT_IMPORTABLE', 'error',
      `This document is a ${label}, which moves stock out rather than in. It has been recorded, but it cannot be taken into stock here — raise it under Supplier Returns instead.`,
      'invoice_type'
    ));
  }

  // ── Tax reconciliation ─────────────────────────────────────────────────
  //
  // Advisory throughout, for the reason given on the line-level block: tax is
  // not stock. What these do buy is the one extraction failure a reviewer
  // genuinely cannot see — a whole rate band's worth of lines dropped from a
  // multi-page table leaves nothing on screen to notice the absence of, and a
  // printed slab with no lines behind it is exactly that shape.

  const { rows: derivedRows, unresolvedLines } = summariseByRate(active);
  const printedRows = Array.isArray(invoice?.tax_summary) ? invoice.tax_summary : [];

  // Is this document carrying tax detail at all? A pre-Module-37 invoice has
  // none — no line rates, no summary block — and complaining that its lines
  // have no readable GST rate would put a warning on every legacy record and
  // on every invoice from a pharmacy that simply does not capture tax. The
  // rule worth having is the INCONSISTENT one: some lines carry a rate and
  // others do not, which means a rate band is quietly missing from the
  // summary. That needs at least one resolved rate, or a printed block, to be
  // true — so gate on exactly that.
  const documentCarriesTax = derivedRows.length > 0 || printedRows.length > 0;

  if (unresolvedLines > 0 && documentCarriesTax) {
    found.push(issue(
      'TAX_RATE_UNRESOLVED', 'warning',
      `${unresolvedLines} line${unresolvedLines === 1 ? ' carries' : 's carry'} money but no readable GST rate, so ${unresolvedLines === 1 ? 'it is' : 'they are'} absent from the tax summary. Set the rate on ${unresolvedLines === 1 ? 'that line' : 'those lines'} if this invoice is being kept for GST.`
    ));
  }

  for (const mismatch of reconcileTaxSummary(printedRows, derivedRows)) {
    if (mismatch.kind === 'missing') {
      found.push(issue(
        'TAX_SUMMARY_MISMATCH', 'warning',
        `The invoice's tax summary lists a ${mismatch.tax_rate}% band but no line was read at that rate. Lines at ${mismatch.tax_rate}% may be missing from the document.`,
        'tax_summary'
      ));
    } else if (mismatch.kind === 'extra') {
      found.push(issue(
        'TAX_SUMMARY_MISMATCH', 'warning',
        `Lines were read at ${mismatch.tax_rate}% but the invoice's tax summary has no band at that rate. Check the GST% on those lines.`,
        'tax_summary'
      ));
    } else {
      found.push(issue(
        'TAX_SUMMARY_MISMATCH', 'warning',
        `At ${mismatch.tax_rate}% the invoice prints ${mismatch.field.replace(/_/g, ' ')} of ₹${mismatch.printed.toFixed(2)}, but the lines at that rate come to ₹${mismatch.computed.toFixed(2)}.`,
        'tax_summary'
      ));
    }
  }

  // Net payable, against everything the lines and the adjustments imply.
  //
  // Gated on the LINES carrying tax, not just the document. A pre-Module-37
  // invoice has a gst_total in its footer and no per-line breakdown at all, so
  // the derived rollup would be ex-GST and would "disagree" with the printed
  // net by exactly the tax — reporting a defect on every single legacy record.
  // That check is already covered by TOTALS_MISMATCH, which compares the three
  // printed figures against each other and needs no line-level tax to do it.
  //
  // So this fires only where there is genuinely something new to say: the
  // lines carry their own tax, and rolling them up lands somewhere other than
  // where the vendor's footer does.
  if (net !== null && gst !== null && active.length > 0) {
    const derived = deriveInvoiceTotals(active, invoice);
    if (derived.net_payable !== null && derived.gst_total !== null) {
      const tolerance = Math.max(MONEY_TOLERANCE, Math.abs(net) * TOTALS_TOLERANCE_RATIO);
      if (Math.abs(derived.net_payable - net) > tolerance) {
        found.push(issue(
          'NET_PAYABLE_MISMATCH', 'warning',
          `The lines, tax and adjustments come to ₹${derived.net_payable.toFixed(2)} but the invoice's net total is ₹${net.toFixed(2)}. Check the round-off and any additional or deduction amounts.`,
          'net_total'
        ));
      }
    }
  }

  return found.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** True when nothing blocks the import. Warnings never block. */
function hasBlockingErrors(invoiceWarnings = [], items = []) {
  if (invoiceWarnings.some((w) => w.severity === 'error')) return true;
  return items.some(
    (item) => !item.is_excluded && (item.warnings || []).some((w) => w.severity === 'error')
  );
}

module.exports = {
  validateItem,
  validateInvoice,
  hasBlockingErrors,
  MIN_SHELF_LIFE_DAYS,
  LOW_CONFIDENCE,
};
