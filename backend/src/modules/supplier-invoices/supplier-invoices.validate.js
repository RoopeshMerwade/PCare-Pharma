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

  const taxable = Number(invoice?.taxable_total);
  const gst = Number(invoice?.gst_total);
  const net = Number(invoice?.net_total);

  if (Number.isFinite(taxable) && Number.isFinite(gst) && Number.isFinite(net)) {
    if (Math.abs(taxable + gst - net) > MONEY_TOLERANCE) {
      found.push(issue(
        'TOTALS_MISMATCH', 'warning',
        `Taxable ₹${taxable.toFixed(2)} + GST ₹${gst.toFixed(2)} does not come to the net ₹${net.toFixed(2)}. One of the three was misread.`,
        'net_total'
      ));
    }
  }

  if (Number.isFinite(taxable) && taxable > 0 && active.length > 0) {
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
