/**
 * MODULE 23 — Supplier invoice normalisation (pure, no credentials needed)
 * Runner: npx jest tests/unit --runInBand
 *
 * These cover the layer between what a distributor printed and what the
 * staging tables store. The expensive failures this feature could have are all
 * here: a misparsed expiry puts short-dated stock at the front of the FEFO
 * queue, and a guessed value that looks plausible survives review.
 */

const {
  normalizeExpiry, normalizeMfg, normalizeDate, normalizeAmount,
  normalizeInt, normalizeBatchNo, normalizeGstin,
  normalizeExtraction, totalUnits, totalContent, lineValue, printedLineValue,
  descriptionForMatching, parsePack, deriveSaleUnit,
  deriveUnitCost, deriveUnitMrp, perContentUnitPrice, rederiveLine,
} = require('../../src/modules/supplier-invoices/supplier-invoices.normalize');

describe('Module 23 — expiry normalisation', () => {
  test('TC-INV-N01: YYYY-MM becomes the LAST day of that month', () => {
    // A strip printed "EXP 04/27" is good through all of April. Rounding to
    // the 1st would write off a month of shelf life on every imported batch.
    expect(normalizeExpiry('2027-04')).toBe('2027-04-30');
    expect(normalizeExpiry('2027-02')).toBe('2027-02-28');
    expect(normalizeExpiry('2028-02')).toBe('2028-02-29'); // leap year
    expect(normalizeExpiry('2027-12')).toBe('2027-12-31');
  });

  test('TC-INV-N02: MM/YY and MM/YYYY forms resolve to the same month end', () => {
    expect(normalizeExpiry('04/27')).toBe('2027-04-30');
    expect(normalizeExpiry('04-2027')).toBe('2027-04-30');
    expect(normalizeExpiry('4/27')).toBe('2027-04-30');
    expect(normalizeExpiry('04.27')).toBe('2027-04-30');
  });

  test('TC-INV-N03: month-name forms are accepted', () => {
    expect(normalizeExpiry('APR27')).toBe('2027-04-30');
    expect(normalizeExpiry('Apr 2027')).toBe('2027-04-30');
    expect(normalizeExpiry('september 26')).toBe('2026-09-30');
  });

  test('TC-INV-N04: a full printed date passes through unchanged', () => {
    expect(normalizeExpiry('2027-04-15')).toBe('2027-04-15');
  });

  test('TC-INV-N05: anything unreadable becomes null, never a guess', () => {
    for (const bad of ['', null, undefined, '--', 'N/A', 'XXXX', '2027-13', '2027-02-30', 'soon']) {
      expect(normalizeExpiry(bad)).toBeNull();
    }
  });

  test('TC-INV-N06: two-digit years are this century', () => {
    expect(normalizeExpiry('01/99')).toBe('2099-01-31');
  });

  test('TC-INV-N07: manufacture dates take the FIRST day — the mirror rule', () => {
    expect(normalizeMfg('2025-04')).toBe('2025-04-01');
    expect(normalizeMfg('04/25')).toBe('2025-04-01');
    expect(normalizeMfg('2025-04-09')).toBe('2025-04-09');
  });

  test('TC-INV-N08: an invoice date needs a real day — a month alone is not one', () => {
    expect(normalizeDate('2026-08-12')).toBe('2026-08-12');
    expect(normalizeDate('2026-08')).toBeNull();
    expect(normalizeDate('08/26')).toBeNull();
  });
});

describe('Module 23 — amount and quantity normalisation', () => {
  test('TC-INV-N09: currency symbols and grouping are stripped', () => {
    expect(normalizeAmount('₹1,234.50')).toBe(1234.5);
    expect(normalizeAmount(' 89.999 ')).toBe(90);
    expect(normalizeAmount(12)).toBe(12);
  });

  test('TC-INV-N10: negatives and non-numbers become null', () => {
    expect(normalizeAmount('-5')).toBeNull();
    expect(normalizeAmount('abc')).toBeNull();
    expect(normalizeAmount('')).toBeNull();
    expect(normalizeAmount(null)).toBeNull();
  });

  test('TC-INV-N11: "2.00" in a Qty column is 2, not a rejection', () => {
    expect(normalizeInt('2.00')).toBe(2);
    expect(normalizeInt('10')).toBe(10);
    expect(normalizeInt('abc')).toBeNull();
  });
});

