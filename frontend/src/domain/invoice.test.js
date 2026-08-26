import { describe, expect, test } from 'vitest';
import {
  warningLabel, warningTone, partitionWarnings, warningsForField,
  totalUnits, totalContent, lineValue, printedLineValue, unitMargin, sumLineValues,
  canImport, blockingIssues, lineTitle, inferUnit,
} from './invoice';

/* The arithmetic here is duplicated from the backend on purpose (see the note
   in invoice.js), which makes agreement between the two a thing worth asserting
   rather than assuming. These cases mirror TC-INV-N20/21/22 in
   backend/tests/unit/supplier-invoice-normalize.test.js — if one side changes,
   the other test is where you find out. */

const line = (over = {}) => ({
  id: 'l1', line_no: 1, qty_billed: 10, qty_free: 2,
  pack_raw: "10'S", sale_unit: 'STRIP', content_quantity: 10, content_unit: 'PIECE',
  printed_rate: 8.5, unit_cost: 8.5, mrp: 12, selling_price: 11,
  is_excluded: false, warnings: [], ...over,
});

describe('warning presentation', () => {
  test('every code the backend emits has a short human label', () => {
    for (const code of [
      'UNMAPPED_MEDICINE', 'MISSING_BATCH', 'MISSING_EXPIRY', 'EXPIRED', 'INVALID_DATES',
      'MISSING_QTY', 'MISSING_MRP', 'MISSING_COST', 'MISSING_SELLING_PRICE',
      'COST_EXCEEDS_MRP', 'SELLING_ABOVE_MRP', 'LOW_MATCH_CONFIDENCE', 'EXPIRY_TOO_SOON',
      'LINE_TOTAL_MISMATCH', 'BATCH_EXISTS', 'SUPPLIER_UNRESOLVED', 'MISSING_INVOICE_NO',
      'DUPLICATE_INVOICE', 'NO_LINE_ITEMS', 'MISSING_INVOICE_DATE', 'FUTURE_INVOICE_DATE',
      'TOTALS_MISMATCH', 'LINES_TOTAL_MISMATCH',
      'PACK_UNPARSEABLE', 'ITEM_COUNT_MISMATCH',
    ]) {
      const label = warningLabel(code);
      expect(label).toBeTruthy();
      // A raw code reaching the counter is the failure this guards against.
      expect(label).not.toBe(code);
      expect(label).not.toMatch(/_/);
    }
  });

  test('an unknown code degrades to readable text rather than SCREAMING_CASE', () => {
    expect(warningLabel('SOME_NEW_RULE')).toBe('Some new rule');
    expect(warningLabel(undefined)).toBe('Problem');
  });

  test('errors take the red ramp, warnings amber', () => {
    expect(warningTone('error')).toBe('critical');
    expect(warningTone('warning')).toBe('warning');
  });

  test('warnings partition by severity and filter by field', () => {
    const warnings = [
      { code: 'EXPIRED', severity: 'error', field: 'exp_date' },
      { code: 'BATCH_EXISTS', severity: 'warning', field: 'batch_no' },
    ];
    expect(partitionWarnings(warnings).errors).toHaveLength(1);
    expect(partitionWarnings(warnings).advisories).toHaveLength(1);
    expect(warningsForField(warnings, 'exp_date')).toHaveLength(1);
    expect(warningsForField(warnings, 'mrp')).toHaveLength(0);
  });
});

