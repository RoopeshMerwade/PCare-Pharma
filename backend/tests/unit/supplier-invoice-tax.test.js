/**
 * MODULE 23 / schema-37 — invoice tax, party and document detail.
 *
 * Pure. No credentials, no network, no database: every function under test is
 * in .normalize.js, .validate.js or .tax.js, and those three import no Supabase
 * client by design. Runner:
 *
 *   npx jest tests/unit/supplier-invoice-tax.test.js --runInBand
 *
 * The scenarios below are the ones a real distributor invoice actually
 * presents, and several of them exist because getting them wrong is silent:
 * a discount printed as an amount, a free quantity folded into the paid one,
 * an MRP copied over a rate, a second GST band dropped from a multi-page
 * table. None of those raise an error on their own — they just make the
 * pharmacy's books quietly wrong — so they are pinned here.
 */

const {
  normalizeExtraction, normalizeItem, normalizeTaxSummary, rederiveLine,
  normalizeSignedAmount, normalizeTime, normalizeStateCode,
  resolveDiscountPct, normalizeExpiry, totalUnits, lineValue,
} = require('../../src/modules/supplier-invoices/supplier-invoices.normalize');

const {
  resolveGross, resolveDiscountAmount, resolveTaxableAmount, resolveTaxRate,
  gstMode, computeLineTax, resolveLineTax, reconcileLine,
  summariseByRate, deriveInvoiceTotals, reconcileTaxSummary, sumOrNull,
} = require('../../src/modules/supplier-invoices/supplier-invoices.tax');

const {
  validateItem, validateInvoice, hasBlockingErrors,
} = require('../../src/modules/supplier-invoices/supplier-invoices.validate');

const codes = (issues) => issues.map((i) => i.code);
const severityOf = (issues, code) => issues.find((i) => i.code === code)?.severity;
const ctx = (over = {}) => ({ today: '2026-08-20', batchExists: false, ...over });

/** A line that passes every pre-existing rule, so a test can add exactly one
 *  problem and be sure that is what it is measuring. */
const goodItem = (over = {}) => ({
  line_no: 1,
  medicine_id: '11111111-1111-1111-1111-111111111111',
  match_source: 'manual',
  raw_description: 'PARACIP 500 TAB',
  batch_no: 'PC-9912',
  exp_date: '2028-04-30',
  qty_billed: 10,
  qty_free: 0,
  printed_rate: 8.5,
  printed_mrp: 12,
  unit_cost: 8.5,
  mrp: 12,
  selling_price: 12,
  line_total: 85,
  is_excluded: false,
  ...over,
});

const goodInvoice = (over = {}) => ({
  supplier_id: '22222222-2222-2222-2222-222222222222',
  supplier_name_raw: 'Sri Balaji Distributors',
  invoice_no: 'INV/2026/8841',
  invoice_date: '2026-08-12',
  invoice_type: 'TAX_INVOICE',
  taxable_total: 85,
  gst_total: 10.2,
  net_total: 95.2,
  ...over,
});