describe('Module 23 — pack column parsing', () => {
  test('TC-INV-N12: a piece count is content, not a count of saleable units', () => {
    // "100'S" qty 5 is five STRIPS holding a hundred tablets each. The 100
    // never multiplies stock — that was the bug this whole model replaced.
    expect(parsePack("100'S")).toMatchObject({ content_quantity: 100, content_unit: 'PIECE', recognised: true });
    expect(parsePack("10'S")).toMatchObject({ content_quantity: 10, content_unit: 'PIECE' });
    expect(parsePack('10S')).toMatchObject({ content_quantity: 10, content_unit: 'PIECE' });
  });

  test('TC-INV-N13: volumes, weights and doses are content in their own units', () => {
    expect(parsePack('100ML')).toMatchObject({ content_quantity: 100, content_unit: 'ML' });
    expect(parsePack('30GM')).toMatchObject({ content_quantity: 30, content_unit: 'GM' });
    expect(parsePack('120MD')).toMatchObject({ content_quantity: 120, content_unit: 'DOSE' });
    expect(parsePack('500MG')).toMatchObject({ content_quantity: 500, content_unit: 'MG' });
  });

  test('TC-INV-N14: nested packaging is kept nested, never flattened', () => {
    // "7X2ML" is seven 2ml ampoules in one saleable pack. Flattening to 14
    // would price and stock the line as fourteen of something.
    expect(parsePack('7X2ML')).toMatchObject({
      content_quantity: 2, content_unit: 'ML',
      sub_pack_quantity: 7, sub_pack_unit: 'AMPOULE',
    });
  });

  test('TC-INV-N14b: a multiplier of one is not nesting', () => {
    // "1X200ML" is one 200ml bottle written the long way. Recording a sub-pack
    // of 1 would put "1 AMPOULE" on a syrup.
    expect(parsePack('1X200ML')).toMatchObject({
      content_quantity: 200, content_unit: 'ML', sub_pack_quantity: null,
    });
  });

  test('TC-INV-N15b: an unreadable pack is marked for review, never guessed', () => {
    // Rule 11: the suffix carries the meaning. 100'S / 100ML / 100GM / 100MD
    // share a digit and mean four different things, so a bare number cannot be
    // resolved and must reach a human.
    expect(parsePack('100').recognised).toBe(false);
    expect(parsePack('BOTTLE').recognised).toBe(false);
    expect(parsePack('10X10').recognised).toBe(false);
  });

  test('TC-INV-N15c: an absent pack column is fine, not an error', () => {
    // Plenty of invoices do not print one. Nothing downstream needs it.
    expect(parsePack(null)).toMatchObject({ content_quantity: null, recognised: true });
    expect(parsePack('')).toMatchObject({ content_quantity: null, recognised: true });
  });
});

describe('Module 23 — saleable unit', () => {
  test('TC-INV-N15d: the product description names the container', () => {
    expect(deriveSaleUnit('a LIV 52 SYP', parsePack('100ML'))).toBe('BOTTLE');
    expect(deriveSaleUnit('a PILEX FORTE OINT', parsePack('30GM'))).toBe('TUBE');
    expect(deriveSaleUnit('a FORACORT*200 INHALER', parsePack('120MD'))).toBe('INHALER');
    expect(deriveSaleUnit('a DERIPHYLLIN-INJ', parsePack('7X2ML'))).toBe('VIAL');
    expect(deriveSaleUnit('a LIV 52 TAB', parsePack("100'S"))).toBe('STRIP');
  });

  test('TC-INV-N15e: with no hint in the name, the content unit decides', () => {
    expect(deriveSaleUnit('MYSTERY PRODUCT', parsePack('120MD'))).toBe('INHALER');
    expect(deriveSaleUnit('MYSTERY PRODUCT', parsePack('100ML'))).toBe('BOTTLE');
    expect(deriveSaleUnit('MYSTERY PRODUCT', parsePack('30GM'))).toBe('TUBE');
  });

  test('TC-INV-N15f: an unknown shape falls back to PACK, never an invented container', () => {
    // A wrong sale_unit is a shelf label that does not match the box in
    // someone's hand, which is worse than a generic one.
    expect(deriveSaleUnit('MYSTERY PRODUCT', parsePack('BOTTLE'))).toBe('PACK');
  });
});