describe('line arithmetic', () => {
  test('free goods count toward stock taken in', () => {
    // 10 strips billed + 2 free = 12 strips. The pack contents play no part.
    expect(totalUnits(line())).toBe(12);
  });

  test('free goods do not count toward what is paid', () => {
    // The asymmetry with totalUnits is why scheme quantity is its own field.
    expect(lineValue(line())).toBe(85);
  });

  test('the pack column never changes the stock figure', () => {
    // A hundred tablets to a strip or ten, twelve strips arrive either way.
    expect(totalUnits(line({ content_quantity: 100 }))).toBe(12);
    expect(totalUnits(line({ content_quantity: null, pack_raw: null }))).toBe(12);
  });

  test('string values from an input element are handled', () => {
    expect(totalUnits(line({ qty_billed: '10', qty_free: '' }))).toBe(10);
    expect(lineValue(line({ unit_cost: '8.50', qty_billed: '10' }))).toBe(85);
  });

  test('missing parts degrade to zero rather than NaN', () => {
    expect(totalUnits({})).toBe(0);
    expect(lineValue({})).toBe(0);
    expect(totalUnits(null)).toBe(0);
  });

  test('margin is per unit, and null when either side is unknown', () => {
    expect(unitMargin(line())).toBe(2.5);
    expect(unitMargin(line({ selling_price: null }))).toBeNull();
    expect(unitMargin(line({ unit_cost: null }))).toBeNull();
  });

  test('the lines total excludes excluded lines', () => {
    expect(sumLineValues([line(), line({ id: 'l2', is_excluded: true })])).toBe(85);
    expect(sumLineValues([line(), line({ id: 'l2' })])).toBe(170);
  });
});

describe('import readiness', () => {
  const invoice = (over = {}) => ({
    status: 'NEEDS_REVIEW', validation_warnings: [], items: [line()], ...over,
  });

  test('a clean draft can be imported', () => {
    expect(canImport(invoice())).toBe(true);
  });

  test('warnings alone never block', () => {
    expect(canImport(invoice({
      validation_warnings: [{ code: 'TOTALS_MISMATCH', severity: 'warning' }],
      items: [line({ warnings: [{ code: 'EXPIRY_TOO_SOON', severity: 'warning' }] })],
    }))).toBe(true);
  });

  test('one line error blocks the whole document', () => {
    expect(canImport(invoice({
      items: [line(), line({ id: 'l2', line_no: 2, warnings: [{ code: 'EXPIRED', severity: 'error' }] })],
    }))).toBe(false);
  });

  test('an error on an excluded line does not block', () => {
    expect(canImport(invoice({
      items: [line({ is_excluded: true, warnings: [{ code: 'UNMAPPED_MEDICINE', severity: 'error' }] })],
    }))).toBe(true);
  });

  test('an already-imported invoice is never importable again', () => {
    expect(canImport(invoice({ status: 'IMPORTED' }))).toBe(false);
    expect(canImport(invoice({ status: 'REJECTED' }))).toBe(false);
    expect(canImport(null)).toBe(false);
  });

  test('blocking issues carry their line number so the list is actionable', () => {
    const issues = blockingIssues(invoice({
      validation_warnings: [{ code: 'DUPLICATE_INVOICE', severity: 'error' }],
      items: [line({ line_no: 4, warnings: [{ code: 'EXPIRED', severity: 'error' }] })],
    }));
    expect(issues).toHaveLength(2);
    expect(issues.find((i) => i.code === 'DUPLICATE_INVOICE').line_no).toBeUndefined();
    expect(issues.find((i) => i.code === 'EXPIRED').line_no).toBe(4);
  });
});

/* Mirrors the backend's supplier-invoices.normalize.js. Both sides use LIV 52
   TAB from MEDICO M002277, so a divergence between the review screen's live
   arithmetic and the server's shows up as a failure here rather than as two
   different numbers in front of a reviewer. */
describe('saleable-unit denomination', () => {
  const medicoLine = line({
    qty_billed: 5, qty_free: 0, pack_raw: "100'S", sale_unit: 'STRIP',
    content_quantity: 100, content_unit: 'PIECE',
    printed_rate: 103.12, unit_cost: 100.03, mrp: 150, selling_price: 150,
  });

  test('stock is the quantity column, never the pack contents', () => {
    // 5 STRIPS, not 500 tablets. inventory_ledger counts strips.
    expect(totalUnits(medicoLine)).toBe(5);
  });

  test('contents are reported separately and never as a quantity', () => {
    expect(totalContent(medicoLine)).toEqual({ quantity: 500, unit: 'PIECE' });
  });

  test('nested packs count sub-items through', () => {
    const nested = line({
      qty_billed: 20, qty_free: 0, pack_raw: '7X2ML',
      sub_pack_quantity: 7, sub_pack_unit: 'AMPOULE', content_quantity: 2, content_unit: 'ML',
    });
    expect(totalUnits(nested)).toBe(20);
    expect(totalContent(nested)).toEqual({ quantity: 140, unit: 'AMPOULE' });
  });

  test('the printed value reconciles against the printed line total', () => {
    // 5 x 103.12 = 515.60, exactly what the invoice prints.
    expect(printedLineValue(medicoLine)).toBe(515.60);
  });

  test('the derived value is net of discount and so comes in lower', () => {
    expect(lineValue(medicoLine)).toBe(500.15);
    expect(lineValue(medicoLine)).toBeLessThan(printedLineValue(medicoLine));
  });

  test('no printed rate means nothing to reconcile against', () => {
    expect(printedLineValue(line({ printed_rate: null }))).toBeNull();
  });

  test('free goods are stock but are not paid for', () => {
    // 10 strips billed + 2 free: 12 on the shelf, 10 charged for.
    expect(totalUnits(line())).toBe(12);
    expect(lineValue(line())).toBe(85);
  });
});

