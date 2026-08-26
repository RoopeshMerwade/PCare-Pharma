/**
 * MODULE 23 — Supplier invoice validation rules (pure, no credentials needed)
 * Runner: npx jest tests/unit --runInBand
 *
 * The severity split is the thing under test as much as the rules themselves:
 * an 'error' blocks Approve & Commit, a 'warning' is shown and does not. Get
 * that backwards and either bad stock reaches the ledger, or a pharmacist is
 * locked out of accepting a short-dated delivery they have already agreed to.
 */

const {
  validateItem, validateInvoice, hasBlockingErrors,
} = require('../../src/modules/supplier-invoices/supplier-invoices.validate');
const { totalUnits } = require('../../src/modules/supplier-invoices/supplier-invoices.normalize');

const TODAY = '2026-08-18';
const ctx = (extra = {}) => ({ today: TODAY, ...extra });

/**
 * A line with nothing wrong with it. Each test breaks exactly one thing.
 *
 * Ten strips billed at the printed rate of GBP-free Rs 8.50 each, ten tablets
 * inside each strip. No discount, so printed_rate equals unit_cost and
 * printed_mrp equals mrp — a test about expiry or matching is then not also a
 * test about arithmetic.
 */
const goodItem = (over = {}) => ({
  line_no: 1,
  medicine_id: '11111111-1111-1111-1111-111111111111',
  match_source: 'manual',
  batch_no: 'PC-9912',
  mfg_date: '2026-01-01',
  exp_date: '2028-04-30',
  qty_billed: 10,
  qty_free: 2,
  pack_raw: "10'S",
  sale_unit: 'STRIP',
  content_quantity: 10,
  content_unit: 'PIECE',
  pack_recognised: true,
  printed_rate: 8.5,
  printed_mrp: 12,
  discount_pct: null,
  unit_cost: 8.5,
  mrp: 12,
  selling_price: 11,
  line_total: 85,
  is_excluded: false,
  ...over,
});

const codes = (issues) => issues.map((i) => i.code);
const severityOf = (issues, code) => issues.find((i) => i.code === code)?.severity;