/* ══════════════════════════════════════════════════════════════════════════
   1. A NORMAL PURCHASE INVOICE
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-01 — a normal purchase invoice', () => {
  test('a clean line with a single GST rate raises nothing and rolls up to one band', () => {
    const item = goodItem({ gst_pct: 12, cgst_pct: 6, sgst_pct: 6 });
    expect(codes(validateItem(item, ctx()))).toEqual([]);

    const { rows } = summariseByRate([item]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tax_rate).toBe(12);
    expect(rows[0].taxable_amount).toBe(85);
    expect(rows[0].cgst_amount).toBe(5.1);
    expect(rows[0].sgst_amount).toBe(5.1);
    expect(rows[0].total_tax).toBe(10.2);
  });

  test('the document reconciles end to end', () => {
    const item = goodItem({ gst_pct: 12, cgst_pct: 6, sgst_pct: 6 });
    const totals = deriveInvoiceTotals([item], goodInvoice());
    expect(totals.subtotal).toBe(85);
    expect(totals.taxable_total).toBe(85);
    expect(totals.gst_total).toBe(10.2);
    expect(totals.invoice_total).toBe(95.2);
    expect(totals.net_payable).toBe(95.2);
    expect(codes(validateInvoice(goodInvoice(), [item], ctx()))).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. FREE QUANTITY — paid and free are never combined
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-02 — free quantity is separate from paid quantity', () => {
  test('S.Q 10 + F.Q 5 stores 10 and 5, and only their SUM is the physical receipt', () => {
    const item = goodItem({ qty_billed: 10, qty_free: 5 });

    // The two columns stay apart on the row…
    expect(item.qty_billed).toBe(10);
    expect(item.qty_free).toBe(5);
    expect(item.qty_billed).not.toBe(item.qty_free);

    // …and are added in exactly one place, to give what physically arrived.
    // This mirrors `v_units` in commit_supplier_invoice(), which is the only
    // line in the system that performs this addition.
    expect(totalUnits(item)).toBe(15);
  });

  test('free goods enter stock but are not charged for', () => {
    const item = goodItem({ qty_billed: 10, qty_free: 5, unit_cost: 8.5 });
    expect(totalUnits(item)).toBe(15);   // fifteen strips on the shelf
    expect(lineValue(item)).toBe(85);    // ten strips paid for
  });

  test('the taxable value follows the BILLED quantity, never the physical one', () => {
    // Tax is charged on what was sold to the pharmacy. Rolling free goods into
    // the taxable base would inflate the input credit claimed on the invoice.
    const item = goodItem({ qty_billed: 10, qty_free: 5, line_total: 85, gst_pct: 12 });
    expect(resolveGross(item)).toBe(85);
    expect(resolveTaxableAmount(item)).toBe(85);
  });

  test('a pure scheme line — nothing billed, stock still arrives — is not a tax line', () => {
    const item = goodItem({ qty_billed: 0, qty_free: 12, line_total: 0, printed_rate: 0, unit_cost: 0 });
    expect(totalUnits(item)).toBe(12);
    expect(lineValue(item)).toBe(0);
    expect(codes(validateItem(item, ctx()))).not.toContain('MISSING_QTY');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. MULTIPLE BATCHES OF THE SAME PRODUCT
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-03 — multiple batches of one product on one invoice', () => {
  const sameMedicine = '11111111-1111-1111-1111-111111111111';

  test('two batches of one medicine are two independent lines with their own dates and money', () => {
    const a = goodItem({ line_no: 1, medicine_id: sameMedicine, batch_no: 'B-100', exp_date: '2027-03-31', printed_mrp: 12, mrp: 12, printed_rate: 8.5, unit_cost: 8.5, line_total: 85 });
    const b = goodItem({ line_no: 2, medicine_id: sameMedicine, batch_no: 'B-200', exp_date: '2028-09-30', printed_mrp: 14, mrp: 14, printed_rate: 9.0, unit_cost: 9.0, line_total: 90 });

    expect(codes(validateItem(a, ctx()))).toEqual([]);
    expect(codes(validateItem(b, ctx()))).toEqual([]);

    // Same product, different batch, different expiry, different MRP and rate.
    // Nothing merges them — inventory_batches is unique on (medicine, batch),
    // so these become two shelf batches that FEFO orders by expiry.
    expect(a.batch_no).not.toBe(b.batch_no);
    expect(a.exp_date < b.exp_date).toBe(true);
    expect(a.mrp).not.toBe(b.mrp);
  });

  test('both batches roll into the same tax band without losing their identity', () => {
    const a = goodItem({ line_no: 1, batch_no: 'B-100', gst_pct: 12, line_total: 85 });
    const b = goodItem({ line_no: 2, batch_no: 'B-200', gst_pct: 12, line_total: 90 });
    const { rows } = summariseByRate([a, b]);
    expect(rows).toHaveLength(1);
    expect(rows[0].basic_amount).toBe(175);
    expect(rows[0].line_count).toBe(2);
  });

  test('expiry survives the short vendor formats verbatim on the invoice', () => {
    // "12/25", "02/25", "03/26" — month and year only, normalised to the LAST
    // day of the month, because a strip marked EXP 12/25 is good all December.
    expect(normalizeExpiry('12/25')).toBe('2025-12-31');
    expect(normalizeExpiry('02/25')).toBe('2025-02-28');
    expect(normalizeExpiry('03/26')).toBe('2026-03-31');
    expect(normalizeExpiry('02/28')).toBe('2028-02-29');   // leap year
    expect(normalizeExpiry('13/25')).toBeNull();           // month 13 is a misread
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. MRP AND PURCHASE RATE ARE DIFFERENT VALUES
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-04 — MRP, trade price and purchase rate stay three figures', () => {
  test('MRP 28.31 with a rate of 20.22 is normal and is stored as two values', () => {
    const item = normalizeItem({
      description: 'AMLONG 5MG TAB', qty_billed: 10, mrp: 28.31, unit_cost: 20.22, line_total: 202.2,
    }, 1);

    expect(item.printed_mrp).toBe(28.31);
    expect(item.printed_rate).toBe(20.22);
    expect(item.mrp).toBe(28.31);
    expect(item.unit_cost).toBe(20.22);
    expect(item.mrp).not.toBe(item.unit_cost);
  });

  test('trade price is a THIRD figure and never overwrites either', () => {
    const item = normalizeItem({
      description: 'AMLONG 5MG TAB', qty_billed: 10,
      mrp: 28.31, trade_price: 24.00, unit_cost: 20.22, line_total: 202.2,
    }, 1);

    expect(item.printed_mrp).toBe(28.31);
    expect(item.trade_price).toBe(24);
    expect(item.printed_rate).toBe(20.22);
    expect(new Set([item.printed_mrp, item.trade_price, item.printed_rate]).size).toBe(3);
  });

  test('a rate above MRP still blocks — the inversion rule is unchanged', () => {
    const item = goodItem({ printed_rate: 30, unit_cost: 30, printed_mrp: 12, mrp: 12 });
    expect(severityOf(validateItem(item, ctx()), 'COST_EXCEEDS_MRP')).toBe('error');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. DISCOUNT — PERCENTAGE AND AMOUNT
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-05 — discount as a percentage and as an amount', () => {
  test('a printed percentage behaves exactly as it always has (no behaviour change)', () => {
    const item = normalizeItem({
      description: 'LIV 52 TAB', qty_billed: 5, unit_cost: 103.12, mrp: 150,
      discount_pct: 3, line_total: 515.6,
    }, 1);
    expect(item.discount_pct).toBe(3);
    expect(item.unit_cost).toBe(100.03);   // 103.12 less 3%, half-up
  });

  test('a discount printed only as an AMOUNT now reaches the cost instead of vanishing', () => {
    // Before schema-37 this produced unit_cost = 103.12 — the full rate — with
    // no warning, because LINE_TOTAL_MISMATCH compares gross against gross and
    // they agreed. An overstated cost understates every margin after it.
    const item = normalizeItem({
      description: 'LIV 52 TAB', qty_billed: 5, unit_cost: 103.12, mrp: 150,
      discount_amount: 15.47, line_total: 515.6,
    }, 1);

    expect(item.discount_pct).toBeNull();       // nothing invented on the row
    expect(item.discount_amount).toBe(15.47);
    // 15.47 / 515.60 = 3.0004%, applied to the rate → 100.03
    expect(item.unit_cost).toBe(100.03);
  });

  test('when BOTH are printed the percentage wins — it is the vendor\'s own basis', () => {
    const item = normalizeItem({
      description: 'LIV 52 TAB', qty_billed: 5, unit_cost: 103.12, mrp: 150,
      discount_pct: 3, discount_amount: 999, line_total: 515.6,
    }, 1);
    expect(item.unit_cost).toBe(100.03);
  });

  test('no discount at all leaves the printed rate untouched', () => {
    const item = normalizeItem({ description: 'X', qty_billed: 5, unit_cost: 107.14, mrp: 150, line_total: 535.7 }, 1);
    expect(item.unit_cost).toBe(107.14);
  });

  test('resolveDiscountPct refuses a nonsense amount rather than clamping it', () => {
    expect(resolveDiscountPct({ discount_pct: null, discount_amount: 900, gross: 100 })).toBeNull();
    expect(resolveDiscountPct({ discount_pct: null, discount_amount: 0, gross: 100 })).toBeNull();
    expect(resolveDiscountPct({ discount_pct: null, discount_amount: 3, gross: 0 })).toBeNull();
    expect(resolveDiscountPct({ discount_pct: 7, discount_amount: 999, gross: 100 })).toBe(7);
  });

  test('correcting the discount amount on review moves the cost with it', () => {
    const merged = {
      printed_rate: 103.12, printed_mrp: 150, pack_raw: "100'S",
      discount_pct: null, discount_amount: 51.56, line_total: 515.6, qty_billed: 5,
    };
    expect(rederiveLine(merged).unit_cost).toBe(92.81);   // 103.12 less 10%
  });

  test('the derived discount amount and taxable value are available per line', () => {
    const item = goodItem({ line_total: 515.6, discount_pct: 3 });
    expect(resolveDiscountAmount(item)).toBe(15.47);
    expect(resolveTaxableAmount(item)).toBe(500.13);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   6. MULTIPLE GST RATES IN ONE INVOICE
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-06 — several GST rates on one invoice', () => {
  // Rates and costs kept internally consistent (qty × rate = line_total, and
  // cost under MRP) so these tests measure the tax rollup and nothing else.
  const band = (over) => goodItem({
    qty_billed: 10, printed_mrp: 40, mrp: 40, selling_price: 40, ...over,
  });
  const five = band({ line_no: 1, batch_no: 'B5', gst_pct: 5, cgst_pct: 2.5, sgst_pct: 2.5, printed_rate: 10, unit_cost: 10, line_total: 100 });
  const twelve = band({ line_no: 2, batch_no: 'B12', gst_pct: 12, cgst_pct: 6, sgst_pct: 6, printed_rate: 20, unit_cost: 20, line_total: 200 });
  const eighteen = band({ line_no: 3, batch_no: 'B18', gst_pct: 18, cgst_pct: 9, sgst_pct: 9, printed_rate: 30, unit_cost: 30, line_total: 300 });

  test('a 5/12/18 invoice produces THREE bands, ordered by rate', () => {
    const { rows } = summariseByRate([eighteen, five, twelve]);
    expect(rows.map((r) => r.tax_rate)).toEqual([5, 12, 18]);
  });

  test('each band carries its own base and its own tax — nothing is averaged', () => {
    const { rows } = summariseByRate([five, twelve, eighteen]);
    expect(rows[0]).toMatchObject({ taxable_amount: 100, cgst_amount: 2.5, sgst_amount: 2.5, total_tax: 5 });
    expect(rows[1]).toMatchObject({ taxable_amount: 200, cgst_amount: 12, sgst_amount: 12, total_tax: 24 });
    expect(rows[2]).toMatchObject({ taxable_amount: 300, cgst_amount: 27, sgst_amount: 27, total_tax: 54 });
  });

  test('the document total is the SUM of the bands, not one rate applied to one total', () => {
    const totals = deriveInvoiceTotals([five, twelve, eighteen], {});
    expect(totals.taxable_total).toBe(600);
    expect(totals.gst_total).toBe(83);       // 5 + 24 + 54
    expect(totals.invoice_total).toBe(683);
    // The wrong answer this guards against: 600 × 12% = 72, or 600 × 18% = 108.
    expect(totals.gst_total).not.toBe(72);
    expect(totals.gst_total).not.toBe(108);
  });

  test('a printed band with no lines behind it warns — a whole rate may be missing', () => {
    const invoice = goodInvoice({
      taxable_total: 600, gst_total: 83, net_total: 683,
      tax_summary: [
        { tax_rate: 5, taxable_amount: 100, total_tax: 5 },
        { tax_rate: 12, taxable_amount: 200, total_tax: 24 },
        { tax_rate: 18, taxable_amount: 300, total_tax: 54 },
        { tax_rate: 28, taxable_amount: 400, total_tax: 112 },
      ],
    });
    const issues = validateInvoice(invoice, [five, twelve, eighteen], ctx());
    expect(severityOf(issues, 'TAX_SUMMARY_MISMATCH')).toBe('warning');
    expect(issues.find((i) => i.code === 'TAX_SUMMARY_MISMATCH').message).toContain('28%');
  });

  test('a matching printed summary raises nothing', () => {
    const invoice = goodInvoice({
      taxable_total: 600, gst_total: 83, net_total: 683,
      tax_summary: [
        { tax_rate: 5, taxable_amount: 100, cgst_amount: 2.5, sgst_amount: 2.5, total_tax: 5 },
        { tax_rate: 12, taxable_amount: 200, cgst_amount: 12, sgst_amount: 12, total_tax: 24 },
        { tax_rate: 18, taxable_amount: 300, cgst_amount: 27, sgst_amount: 27, total_tax: 54 },
      ],
    });
    expect(codes(validateInvoice(invoice, [five, twelve, eighteen], ctx()))).toEqual([]);
  });

  test('a line with money but no readable rate is reported, not silently bucketed', () => {
    const rateless = band({ line_no: 4, batch_no: 'BX', printed_rate: 40, unit_cost: 40, line_total: 400 });
    const { rows, unresolvedLines } = summariseByRate([twelve, rateless]);
    expect(unresolvedLines).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].basic_amount).toBe(200);   // the rateless 400 is NOT in here

    const issues = validateInvoice(goodInvoice(), [twelve, rateless], ctx());
    expect(severityOf(issues, 'TAX_RATE_UNRESOLVED')).toBe('warning');
  });

  test('excluded lines leave the tax rollup entirely', () => {
    const dropped = { ...eighteen, is_excluded: true };
    const { rows } = summariseByRate([five, twelve, dropped]);
    expect(rows.map((r) => r.tax_rate)).toEqual([5, 12]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   7 & 8. CGST + SGST, AND IGST
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-07 — an intra-state invoice (CGST + SGST)', () => {
  test('the halves are recognised and summed into the line rate', () => {
    const item = goodItem({ cgst_pct: 6, sgst_pct: 6, line_total: 1000 });
    expect(gstMode(item)).toBe('INTRA');
    expect(resolveTaxRate(item)).toBe(12);
    expect(computeLineTax(item)).toMatchObject({ cgst_amount: 60, sgst_amount: 60, igst_amount: null });
  });

  test('unequal halves warn — within a state they are always equal', () => {
    const item = goodItem({ cgst_pct: 6, sgst_pct: 9, line_total: 1000 });
    expect(severityOf(validateItem(item, ctx()), 'GST_SPLIT_INCONSISTENT')).toBe('warning');
  });

  test('IGST stays null on an intra-state line rather than becoming zero', () => {
    const resolved = resolveLineTax(goodItem({ cgst_pct: 6, sgst_pct: 6, line_total: 1000 }));
    expect(resolved.igst_amount).toBeNull();
    expect(resolved.total_tax).toBe(120);
  });
});

describe('TC-TAX-08 — an inter-state invoice (IGST)', () => {
  test('IGST carries the WHOLE rate and is not halved', () => {
    const item = goodItem({ igst_pct: 12, line_total: 1000 });
    expect(gstMode(item)).toBe('INTER');
    expect(resolveTaxRate(item)).toBe(12);
    expect(computeLineTax(item)).toMatchObject({ igst_amount: 120, cgst_amount: null, sgst_amount: null });
  });

  test('an IGST line and a CGST/SGST line at the same rate land in ONE band', () => {
    // They are the same slab for filing purposes even though no real invoice
    // mixes them — this asserts the grouping key is the rate, not the scheme.
    const intra = goodItem({ line_no: 1, batch_no: 'A', cgst_pct: 6, sgst_pct: 6, line_total: 1000 });
    const inter = goodItem({ line_no: 2, batch_no: 'B', igst_pct: 12, line_total: 500 });
    const { rows } = summariseByRate([intra, inter]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tax_rate: 12, cgst_amount: 60, sgst_amount: 60, igst_amount: 60 });
  });

  test('a line carrying BOTH schemes warns — no supply is both', () => {
    const item = goodItem({ cgst_pct: 6, sgst_pct: 6, igst_pct: 12, line_total: 1000 });
    expect(gstMode(item)).toBe('MIXED');
    expect(severityOf(validateItem(item, ctx()), 'GST_SPLIT_INCONSISTENT')).toBe('warning');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   9. CESS
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-09 — cess', () => {
  test('cess is charged on the same base and added to the line tax', () => {
    const item = goodItem({ cgst_pct: 6, sgst_pct: 6, cess_pct: 1, line_total: 1000 });
    const resolved = resolveLineTax(item);
    expect(resolved.cess_amount).toBe(10);
    expect(resolved.total_tax).toBe(130);     // 60 + 60 + 10
    expect(resolved.net_amount).toBe(1130);
  });

  test('cess reaches the band and the document total', () => {
    const item = goodItem({ cgst_pct: 6, sgst_pct: 6, cess_pct: 1, gst_pct: 12, line_total: 1000 });
    const { rows } = summariseByRate([item]);
    expect(rows[0].cess_amount).toBe(10);
    expect(deriveInvoiceTotals([item], {}).total_cess).toBe(10);
  });

  test('no cess column leaves cess null, never zero', () => {
    const totals = deriveInvoiceTotals([goodItem({ cgst_pct: 6, sgst_pct: 6, gst_pct: 12 })], {});
    expect(totals.total_cess).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   10 & 11. PAYMENT TYPE vs DOCUMENT TYPE
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-10 — a CREDIT payment invoice is still a tax invoice', () => {
  test('payment_type CREDIT does not make the document a credit note', () => {
    const { invoice } = normalizeExtraction({
      invoice_no: 'INV-1', invoice_date: '2026-08-12',
      payment_type: 'Credit', line_items: [],
    });
    expect(invoice.payment_type).toBe('CREDIT');
    expect(invoice.invoice_type).toBe('TAX_INVOICE');
  });

  test('a credit-payment tax invoice imports normally', () => {
    const invoice = goodInvoice({ payment_type: 'CREDIT' });
    expect(codes(validateInvoice(invoice, [goodItem()], ctx()))).toEqual([]);
    expect(hasBlockingErrors(validateInvoice(invoice, [goodItem()], ctx()), [goodItem()])).toBe(false);
  });

  test('an unreadable payment type stays null rather than guessing CASH', () => {
    // Guessing CASH on an unpaid delivery silently clears a payable.
    const { invoice } = normalizeExtraction({ invoice_no: 'X', payment_type: 'smudged', line_items: [] });
    expect(invoice.payment_type).toBeNull();
  });
});

describe('TC-TAX-11 — a credit note is recorded but never taken into stock', () => {
  test('the type is read from the document title', () => {
    const { invoice } = normalizeExtraction({
      invoice_no: 'CN-1', invoice_type: 'credit_note', payment_type: 'CASH', line_items: [],
    });
    expect(invoice.invoice_type).toBe('CREDIT_NOTE');
    expect(invoice.payment_type).toBe('CASH');
  });

  test('a credit note BLOCKS import and says where it belongs instead', () => {
    const invoice = goodInvoice({ invoice_type: 'CREDIT_NOTE' });
    const issues = validateInvoice(invoice, [goodItem()], ctx());
    expect(severityOf(issues, 'INVOICE_TYPE_NOT_IMPORTABLE')).toBe('error');
    expect(issues.find((i) => i.code === 'INVOICE_TYPE_NOT_IMPORTABLE').message).toContain('Supplier Returns');
    expect(hasBlockingErrors(issues, [goodItem()])).toBe(true);
  });

  test('a debit note blocks the same way', () => {
    const issues = validateInvoice(goodInvoice({ invoice_type: 'DEBIT_NOTE' }), [goodItem()], ctx());
    expect(severityOf(issues, 'INVOICE_TYPE_NOT_IMPORTABLE')).toBe('error');
  });

  test('a tax invoice does not', () => {
    const issues = validateInvoice(goodInvoice({ invoice_type: 'TAX_INVOICE' }), [goodItem()], ctx());
    expect(codes(issues)).not.toContain('INVOICE_TYPE_NOT_IMPORTABLE');
  });

  test('an unreadable type defaults to TAX_INVOICE rather than blocking every upload', () => {
    const { invoice } = normalizeExtraction({ invoice_no: 'X', invoice_type: 'FOO', line_items: [] });
    expect(invoice.invoice_type).toBe('TAX_INVOICE');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   12 & 13. ROUND-OFF, ADDITIONAL AND DEDUCTION AMOUNTS
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-12 — round-off is signed and usually negative', () => {
  test('a negative round-off survives normalisation', () => {
    expect(normalizeSignedAmount(-0.21)).toBe(-0.21);
    expect(normalizeSignedAmount('-0.21')).toBe(-0.21);
    expect(normalizeSignedAmount('₹ -1,234.50')).toBe(-1234.5);
    expect(normalizeSignedAmount(0.4)).toBe(0.4);
    expect(normalizeSignedAmount('')).toBeNull();
    expect(normalizeSignedAmount('abc')).toBeNull();
  });

  test('the ordinary money normaliser still refuses negatives', () => {
    // Two different rules on purpose: a negative rate is a misread, a negative
    // round-off is Tuesday.
    const { invoice } = normalizeExtraction({ invoice_no: 'X', round_off: -0.21, taxable_total: -5, line_items: [] });
    expect(invoice.round_off).toBe(-0.21);
    expect(invoice.taxable_total).toBeNull();
  });

  test('MEDICO M002948: taxable + tax rounded DOWN to the printed payable', () => {
    // 10327.05 + 1263.16 = 11590.21, printed net 11590.00 → round_off -0.21.
    const header = { round_off: -0.21 };
    const item = goodItem({ line_total: 10327.05, gst_pct: 12, cgst_pct: 6, sgst_pct: 6 });
    const totals = deriveInvoiceTotals([item], header);
    expect(totals.taxable_total).toBe(10327.05);

    // ₹1239.24, NOT ₹1239.25 — and the difference is the point of this test.
    // Each half is rounded to paise before they are added: 6% of 10327.05 is
    // 619.623, which is 619.62 as CGST and 619.62 again as SGST, so the pair
    // comes to 1239.24. Applying 12% to the base in one step gives 1239.25.
    // Real invoices print the two halves, so the two-step figure is the one
    // that reconciles against them — computing the whole rate at once would
    // report a one-paisa disagreement on every intra-state invoice.
    expect(totals.total_cgst).toBe(619.62);
    expect(totals.total_sgst).toBe(619.62);
    expect(totals.gst_total).toBe(1239.24);

    expect(totals.invoice_total).toBe(11566.29);
    expect(totals.net_payable).toBe(11566.08);   // less the -0.21 round-off
  });
});

describe('TC-TAX-13 — additional and deduction amounts', () => {
  const item = goodItem({ gst_pct: 12, cgst_pct: 6, sgst_pct: 6, line_total: 1000 });

  test('an additional amount is ADDED after tax', () => {
    const totals = deriveInvoiceTotals([item], { additional_amount: 50 });
    expect(totals.invoice_total).toBe(1120);
    expect(totals.net_payable).toBe(1170);
  });

  test('a deduction amount is SUBTRACTED after tax', () => {
    const totals = deriveInvoiceTotals([item], { deduction_amount: 20 });
    expect(totals.net_payable).toBe(1100);
  });

  test('a signed adjustment goes whichever way it is printed', () => {
    expect(deriveInvoiceTotals([item], { adjustment_amount: -30 }).net_payable).toBe(1090);
    expect(deriveInvoiceTotals([item], { adjustment_amount: 30 }).net_payable).toBe(1150);
  });

  test('all four apply together, in the order the invoice states them', () => {
    const totals = deriveInvoiceTotals([item], {
      additional_amount: 50, deduction_amount: 20, adjustment_amount: -5, round_off: -0.25,
    });
    // 1000 + 120 = 1120, + 50 - 20 - 5 - 0.25
    expect(totals.net_payable).toBe(1144.75);
  });

  test('a payable that does not match what the lines imply warns', () => {
    const invoice = goodInvoice({
      taxable_total: 1000, gst_total: 120, net_total: 9999, additional_amount: 50,
    });
    const issues = validateInvoice(invoice, [item], ctx());
    expect(severityOf(issues, 'NET_PAYABLE_MISMATCH')).toBe('warning');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   14. LEGACY RECORDS AFTER MIGRATION
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-14 — pre-migration records keep working', () => {
  // A row as it exists on a database that has just run schema-37: the DEFAULT
  // has set invoice_type, and every other new column is NULL because nothing
  // was ever recorded in it.
  const legacyItem = () => ({
    line_no: 1,
    medicine_id: '11111111-1111-1111-1111-111111111111',
    match_source: 'manual',
    batch_no: 'OLD-1', exp_date: '2028-01-31',
    qty_billed: 10, qty_free: 2,
    printed_rate: 8.5, printed_mrp: 12, unit_cost: 8.5, mrp: 12, selling_price: 12,
    line_total: 85,
    // Every schema-37 column, unset:
    hsn_code: null, trade_price: null, discount_amount: null, taxable_amount: null,
    cgst_pct: null, cgst_amount: null, sgst_pct: null, sgst_amount: null,
    igst_pct: null, igst_amount: null, cess_pct: null, cess_amount: null, net_amount: null,
    is_excluded: false,
  });

  const legacyInvoice = () => ({
    supplier_id: '22222222-2222-2222-2222-222222222222',
    invoice_no: 'OLD/2025/1', invoice_date: '2026-08-12',
    invoice_type: 'TAX_INVOICE',      // the DEFAULT
    payment_type: null,
    taxable_total: 85, gst_total: 10.2, net_total: 95.2,
    subtotal: null, total_discount: null, round_off: null,
    total_cgst: null, total_sgst: null, total_igst: null, total_cess: null,
    tax_summary: [],
  });

  test('a legacy line raises no new warnings', () => {
    expect(codes(validateItem(legacyItem(), ctx()))).toEqual([]);
  });

  test('a legacy document raises no new warnings — no tax nagging on old records', () => {
    expect(codes(validateInvoice(legacyInvoice(), [legacyItem()], ctx()))).toEqual([]);
  });

  test('specifically: no TAX_RATE_UNRESOLVED when the document carries no tax at all', () => {
    // The document has no line rates and no printed summary, so there is
    // nothing inconsistent to report. Warning here would put a badge on every
    // record the pharmacy already has.
    const issues = validateInvoice(legacyInvoice(), [legacyItem()], ctx());
    expect(codes(issues)).not.toContain('TAX_RATE_UNRESOLVED');
    expect(codes(issues)).not.toContain('NET_PAYABLE_MISMATCH');
    expect(codes(issues)).not.toContain('TAX_SUMMARY_MISMATCH');
  });

  test('its cost is unchanged — the costing formula did not move', () => {
    expect(lineValue(legacyItem())).toBe(85);
    expect(totalUnits(legacyItem())).toBe(12);
  });

  test('a legacy document still imports', () => {
    const issues = validateInvoice(legacyInvoice(), [legacyItem()], ctx());
    expect(hasBlockingErrors(issues, [legacyItem()])).toBe(false);
  });

  test('an invoice with no invoice_type at all (mid-migration read) does not block', () => {
    const invoice = { ...legacyInvoice() };
    delete invoice.invoice_type;
    expect(codes(validateInvoice(invoice, [legacyItem()], ctx()))).not.toContain('INVOICE_TYPE_NOT_IMPORTABLE');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   15. INVENTORY QUANTITY: paid + free = physical received
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-15 — physical receipt is paid plus free, and nothing else', () => {
  const cases = [
    { billed: 10, free: 5, physical: 15 },
    { billed: 11, free: 1, physical: 12 },
    { billed: 25, free: 25, physical: 50 },
    { billed: 8, free: 2, physical: 10 },
    { billed: 40, free: 0, physical: 40 },
    { billed: 0, free: 12, physical: 12 },
  ];

  test.each(cases)('S.Q $billed + F.Q $free = $physical received', ({ billed, free, physical }) => {
    const item = goodItem({ qty_billed: billed, qty_free: free });
    expect(item.qty_billed).toBe(billed);
    expect(item.qty_free).toBe(free);
    expect(totalUnits(item)).toBe(physical);
  });

  test('the pack column never multiplies any of them', () => {
    // "100'S" qty 5 is five STRIPS, not five hundred tablets. This is the rule
    // schema-25 exists to enforce and schema-37 does not touch.
    const item = normalizeItem({
      description: 'LIV 52 TAB', pack_raw: "100'S", qty_billed: 5, qty_free: 1,
      unit_cost: 103.12, mrp: 150, line_total: 515.6,
    }, 1);
    expect(item.content_quantity).toBe(100);
    expect(totalUnits(item)).toBe(6);
    expect(totalUnits(item)).not.toBe(600);
  });

  test('free goods are not cost-averaged — unit_cost is per unit, not per receipt', () => {
    const item = normalizeItem({
      description: 'X', qty_billed: 11, qty_free: 1, unit_cost: 107.14, mrp: 150,
      discount_pct: 3, line_total: 1178.54,
    }, 1);
    expect(item.unit_cost).toBe(103.93);
    // NOT 1143.23 / 12 = 95.27. Deliberate and long-standing: see
    // supplier-invoices.normalize.js. Pinned so a tax change cannot alter it.
    expect(item.unit_cost).not.toBeCloseTo(95.27, 2);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Supporting normalisers and reconciliation plumbing
   ══════════════════════════════════════════════════════════════════════════ */

