import { describe, test, expect } from 'vitest';
import {
  isCountableContent,
  supportsLooseSale,
  packContents,
  perUnitPrice,
  contentNoun,
  sealedNoun,
  packLabel,
  availabilityLabel,
  looseAvailable,
  lineTotals,
  wholePackHint,
} from './pack';

/* The deliberate mirror of backend/tests/unit/loose-units.test.js. The two
   suites assert the same arithmetic on purpose: the server is the authority,
   and this file is what proves the counter is not quoting a different number
   while the cashier types. */

const strip = (over = {}) => ({
  unit: 'strips',
  pack_content_quantity: 10,
  pack_content_unit: 'PIECE',
  loose_sale_supported: true,
  total_stock: 24,
  total_loose_stock: 6,
  unit_price: 50,
  qty: '0',
  loose_qty: '0',
  ...over,
});

const syrup = (over = {}) => ({
  unit: 'bottles',
  pack_content_quantity: 100,
  pack_content_unit: 'ML',
  loose_sale_supported: false,
  total_stock: 6,
  total_loose_stock: 0,
  unit_price: 80,
  qty: '0',
  loose_qty: '0',
  ...over,
});

describe('isCountableContent', () => {
  test.each(['TABLET', 'CAPSULE', 'PIECE'])('%s is countable', (u) => {
    expect(isCountableContent(u)).toBe(true);
  });

  // The rule the whole feature rests on: the suffix carries the meaning, and
  // 100'S / 100ML / 100GM / 100MD are four different things.
  test.each(['ML', 'GM', 'L', 'DOSE', 'MG', 'IU'])('%s is not countable', (u) => {
    expect(isCountableContent(u)).toBe(false);
  });

  test('a missing unit is not countable', () => {
    expect(isCountableContent(null)).toBe(false);
    expect(isCountableContent(undefined)).toBe(false);
  });
});

describe('supportsLooseSale', () => {
  test('trusts the server flag when the payload carries it', () => {
    expect(supportsLooseSale(strip())).toBe(true);
    expect(supportsLooseSale(syrup())).toBe(false);
  });

  // Same fallback shape stockStatus() uses for is_low_stock — a payload from
  // before the column existed still gets a correct answer.
  test('falls back to the local test when the flag is absent', () => {
    expect(supportsLooseSale({ pack_content_quantity: 10, pack_content_unit: 'TABLET' })).toBe(true);
    expect(supportsLooseSale({ pack_content_quantity: 100, pack_content_unit: 'ML' })).toBe(false);
  });

  test('a pack with no recorded contents is never splittable', () => {
    expect(supportsLooseSale({ unit: 'strips' })).toBe(false);
  });

  test('a pack of one is already its own smallest unit', () => {
    expect(supportsLooseSale({ pack_content_quantity: 1, pack_content_unit: 'PIECE' })).toBe(false);
  });
});

describe('perUnitPrice', () => {
  test('divides the pack price by its contents', () => {
    expect(perUnitPrice(50, 10)).toBe(5);
    expect(perUnitPrice(18, 15)).toBe(1.2);
  });

  // Mirrors roundPaise: the naive Math.round(x*100)/100 yields 2.42 here,
  // which would quote a price a paisa under what the bill charges.
  test('rounds half-up to paise', () => {
    expect(perUnitPrice(24.25, 10)).toBe(2.43);
    expect(perUnitPrice(10, 7)).toBe(1.43);
  });

  test('floors at one paisa', () => {
    expect(perUnitPrice(0.1, 100)).toBe(0.01);
  });

  test('returns null rather than zero when either side is unknown', () => {
    expect(perUnitPrice(50, 0)).toBeNull();
    expect(perUnitPrice(0, 10)).toBeNull();
    expect(perUnitPrice(null, null)).toBeNull();
  });
});