describe('line naming', () => {
  test('the catalogue name wins once mapped, the printed line until then', () => {
    expect(lineTitle(line({ medicines: { name: 'Paracip 500mg' }, raw_description: 'PARACIP 500 TAB' })))
      .toBe('Paracip 500mg');
    expect(lineTitle(line({ raw_description: 'PARACIP 500 TAB' }))).toBe('PARACIP 500 TAB');
  });

  test('never a bare id and never blank', () => {
    expect(lineTitle(line({ raw_description: null }))).toBe('Line 1');
    expect(lineTitle(null)).toBe('Line ?');
  });
});

describe('unit inference for Quick Add', () => {
  test('infers strips for tablets and capsules', () => {
    expect(inferUnit({ raw_description: 'PARACETAMOL 650MG TAB', pack_raw: "10'S" })).toBe('strips');
    expect(inferUnit({ raw_description: 'AMLO 5MG', pack_raw: '10TAB' })).toBe('strips');
    expect(inferUnit({ raw_description: 'RABEPRAZOLE 20MG CAPSULES', pack_raw: '15S' })).toBe('strips');
  });

  test('infers bottles for syrups, drops, and powders in GM', () => {
    expect(inferUnit({ raw_description: 'JOHNSON BABY POWDER', pack_raw: '30GM' })).toBe('bottles');
    expect(inferUnit({ raw_description: 'BENADRYL COUGH SYRUP', pack_raw: '100ML' })).toBe('bottles');
    expect(inferUnit({ raw_description: 'CIPLOX EYE DROPS', pack_raw: '5ML' })).toBe('bottles');
    expect(inferUnit({ raw_description: 'CANDID DUSTING POWDER', pack_raw: '100GM' })).toBe('bottles');
  });

  test('infers tubes for ointments, creams and gels', () => {
    expect(inferUnit({ raw_description: 'BETADINE OINTMENT 5%', pack_raw: '15GM' })).toBe('tubes');
    expect(inferUnit({ raw_description: 'VOLINI GEL', pack_raw: '30GM' })).toBe('tubes');
    expect(inferUnit({ raw_description: 'CLINDAMYCIN CREAM', pack_raw: '20GM' })).toBe('tubes');
  });

  test('infers vials for injections and ampoules', () => {
    expect(inferUnit({ raw_description: 'INSULIN GLARGINE', pack_raw: '3ML VIAL' })).toBe('vials');
    expect(inferUnit({ raw_description: 'CEFTRIAXONE 1G INJ', pack_raw: '1 VIAL' })).toBe('vials');
  });

  test('infers packs for inhalers and combipacks', () => {
    expect(inferUnit({ raw_description: 'ASTHALIN INHALER 200MD', pack_raw: '1' })).toBe('packs');
    expect(inferUnit({ raw_description: 'RESPULES 2ML', pack_raw: '7X2ML' })).toBe('packs');
  });

  test('infers pcs for soaps and devices', () => {
    expect(inferUnit({ raw_description: 'DETTOL SOAP', pack_raw: '75G' })).toBe('pcs');
    expect(inferUnit({ raw_description: 'CREPE BANDAGE', pack_raw: '1PC' })).toBe('pcs');
  });

  test('falls back gracefully to strips when unknown', () => {
    expect(inferUnit({})).toBe('strips');
    expect(inferUnit(null)).toBe('strips');
  });
});