describe('Module 23 — text fields', () => {
  test('TC-INV-N15: batch numbers are uppercased and trimmed', () => {
    // inventory_batches unique-indexes on lower(batch_no), and both atomic
    // functions store upper(trim(...)) — matching here keeps what the reviewer
    // typed identical to what the shelf shows.
    expect(normalizeBatchNo('  ab-123 ')).toBe('AB-123');
    expect(normalizeBatchNo('')).toBeNull();
    expect(normalizeBatchNo(null)).toBeNull();
  });

  test('TC-INV-N16: GSTIN is uppercased with spaces removed', () => {
    expect(normalizeGstin(' 29abcde1234f1z5 ')).toBe('29ABCDE1234F1Z5');
    expect(normalizeGstin(null)).toBeNull();
  });
});

describe('Module 23 — whole-extraction shaping', () => {
  const RAW = {
    supplier_name: '  Sri Balaji   Distributors ',
    supplier_gstin: '29abcde1234f1z5',
    invoice_no: 'INV/2026/8841',
    invoice_date: '2026-08-12',
    taxable_total: '10,000.00',
    gst_total: 1200,
    net_total: '11200',
    line_items: [
      { description: 'PARACIP 500 TAB', batch_no: 'pc-9912', exp_date: '04/28', qty_billed: 10, qty_free: 2, pack_raw: "10'S", unit_cost: '8.50', mrp: 12, line_total: 85 },
      { description: 'AMOXIL 250 CAP', batch_no: null, exp_date: null, qty_billed: null, unit_cost: null, mrp: null },
    ],
  };

  test('TC-INV-N17: header fields are normalised and line numbers are positional', () => {
    const { invoice, items } = normalizeExtraction(RAW);
    expect(invoice.supplier_name_raw).toBe('Sri Balaji Distributors');
    expect(invoice.supplier_gstin).toBe('29ABCDE1234F1Z5');
    expect(invoice.taxable_total).toBe(10000);
    expect(invoice.net_total).toBe(11200);
    // line_no comes from the array position, never from the model — its own
    // numbering is not trustworthy enough to key a staging row on.
    expect(items.map((i) => i.line_no)).toEqual([1, 2]);
  });

  test('TC-INV-N18: an unreadable line survives as nulls rather than being dropped', () => {
    // Dropping it would hide a product the pharmacy actually received.
    const { items } = normalizeExtraction(RAW);
    expect(items[1]).toMatchObject({
      raw_description: 'AMOXIL 250 CAP',
      batch_no: null, exp_date: null, qty_billed: null, unit_cost: null, mrp: null,
      qty_free: 0, content_quantity: null, content_unit: null,
    });
  });

  test('TC-INV-N19: a response with no line_items array does not throw', () => {
    expect(normalizeExtraction({}).items).toEqual([]);
    expect(normalizeExtraction(null).items).toEqual([]);
  });

  test('TC-INV-N19b: missing taxable_total and net_total derive from line items sum', () => {
    const rawWithoutTotals = {
      ...RAW,
      taxable_total: null,
      net_total: null,
    };
    const { invoice } = normalizeExtraction(rawWithoutTotals);
    expect(invoice.taxable_total).toBe(85);
    expect(invoice.net_total).toBe(85);
  });
});