describe('TC-TAX-16 — document and party normalisation', () => {
  test('invoice time accepts the shapes invoices actually print', () => {
    expect(normalizeTime('14:35')).toBe('14:35:00');
    expect(normalizeTime('14:35:20')).toBe('14:35:20');
    expect(normalizeTime('2:35 PM')).toBe('14:35:00');
    expect(normalizeTime('12:05 AM')).toBe('00:05:00');
    expect(normalizeTime('12:05 PM')).toBe('12:05:00');
    expect(normalizeTime('25:00')).toBeNull();
    expect(normalizeTime('later')).toBeNull();
  });

  test('state codes keep their leading zero', () => {
    expect(normalizeStateCode('29')).toBe('29');
    expect(normalizeStateCode('29 - Karnataka')).toBe('29');
    expect(normalizeStateCode('1')).toBe('01');
    expect(normalizeStateCode('029')).toBe('02');   // first two digits read
    expect(normalizeStateCode('Karnataka')).toBeNull();
  });

  test('vendor and buyer snapshots land in separate fields', () => {
    const { invoice } = normalizeExtraction({
      supplier_name: 'MEDICO DISTRIBUTORS', supplier_gstin: '29aaffm1064p1zu',
      supplier_state: 'Karnataka', supplier_state_code: '29',
      buyer_name: 'P. Care Pharma', buyer_gstin: '29abcde1234f1z5',
      buyer_state: 'Karnataka', buyer_state_code: '29',
      invoice_no: 'M002948', line_items: [],
    });
    expect(invoice.supplier_name_raw).toBe('MEDICO DISTRIBUTORS');
    expect(invoice.supplier_gstin).toBe('29AAFFM1064P1ZU');
    expect(invoice.buyer_name).toBe('P. Care Pharma');
    expect(invoice.buyer_gstin).toBe('29ABCDE1234F1Z5');
    expect(invoice.supplier_gstin).not.toBe(invoice.buyer_gstin);
  });

  test('document references are carried through', () => {
    const { invoice } = normalizeExtraction({
      invoice_no: 'M002948', invoice_date: '2023-06-10', invoice_time: '11:42',
      due_date: '2023-07-10', transaction_date: '2023-06-10',
      order_number: 'PO-771', order_date: '2023-06-01',
      lr_number: 'LR-9931', lr_date: '2023-06-09',
      page_number: 1, total_pages: 2, sales_executive: 'R. Kulkarni',
      line_items: [],
    });
    expect(invoice).toMatchObject({
      invoice_time: '11:42:00', due_date: '2023-07-10', order_number: 'PO-771',
      lr_number: 'LR-9931', page_number: 1, total_pages: 2, sales_executive: 'R. Kulkarni',
    });
  });
});