describe('Module 23 — line rules', () => {
  test('TC-INV-R01: a clean line raises nothing', () => {
    expect(validateItem(goodItem(), ctx())).toEqual([]);
  });

  test('TC-INV-R02: an unmapped line blocks import', () => {
    const issues = validateItem(goodItem({ medicine_id: null, match_source: null }), ctx());
    expect(codes(issues)).toContain('UNMAPPED_MEDICINE');
    expect(severityOf(issues, 'UNMAPPED_MEDICINE')).toBe('error');
  });

  test('TC-INV-R03: a weak auto-match warns but does not block', () => {
    // The match is applied so the reviewer has something to confirm; it is not
    // trusted, which is why it is surfaced rather than silently accepted.
    const issues = validateItem(goodItem({ match_source: 'auto', match_confidence: 0.48 }), ctx());
    expect(severityOf(issues, 'LOW_MATCH_CONFIDENCE')).toBe('warning');
  });

  test('TC-INV-R04: a confirmed match at the same score raises nothing', () => {
    const issues = validateItem(goodItem({ match_source: 'manual', match_confidence: 0.48 }), ctx());
    expect(codes(issues)).not.toContain('LOW_MATCH_CONFIDENCE');
  });

  test('TC-INV-R05: cost above MRP is an error, not a warning', () => {
    // Almost always a per-pack rate read against a per-strip MRP. Importing it
    // records a loss-making margin on every future sale of the batch.
    const issues = validateItem(goodItem({ unit_cost: 15, mrp: 12 }), ctx());
    expect(severityOf(issues, 'COST_EXCEEDS_MRP')).toBe('error');
  });

  test('TC-INV-R06: an already-expired batch blocks import', () => {
    const issues = validateItem(goodItem({ exp_date: '2026-07-31' }), ctx());
    expect(severityOf(issues, 'EXPIRED')).toBe('error');
  });

  test('TC-INV-R07: expiry today counts as expired', () => {
    const issues = validateItem(goodItem({ exp_date: TODAY }), ctx());
    expect(severityOf(issues, 'EXPIRED')).toBe('error');
  });

  test('TC-INV-R08: under 30 days of shelf life warns but never blocks', () => {
    // Short-dated stock at a discount is a normal commercial decision. Software
    // flags it; the pharmacist decides.
    const issues = validateItem(goodItem({ exp_date: '2026-09-05' }), ctx());
    expect(severityOf(issues, 'EXPIRY_TOO_SOON')).toBe('warning');
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  test('TC-INV-R09: exactly 30 days out is clean', () => {
    expect(validateItem(goodItem({ exp_date: '2026-09-17' }), ctx())).toEqual([]);
  });

  test('TC-INV-R10: a manufacture date at or after expiry blocks', () => {
    const issues = validateItem(goodItem({ mfg_date: '2028-05-01' }), ctx());
    expect(severityOf(issues, 'INVALID_DATES')).toBe('error');
  });

  test('TC-INV-R11: every unreadable required field blocks separately', () => {
    const issues = validateItem(
      goodItem({
        batch_no: null, exp_date: null, qty_billed: null, qty_free: 0,
        mrp: null, unit_cost: null, selling_price: null,
        // A line this unreadable has no rate to reconcile either; leaving the
        // printed figures in place would test a half-read line, not an unread one.
        printed_rate: null, printed_mrp: null, line_total: null, pack_raw: null,
      }),
      ctx()
    );
    expect(codes(issues)).toEqual(expect.arrayContaining([
      'MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_QTY', 'MISSING_MRP', 'MISSING_COST',
    ]));
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
  });

  test('TC-INV-R12: selling above MRP blocks — the DB CHECK would reject it anyway', () => {
    const issues = validateItem(goodItem({ selling_price: 13, mrp: 12 }), ctx());
    expect(severityOf(issues, 'SELLING_ABOVE_MRP')).toBe('error');
  });

  test('TC-INV-R13: a printed line total that disagrees with the printed rate warns', () => {
    // 10 strips × ₹8.50 = ₹85. An invoice printing ₹850 against those figures
    // means one of the three was misread — very likely the pack column was read
    // into the quantity. Advisory, because rounding differences are routine.
    const issues = validateItem(goodItem({ line_total: 850 }), ctx());
    expect(severityOf(issues, 'LINE_TOTAL_MISMATCH')).toBe('warning');
  });

  test('TC-INV-R14: rounding inside a rupee does not warn', () => {
    expect(codes(validateItem(goodItem({ line_total: 85.4 }), ctx()))).not.toContain('LINE_TOTAL_MISMATCH');
  });

  test('TC-INV-R15: an existing batch warns, because the commit would be rejected', () => {
    const issues = validateItem(goodItem(), ctx({ batchExists: true }));
    expect(severityOf(issues, 'BATCH_EXISTS')).toBe('warning');
  });

  test('TC-INV-R16: an excluded line is not validated at all', () => {
    expect(validateItem(goodItem({ is_excluded: true, medicine_id: null, batch_no: null }), ctx())).toEqual([]);
  });

  test('TC-INV-R17: errors sort ahead of warnings', () => {
    const issues = validateItem(goodItem({ medicine_id: null, exp_date: '2026-09-05' }), ctx());
    expect(issues[0].severity).toBe('error');
    expect(issues[issues.length - 1].severity).toBe('warning');
  });

  test('TC-INV-R18: free quantity alone still counts as a quantity', () => {
    // A pure scheme line — nothing billed, stock still arrives.
    expect(codes(validateItem(goodItem({ qty_billed: 0, qty_free: 5 }), ctx()))).not.toContain('MISSING_QTY');
  });
});

/**
 * The denomination rules, against the two invoices that produced them:
 * MEDICO DISTRIBUTORS M002948 and M002277.
 *
 *   LIV 52 TAB   Pack 100'S  Qty 5  Rate 103.12  MRP 150.00  Dis 3%  Total 515.60
 *
 * Five STRIPS on the shelf at Rs 103.12 each — not five hundred tablets at
 * Rs 103.12 each, which is what the module used to compute. The Pack column
 * describes the contents and takes no part in stock or money.
 */
describe('Module 23 — saleable-unit denomination', () => {
  const medicoLine = (over = {}) => ({
    line_no: 1,
    medicine_id: '11111111-1111-1111-1111-111111111111',
    match_source: 'manual',
    batch_no: '106221736',
    mfg_date: null,
    exp_date: '2028-11-30', // shifted forward of TODAY; the real batch is long expired
    qty_billed: 5,
    qty_free: 0,
    pack_raw: "100'S",
    sale_unit: 'STRIP',
    content_quantity: 100,
    content_unit: 'PIECE',
    pack_recognised: true,
    printed_rate: 103.12,
    printed_mrp: 150.00,
    discount_pct: 3.00,
    gst_pct: 12.00,
    unit_cost: 100.03,   // 103.12 less 3%, per STRIP
    mrp: 150.00,         // per STRIP, exactly as printed
    selling_price: 150.00,
    line_total: 515.60,
    is_excluded: false,
    ...over,
  });

  test('TC-INV-R30: a clean line reconciles and raises nothing', () => {
    // 5 x 103.12 = 515.60 exactly.
    expect(validateItem(medicoLine(), ctx())).toEqual([]);
  });

  test('TC-INV-R31: stock is the quantity column, never the pack contents', () => {
    // The regression that matters most. inventory_ledger is denominated in
    // medicines.unit and shared with billing and FEFO, so posting 500 where the
    // rest of the app means 5 would sell strips that do not exist.
    expect(totalUnits(medicoLine())).toBe(5);
    expect(totalUnits(medicoLine({ qty_free: 2 }))).toBe(7);
  });

  test('TC-INV-R32: the old reading now fails reconciliation loudly', () => {
    // Treating the pack as a multiplier gives 500 x 103.12 = Rs 51,560 against a
    // printed Rs 515.60. Recorded here as data so the bug cannot come back
    // quietly: the printed total is what catches it.
    const issues = validateItem(medicoLine({ qty_billed: 500 }), ctx());
    expect(severityOf(issues, 'LINE_TOTAL_MISMATCH')).toBe('warning');
  });

  test('TC-INV-R33: cost and MRP are compared on the same footing', () => {
    // Both per strip, neither converted, so an inversion is real rather than a
    // units artefact — and it blocks.
    const issues = validateItem(medicoLine({ unit_cost: 200 }), ctx());
    expect(severityOf(issues, 'COST_EXCEEDS_MRP')).toBe('error');
  });

  test('TC-INV-R34: an unreadable pack is advisory, never blocking', () => {
    // The pack description is informational now. It cannot make an import
    // wrong, so it must not stop one — it only leaves the shelf label blank.
    const issues = validateItem(medicoLine({ pack_raw: '100', pack_recognised: false }), ctx());
    expect(severityOf(issues, 'PACK_UNPARSEABLE')).toBe('warning');
    expect(issues.some((i) => i.severity === 'error')).toBe(false);
  });

  test('TC-INV-R35: a recognised pack says nothing at all', () => {
    expect(codes(validateItem(medicoLine(), ctx()))).not.toContain('PACK_UNPARSEABLE');
  });

  test('TC-INV-R36: every pack shape on both invoices reconciles', () => {
    // qty x rate = line_total across strips, bottles, tubes, inhalers and
    // nested ampoule packs. One identity, six packagings.
    const real = [
      { pack_raw: "100'S", qty_billed: 5,  printed_rate: 103.12, line_total: 515.60, printed_mrp: 150 },
      { pack_raw: '100ML', qty_billed: 6,  printed_rate: 68.74,  line_total: 412.44, printed_mrp: 100 },
      { pack_raw: '30GM',  qty_billed: 5,  printed_rate: 58.43,  line_total: 292.15, printed_mrp: 85 },
      { pack_raw: '120MD', qty_billed: 2,  printed_rate: 285.11, line_total: 570.22, printed_mrp: 399.16 },
      { pack_raw: '7X2ML', qty_billed: 20, printed_rate: 45.01,  line_total: 900.20, printed_mrp: 63 },
    ];
    for (const line of real) {
      const issues = validateItem(medicoLine({ ...line, unit_cost: line.printed_rate, mrp: line.printed_mrp, selling_price: line.printed_mrp }), ctx());
      expect(codes(issues)).not.toContain('LINE_TOTAL_MISMATCH');
    }
  });
});

describe('Module 23 — document rules', () => {
  const goodInvoice = (over = {}) => ({
    supplier_id: '22222222-2222-2222-2222-222222222222',
    supplier_name_raw: 'Sri Balaji Distributors',
    invoice_no: 'INV/2026/8841',
    invoice_date: '2026-08-12',
    taxable_total: 85,
    gst_total: 10.2,
    net_total: 95.2,
    ...over,
  });

  test('TC-INV-R19: a clean document raises nothing', () => {
    expect(validateInvoice(goodInvoice(), [goodItem()], ctx())).toEqual([]);
  });

  test('TC-INV-R20: an unresolved supplier blocks and names what was printed', () => {
    const issues = validateInvoice(goodInvoice({ supplier_id: null }), [goodItem()], ctx());
    expect(severityOf(issues, 'SUPPLIER_UNRESOLVED')).toBe('error');
    expect(issues.find((i) => i.code === 'SUPPLIER_UNRESOLVED').message).toContain('Sri Balaji Distributors');
  });

  test('TC-INV-R21: a duplicate invoice number blocks — importing twice doubles stock', () => {
    const issues = validateInvoice(goodInvoice(), [goodItem()], ctx({ duplicateInvoice: true }));
    expect(severityOf(issues, 'DUPLICATE_INVOICE')).toBe('error');
  });

  test('TC-INV-R22: a missing invoice number blocks, a missing date only warns', () => {
    const issues = validateInvoice(goodInvoice({ invoice_no: null, invoice_date: null }), [goodItem()], ctx());
    expect(severityOf(issues, 'MISSING_INVOICE_NO')).toBe('error');
    expect(severityOf(issues, 'MISSING_INVOICE_DATE')).toBe('warning');
  });

  test('TC-INV-R23: no readable lines blocks, and says so differently when all are excluded', () => {
    const none = validateInvoice(goodInvoice(), [], ctx());
    expect(severityOf(none, 'NO_LINE_ITEMS')).toBe('error');
    expect(none.find((i) => i.code === 'NO_LINE_ITEMS').message).toMatch(/No line items/);

    const allExcluded = validateInvoice(goodInvoice(), [goodItem({ is_excluded: true })], ctx());
    expect(allExcluded.find((i) => i.code === 'NO_LINE_ITEMS').message).toMatch(/excluded/);
  });

  test('TC-INV-R24: taxable + GST that misses the net total warns', () => {
    const issues = validateInvoice(goodInvoice({ net_total: 150 }), [goodItem()], ctx());
    expect(severityOf(issues, 'TOTALS_MISMATCH')).toBe('warning');
  });

  test('TC-INV-R25: lines that do not add up to the taxable total warn', () => {
    const issues = validateInvoice(goodInvoice({ taxable_total: 500 }), [goodItem()], ctx());
    expect(severityOf(issues, 'LINES_TOTAL_MISMATCH')).toBe('warning');
  });

  test('TC-INV-R26: per-line rounding within 2% does not warn', () => {
    const issues = validateInvoice(goodInvoice({ taxable_total: 86 }), [goodItem()], ctx());
    expect(codes(issues)).not.toContain('LINES_TOTAL_MISMATCH');
  });

  test('TC-INV-R27: a future invoice date warns', () => {
    const issues = validateInvoice(goodInvoice({ invoice_date: '2026-12-01' }), [goodItem()], ctx());
    expect(severityOf(issues, 'FUTURE_INVOICE_DATE')).toBe('warning');
  });

  test('TC-INV-R28: fewer lines read than the invoice claims warns', () => {
    // The checksum for a row lost to a fold — the one extraction failure with
    // nothing on screen to notice, because the missing line simply is not there.
    const issues = validateInvoice(goodInvoice({ printed_item_count: 20 }), [goodItem()], ctx());
    expect(severityOf(issues, 'ITEM_COUNT_MISMATCH')).toBe('warning');
    expect(issues.find((i) => i.code === 'ITEM_COUNT_MISMATCH').message).toContain('19');
  });

  test('TC-INV-R29: an excluded line still counts against the printed total', () => {
    // The reviewer dropping a line does not un-print it. Re-flagging the
    // document would punish a decision that was already made deliberately.
    const items = [goodItem(), goodItem({ line_no: 2, is_excluded: true })];
    expect(codes(validateInvoice(goodInvoice({ printed_item_count: 2 }), items, ctx())))
      .not.toContain('ITEM_COUNT_MISMATCH');
  });

  test('TC-INV-R29b: a document that states no count is not second-guessed', () => {
    expect(codes(validateInvoice(goodInvoice({ printed_item_count: null }), [goodItem()], ctx())))
      .not.toContain('ITEM_COUNT_MISMATCH');
  });
});

describe('Module 23 — the import gate', () => {
  test('TC-INV-R28: warnings alone never block', () => {
    const items = [{ ...goodItem(), warnings: [{ code: 'EXPIRY_TOO_SOON', severity: 'warning' }] }];
    expect(hasBlockingErrors([{ code: 'TOTALS_MISMATCH', severity: 'warning' }], items)).toBe(false);
  });

  test('TC-INV-R29: one line-level error blocks the whole document', () => {
    const items = [
      { ...goodItem(), warnings: [] },
      { ...goodItem(), line_no: 2, warnings: [{ code: 'UNMAPPED_MEDICINE', severity: 'error' }] },
    ];
    expect(hasBlockingErrors([], items)).toBe(true);
  });

  test('TC-INV-R30: an error on an EXCLUDED line does not block', () => {
    // Excluding a line is how a reviewer drops a non-stock item (freight, a
    // sample) off the import — its problems go with it.
    const items = [{ ...goodItem(), is_excluded: true, warnings: [{ code: 'UNMAPPED_MEDICINE', severity: 'error' }] }];
    expect(hasBlockingErrors([], items)).toBe(false);
  });

  test('TC-INV-R31: a document-level error blocks even with clean lines', () => {
    expect(hasBlockingErrors([{ code: 'DUPLICATE_INVOICE', severity: 'error' }], [{ ...goodItem(), warnings: [] }])).toBe(true);
  });
});