describe('Module 23 — derived line arithmetic', () => {
  // 10 strips billed + 2 free, a hundred tablets in each, ₹8.50 a strip.
  const line = {
    qty_billed: 10, qty_free: 2, unit_cost: 8.5,
    content_quantity: 100, content_unit: 'PIECE',
  };

  test('TC-INV-N20: stock is counted in saleable units, never in contents', () => {
    // 12 STRIPS, not 1200 tablets. inventory_ledger is denominated in
    // medicines.unit, and every other module decrements it in the same terms.
    expect(totalUnits(line)).toBe(12);
  });

  test('TC-INV-N21: free goods are free, so they are excluded from line value', () => {
    // The asymmetry with totalUnits is the entire point of tracking scheme
    // quantity separately: 12 strips arrive, 10 are paid for.
    expect(lineValue(line)).toBe(85);
  });

  test('TC-INV-N21b: contents are reported separately and never mixed in', () => {
    // Rule 7/14: the invoice calculation and the content calculation stay apart.
    expect(totalContent(line)).toEqual({ quantity: 1200, unit: 'PIECE' });
    expect(totalUnits(line)).toBe(12);
  });

  test('TC-INV-N21c: nested packs count sub-items through', () => {
    // 20 packs of 7 ampoules = 140 ampoules on the shelf, 20 units of stock.
    const nested = { qty_billed: 20, qty_free: 0, sub_pack_quantity: 7, sub_pack_unit: 'AMPOULE', content_quantity: 2, content_unit: 'ML' };
    expect(totalUnits(nested)).toBe(20);
    expect(totalContent(nested)).toEqual({ quantity: 140, unit: 'AMPOULE' });
  });

  test('TC-INV-N22: missing parts degrade to zero rather than NaN', () => {
    expect(totalUnits({})).toBe(0);
    expect(lineValue({})).toBe(0);
    expect(totalUnits(null)).toBe(0);
    expect(totalContent({})).toBeNull();
  });
});

describe('Module 23 — description matching', () => {
  test('TC-INV-N39: a lowercase tax-class prefix is dropped before matching', () => {
    // MARG prints the HSN class as a letter in front of the product name.
    expect(descriptionForMatching('a CLONAFIT PLUS TAB')).toBe('CLONAFIT PLUS TAB');
    expect(descriptionForMatching('b ENERZAL PET ORANGE')).toBe('ENERZAL PET ORANGE');
  });

  test('TC-INV-N40: a product whose real first word is one capital letter survives', () => {
    // The reason the rule requires a LOWERCASE prefix. Stripping here would
    // match "COMPLEX FORTE" against the wrong medicine rather than none.
    expect(descriptionForMatching('B COMPLEX FORTE')).toBe('B COMPLEX FORTE');
    expect(descriptionForMatching('D RISE 60K')).toBe('D RISE 60K');
  });

  test('TC-INV-N41: an ordinary description is untouched', () => {
    expect(descriptionForMatching('PARACIP 500 TAB')).toBe('PARACIP 500 TAB');
    expect(descriptionForMatching(null)).toBeNull();
  });
});