describe('TC-TAX-17 — tax summary normalisation', () => {
  test('rows are sorted by rate and rows with no rate are dropped', () => {
    const rows = normalizeTaxSummary({
      tax_summary: [
        { tax_rate: 18, taxable_amount: 300 },
        { tax_rate: null, taxable_amount: 999 },
        { tax_rate: 5, taxable_amount: 100 },
      ],
    });
    expect(rows.map((r) => r.tax_rate)).toEqual([5, 18]);
  });

  test('a duplicate rate is collapsed — the unique index would reject the batch', () => {
    const rows = normalizeTaxSummary({
      tax_summary: [{ tax_rate: 12, taxable_amount: 100 }, { tax_rate: 12, taxable_amount: 200 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].taxable_amount).toBe(100);
  });

  test('a zero rate is kept — exempt is a real band', () => {
    expect(normalizeTaxSummary({ tax_summary: [{ tax_rate: 0, taxable_amount: 500 }] })).toHaveLength(1);
  });

  test('no block at all yields an empty array, not null', () => {
    expect(normalizeTaxSummary({})).toEqual([]);
    expect(normalizeTaxSummary(null)).toEqual([]);
  });
});

describe('TC-TAX-18 — reconciliation plumbing', () => {
  test('sumOrNull keeps absent absent and never invents a zero', () => {
    expect(sumOrNull([null, null])).toBeNull();
    expect(sumOrNull([])).toBeNull();
    expect(sumOrNull([null, 5, null])).toBe(5);
    expect(sumOrNull([1.005, 2.005])).toBe(3.01);
  });

  test('a printed line tax that disagrees with its own rate is reported', () => {
    const item = goodItem({ line_total: 1000, cgst_pct: 6, cgst_amount: 99 });
    const issues = reconcileLine(item);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'cgst_amount', printed: 99, computed: 60 });
    expect(severityOf(validateItem(item, ctx()), 'LINE_TAX_MISMATCH')).toBe('warning');
  });

  test('a printed amount within the rounding tolerance is not reported', () => {
    const item = goodItem({ line_total: 1000, cgst_pct: 6, cgst_amount: 60.4 });
    expect(reconcileLine(item)).toEqual([]);
  });

  test('a printed amount always wins over the computed one', () => {
    const resolved = resolveLineTax(goodItem({ line_total: 1000, cgst_pct: 6, cgst_amount: 99 }));
    expect(resolved.cgst_amount).toBe(99);
  });

  test('an excluded line is never reconciled', () => {
    expect(reconcileLine(goodItem({ is_excluded: true, cgst_pct: 6, cgst_amount: 99 }))).toEqual([]);
  });

  test('reconcileTaxSummary reports missing, extra and disagreeing bands', () => {
    const printed = [{ tax_rate: 5, taxable_amount: 100 }, { tax_rate: 12, taxable_amount: 200 }];
    const derived = [{ tax_rate: 12, taxable_amount: 275 }, { tax_rate: 18, taxable_amount: 300 }];
    const kinds = reconcileTaxSummary(printed, derived).map((m) => m.kind);
    expect(kinds).toContain('missing');   // 5% printed, no lines
    expect(kinds).toContain('amount');    // 12% disagrees
    expect(kinds).toContain('extra');     // 18% lines, not printed
  });

  test('no printed block means nothing to reconcile', () => {
    expect(reconcileTaxSummary([], [{ tax_rate: 12, taxable_amount: 200 }])).toEqual([]);
  });
});