describe('labels', () => {
  test('contentNoun names the single unit, with an honest fallback', () => {
    expect(contentNoun('TABLET')).toBe('tablet');
    expect(contentNoun('CAPSULE', { plural: true })).toBe('capsules');
    // PIECE has no better English noun than "unit" — inventing "piece" or
    // guessing "tablet" would put a wrong word next to a dispensed quantity.
    expect(contentNoun('PIECE', { plural: true })).toBe('units');
    expect(contentNoun(null)).toBe('unit');
  });

  test('sealedNoun singularises the catalogue unit', () => {
    expect(sealedNoun('strips')).toBe('strip');
    expect(sealedNoun('strips', { plural: true })).toBe('strips');
    expect(sealedNoun(undefined)).toBe('unit');
  });

  test('packLabel states what one pack holds', () => {
    expect(packLabel(strip({ pack_content_unit: 'TABLET' }))).toBe('10 tablets per strip');
  });

  test('packLabel is null when the pack was never recorded', () => {
    expect(packLabel({ unit: 'strips' })).toBeNull();
  });

  // Never one number. 24 strips and 6 tablets is not "24.6 strips" and not
  // "246 tablets" — they are different physical things.
  test('availabilityLabel keeps the two pools apart', () => {
    expect(availabilityLabel(strip())).toBe('24 strips + 6 units');
    expect(availabilityLabel(strip({ total_loose_stock: 0 }))).toBe('24 strips');
    expect(availabilityLabel(strip({ total_stock: 1, total_loose_stock: 1, pack_content_unit: 'TABLET' })))
      .toBe('1 strip + 1 tablet');
  });

  test('availabilityLabel on a non-splittable medicine is just the pack count', () => {
    expect(availabilityLabel(syrup())).toBe('6 bottles');
  });
});

describe('looseAvailable', () => {
  test('counts what is open plus what every sealed pack would yield', () => {
    expect(looseAvailable(strip())).toBe(246); // 6 loose + 24 × 10
  });

  test('is zero for anything that cannot be split', () => {
    expect(looseAvailable(syrup())).toBe(0);
  });
});

describe('lineTotals', () => {
  test('a sealed-only line prices exactly as it always did', () => {
    const t = lineTotals(strip({ qty: '2' }));
    expect(t.sealedTotal).toBe(100);
    expect(t.looseTotal).toBe(0);
    expect(t.total).toBe(100);
  });

  test('a loose-only line prices per single unit', () => {
    const t = lineTotals(strip({ qty: '0', loose_qty: '2' }));
    expect(t.loosePrice).toBe(5);
    expect(t.total).toBe(10);
  });

  test('a mixed line adds each half at its own rate', () => {
    const t = lineTotals(strip({ qty: '2', loose_qty: '3' }));
    expect(t.total).toBe(115); // 2 × 50 + 3 × 5
    expect(t.contentUnits).toBe(23); // 2 × 10 + 3
  });

  test('contentUnits is null when the pack is unrecorded', () => {
    expect(lineTotals({ unit: 'strips', qty: '2', unit_price: 50 }).contentUnits).toBeNull();
  });

  test('an empty line is zero, not NaN', () => {
    const t = lineTotals(strip({ qty: '', loose_qty: '' }));
    expect(t.total).toBe(0);
  });
});

describe('wholePackHint', () => {
  test('flags a loose quantity that is a whole pack', () => {
    expect(wholePackHint(strip({ loose_qty: '10' })))
      .toBe("That's 1 full strip — adding it as a strip keeps the pack sealed.");
  });

  test('reports packs and remainder above one pack', () => {
    expect(wholePackHint(strip({ loose_qty: '23', pack_content_unit: 'TABLET' })))
      .toBe("That's 2 full strips and 3 tablets.");
  });

  test('stays quiet below a full pack — the normal case', () => {
    expect(wholePackHint(strip({ loose_qty: '3' }))).toBeNull();
  });

  test('stays quiet when there is no pack to compare against', () => {
    expect(wholePackHint({ unit: 'strips', loose_qty: '3' })).toBeNull();
  });

  test('packContents reads the recorded pack, or zero', () => {
    expect(packContents(strip())).toBe(10);
    expect(packContents({})).toBe(0);
  });
});