describe('Module 23 — cost derivation', () => {
  test('TC-INV-N33: the rate is already per saleable unit — only discount applies', () => {
    // LIV 52 TAB "100'S": ₹103.12 a STRIP less 3% = ₹100.03 a strip.
    // NOT ₹1.00 a tablet. The strip is what goes on the shelf and what the
    // ledger counts, so the strip is what the cost is denominated in.
    expect(deriveUnitCost({ printed_rate: 103.12, discount_pct: 3 })).toBe(100.03);
  });

  test('TC-INV-N34: no discount leaves the printed rate untouched', () => {
    expect(deriveUnitCost({ printed_rate: 107.14, discount_pct: null })).toBe(107.14);
  });

  test('TC-INV-N35: the pack column has no effect on cost whatsoever', () => {
    // The whole point. A hundred-tablet strip and a two-ml ampoule at the same
    // printed rate cost the same per unit, because the rate is per unit.
    const a = deriveUnitCost({ printed_rate: 50, discount_pct: 3 });
    const b = deriveUnitCost({ printed_rate: 50, discount_pct: 3 });
    expect(a).toBe(b);
    expect(a).toBe(48.5);
  });

  test('TC-INV-N36: no rate means no cost, rather than a zero that looks real', () => {
    expect(deriveUnitCost({ printed_rate: null, discount_pct: 3 })).toBeNull();
  });

  test('TC-INV-N36b: an exact half-paisa tie rounds up, not down', () => {
    // ₹2.425 has no exact double and the stored value sits just below it, so
    // Math.round(x*100)/100 silently yields ₹2.42. Costs must not round down:
    // an understated cost overstates every margin after it.
    expect(deriveUnitCost({ printed_rate: 2.5, discount_pct: 3 })).toBe(2.43);
  });

  test('TC-INV-N37: MRP is transcribed, never converted and never discounted', () => {
    // The discount is what the distributor gave the pharmacy. The MRP is what
    // is printed on the pack for the patient. They are unrelated.
    expect(deriveUnitMrp({ printed_mrp: 150 })).toBe(150);
    expect(deriveUnitMrp({ printed_mrp: 11.92 })).toBe(11.92);
    expect(deriveUnitMrp({ printed_mrp: null })).toBeNull();
  });

  test('TC-INV-N38: cost lands below MRP on every verified line of both invoices', () => {
    // The invariant COST_EXCEEDS_MRP defends, across 18 real lines.
    const lines = [
      [107.14, 150.00], [199.30, 279.00], [57.14, 80.00], [67.86, 95.00],
      [37.86, 53.00], [8.51, 11.92], [25.00, 35.00], [37.29, 55.00], [134.16, 187.82],
      [68.74, 100.00], [103.12, 150.00], [110.00, 160.00], [51.57, 75.00],
      [58.43, 85.00], [113.43, 165.00], [285.11, 399.16], [45.01, 63.00], [146.66, 200.00],
    ];
    for (const [rate, mrp] of lines) {
      expect(deriveUnitCost({ printed_rate: rate, discount_pct: 3 }))
        .toBeLessThan(deriveUnitMrp({ printed_mrp: mrp }));
    }
  });

  test('TC-INV-N38b: a per-tablet price may be derived for display, never stored', () => {
    // Rule 9: useful beside the field, but it must never replace the invoice
    // rate and never reach unit_cost.
    expect(perContentUnitPrice(103.12, parsePack("100'S"))).toBe(1.03);
    // Meaningless for a measurement — nobody prices a tube per gram.
    expect(perContentUnitPrice(58.43, parsePack('30GM'))).toBeNull();
    expect(perContentUnitPrice(285.11, parsePack('120MD'))).toBeNull();
  });
});

describe('Module 23 — re-derivation after a review edit', () => {
  const stored = {
    raw_description: 'a LIV 52 TAB', pack_raw: "100'S",
    qty_billed: 5, qty_free: 0,
    printed_rate: 103.12, printed_mrp: 150, discount_pct: 3,
    unit_cost: 100.03, mrp: 150, line_total: 515.60,
  };

  test('TC-INV-N45: correcting the rate moves the cost with it', () => {
    const out = rederiveLine({ ...stored, printed_rate: 110 });
    expect(out.unit_cost).toBe(106.7); // 110 less 3%
  });

  test('TC-INV-N46: correcting the pack re-reads contents and leaves money alone', () => {
    // The pack column describes what is inside a unit. Changing it must not
    // move the cost — that coupling is exactly what this model removed.
    const out = rederiveLine({ ...stored, pack_raw: '100ML' });
    expect(out.content_unit).toBe('ML');
    expect(out.unit_cost).toBe(stored.unit_cost);
  });

  test('TC-INV-N47: a price the reviewer already set is not overwritten', () => {
    const out = rederiveLine({ ...stored, selling_price: 140 });
    expect(out.selling_price).toBe(140);
  });
});

describe('Module 23 — printed vs derived line value', () => {
  // LIV 52 TAB on M002277: 5 strips billed, ₹103.12 each, 3% off, ₹515.60 printed.
  const medicoLine = {
    qty_billed: 5, qty_free: 0, pack_raw: "100'S",
    content_quantity: 100, content_unit: 'PIECE',
    printed_rate: 103.12, unit_cost: 100.03,
  };

  test('TC-INV-N42: printed value reconciles against the printed total', () => {
    // 5 × 103.12 = 515.60 exactly. The identity that holds on every line.
    expect(printedLineValue(medicoLine)).toBe(515.60);
  });

  test('TC-INV-N43: derived value is net of discount and so is lower', () => {
    expect(lineValue(medicoLine)).toBe(500.15);
    expect(lineValue(medicoLine)).toBeLessThan(printedLineValue(medicoLine));
  });

  test('TC-INV-N44: no printed rate means nothing to reconcile against', () => {
    expect(printedLineValue({ ...medicoLine, printed_rate: null })).toBeNull();
  });
});