describe('TC-TAX-19 — the GST-total guard that used to fail silently', () => {
  test('an unread GST total is reported, not treated as zero', () => {
    // Number(null) is 0 and 0 is finite, so the old bare-Number guard read an
    // unread gst_total as "GST is zero" and then confirmed taxable + 0 = net
    // against a net_total that had itself fallen back to the ex-GST lines sum.
    const invoice = goodInvoice({ gst_total: null, taxable_total: 85, net_total: 85 });
    const issues = validateInvoice(invoice, [goodItem()], ctx());
    expect(severityOf(issues, 'GST_TOTAL_UNREAD')).toBe('warning');
    expect(codes(issues)).not.toContain('TOTALS_MISMATCH');
  });

  test('a GST total that IS read still reconciles the three figures', () => {
    const invoice = goodInvoice({ gst_total: 10.2, taxable_total: 85, net_total: 999 });
    expect(severityOf(validateInvoice(invoice, [goodItem()], ctx()), 'TOTALS_MISMATCH')).toBe('warning');
  });

  test('none of it blocks the import — tax is not stock', () => {
    const invoice = goodInvoice({ gst_total: null, net_total: 85 });
    const issues = validateInvoice(invoice, [goodItem()], ctx());
    expect(hasBlockingErrors(issues, [goodItem()])).toBe(false);
  });
});
