/**
 * Unit tests — loose-unit allocation (Module 27). Pure, no database.
 * These run without TEST_* credentials or a Supabase project.
 *
 * The invariant every case below is really checking: sealed stock stays
 * counted in packs and loose stock stays counted in contents, and the ONLY
 * thing that converts between them is opening a pack — one pack out, exactly
 * content_quantity units in. If a test here ever passes while stock changes
 * denomination somewhere else, that is the silent corruption schema-25 was
 * written to undo.
 */

const {
  mergeCartItems,
  allocateCartLine,
  allocateLooseFromPool,
  looseAvailable,
  supportsLooseSale,
  isCountableContent,
  perUnitPrice,
} = require('../../src/modules/billing/fefo');

/** A batch as batches_with_stock returns it. */
const batch = (id, { sealed = 0, loose = 0, content = 10, unit = 'PIECE', exp = '2027-01-31', price = 50, mrp = 60 } = {}) => ({
  id,
  exp_date: exp,
  stock_qty: sealed,
  sealed_qty: sealed,
  loose_qty: loose,
  effective_content_quantity: content,
  effective_content_unit: unit,
  loose_sale_supported: ['TABLET', 'CAPSULE', 'PIECE'].includes(unit) && content > 1,
  selling_price: price,
  mrp,
});

const looseLine = (result) => result.lines.find((l) => l.is_loose);
const sealedLines = (result) => result.lines.filter((l) => !l.is_loose);

describe('isCountableContent — what may be split at all', () => {
  test.each(['TABLET', 'CAPSULE', 'PIECE'])('%s is countable', (unit) => {
    expect(isCountableContent(unit)).toBe(true);
  });

  // The rule this module most needs to hold: a 30GM tube is one tube, and a
  // 100ML bottle is one bottle. Treating the number as a count of saleable
  // things is exactly the denomination error schema-25 reverted.
  test.each(['GM', 'ML', 'L', 'DOSE', 'MG', 'IU', 'KG', 'MCG'])('%s is NOT countable', (unit) => {
    expect(isCountableContent(unit)).toBe(false);
  });

  test('an unrecorded content unit is not countable', () => {
    expect(isCountableContent(null)).toBe(false);
    expect(isCountableContent('')).toBe(false);
  });
});

describe('perUnitPrice', () => {
  test('divides the pack price by its contents', () => {
    expect(perUnitPrice(50, 10)).toBe(5);
    expect(perUnitPrice(18, 15)).toBe(1.2);
  });

  // The reason roundPaise exists rather than Math.round(x*100)/100: 2.425 has
  // no exact double and the naive form yields 2.42, understating the price on
  // every tablet sold.
  test('rounds half-UP to paise', () => {
    expect(perUnitPrice(24.25, 10)).toBe(2.43);
    expect(perUnitPrice(10, 7)).toBe(1.43);
  });

  test('floors at one paisa — bill_items.unit_price has check (> 0)', () => {
    expect(perUnitPrice(0.1, 100)).toBe(0.01);
  });

  test('no contents, no per-unit price — never a silent zero', () => {
    expect(perUnitPrice(50, 0)).toBeNull();
    expect(perUnitPrice(50, null)).toBeNull();
    expect(perUnitPrice(null, 10)).toBeNull();
  });
});

describe('mergeCartItems with loose quantities', () => {
  test('sums both denominations separately, never into each other', () => {
    expect(mergeCartItems([
      { medicine_id: 'm1', qty: 2, loose_qty: 3 },
      { medicine_id: 'm1', qty: 1, loose_qty: 4 },
    ])).toEqual([{ medicine_id: 'm1', qty: 3, loose_qty: 7 }]);
  });

  // Backward compatibility, asserted rather than assumed: a cart that never
  // mentions loose units produces the exact object shape it always did.
  test('a sealed-only cart gains no loose_qty key', () => {
    const merged = mergeCartItems([{ medicine_id: 'm1', qty: 2 }]);
    expect(merged).toEqual([{ medicine_id: 'm1', qty: 2 }]);
    expect('loose_qty' in merged[0]).toBe(false);
  });

  test('a loose-only line keeps qty at zero', () => {
    expect(mergeCartItems([{ medicine_id: 'm1', qty: 0, loose_qty: 2 }]))
      .toEqual([{ medicine_id: 'm1', qty: 0, loose_qty: 2 }]);
  });
});

describe('allocateCartLine — loose allocation (the edge cases that matter)', () => {
  // Case 1: buy 2 tablets from a full shelf.
  test('opens exactly one pack and keeps the remainder loose', () => {
    const result = allocateCartLine([batch('a', { sealed: 10, loose: 0, content: 10 })], { looseQty: 2 });
    const line = looseLine(result);

    expect(result.looseShortfall).toBe(0);
    expect(line.qty).toBe(2);
    expect(line.strips_to_open).toBe(1);
    // 10 sealed − 1 opened = 9; 10 freed − 2 sold = 8 loose.
    expect(line.content_quantity).toBe(10);
  });

  // Case 2: an already-open pack covers it, so nothing new is broken.
  test('consumes existing loose stock without opening anything', () => {
    const result = allocateCartLine([batch('a', { sealed: 10, loose: 8, content: 10 })], { looseQty: 3 });
    const line = looseLine(result);

    expect(line.qty).toBe(3);
    expect(line.strips_to_open).toBe(0);
  });

  // Case 3: loose runs out mid-line and one more pack is opened to finish it.
  test('spends loose stock first, then opens the minimum to cover the rest', () => {
    const result = allocateCartLine([batch('a', { sealed: 10, loose: 8, content: 10 })], { looseQty: 10 });
    const line = looseLine(result);

    expect(line.qty).toBe(10);
    expect(line.strips_to_open).toBe(1); // 8 loose + 2 from one opened pack
  });

  // Case 4: the minimum, not one pack per tablet.
  test('25 tablets from 10s opens three packs, not twenty-five', () => {
    const result = allocateCartLine([batch('a', { sealed: 10, loose: 0, content: 10 })], { looseQty: 25 });
    const line = looseLine(result);

    expect(line.qty).toBe(25);
    expect(line.strips_to_open).toBe(3); // 30 freed, 25 sold, 5 left loose
  });

  test('3 tablets opens one pack — never ceil-to-quantity', () => {
    const result = allocateCartLine([batch('a', { sealed: 10, content: 10 })], { looseQty: 3 });
    expect(looseLine(result).strips_to_open).toBe(1);
  });

  // Case 5.
  test('no stock at all reports the full shortfall and allocates nothing', () => {
    const result = allocateCartLine([], { looseQty: 5 });
    expect(result.lines).toEqual([]);
    expect(result.looseShortfall).toBe(5);
  });

  test('shortfall is what is left after every batch is exhausted', () => {
    const result = allocateCartLine([batch('a', { sealed: 1, loose: 2, content: 10 })], { looseQty: 20 });
    expect(result.looseShortfall).toBe(8); // 2 loose + 10 from the last pack
  });
});

describe('allocateCartLine — FEFO across batches', () => {
  // Case 6 / the spec's worked example. Batch B must not be touched: the
  // nearest-expiry batch can still cover the line by opening one of its own.
  test('exhausts the nearest-expiry batch before touching the next', () => {
    const result = allocateCartLine([
      batch('jan', { sealed: 10, loose: 4, content: 10, exp: '2027-01-31' }),
      batch('jun', { sealed: 20, loose: 0, content: 10, exp: '2027-06-30' }),
    ], { looseQty: 6 });

    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    expect(line.batch_id).toBe('jan');
    expect(line.qty).toBe(6);
    expect(line.strips_to_open).toBe(1); // 4 loose + 2 from one opened pack
  });

  test('spills to the next batch only once the first is empty in both pools', () => {
    const result = allocateCartLine([
      batch('jan', { sealed: 1, loose: 2, content: 10, exp: '2027-01-31' }),
      batch('jun', { sealed: 5, loose: 0, content: 10, exp: '2027-06-30' }),
    ], { looseQty: 15 });

    expect(result.looseShortfall).toBe(0);
    expect(result.lines.map((l) => [l.batch_id, l.qty, l.strips_to_open]))
      .toEqual([['jan', 12, 1], ['jun', 3, 1]]);
  });

  // Case 7: loose stock never migrates between batches, because its expiry
  // date is the batch's. This is the whole reason loose_unit_ledger is keyed
  // by batch_id rather than by medicine.
  test('each batch keeps its own loose pool', () => {
    const result = allocateCartLine([
      batch('old', { sealed: 0, loose: 3, content: 10, exp: '2026-12-31' }),
      batch('new', { sealed: 0, loose: 5, content: 10, exp: '2027-12-31' }),
    ], { looseQty: 8 });

    expect(result.lines.map((l) => [l.batch_id, l.qty])).toEqual([['old', 3], ['new', 5]]);
    expect(result.lines.every((l) => l.strips_to_open === 0)).toBe(true);
  });
});

describe('allocateCartLine — mixed and sealed-only lines', () => {
  test('a sealed-only line is untouched by any of this', () => {
    const result = allocateCartLine([batch('a', { sealed: 10, content: 10 })], { qty: 2 });
    expect(result.lines).toEqual([
      { batch_id: 'a', qty: 2, unit_price: 50, mrp: 60, is_loose: false },
    ]);
    expect(result.looseShortfall).toBe(0);
  });

  test('2 packs + 3 tablets resolves to two lines in two denominations', () => {
    const result = allocateCartLine([batch('a', { sealed: 10, loose: 0, content: 10 })], { qty: 2, looseQty: 3 });

    expect(sealedLines(result)).toEqual([
      { batch_id: 'a', qty: 2, unit_price: 50, mrp: 60, is_loose: false },
    ]);
    expect(looseLine(result)).toMatchObject({
      batch_id: 'a', qty: 3, is_loose: true, strips_to_open: 1, unit_price: 5, mrp: 6,
    });
  });

  // The competition case. Both passes read one shared pool, so the sealed line
  // takes the last two packs and the loose half correctly reports a shortfall
  // instead of both halves claiming the same stock.
  test('sealed and loose cannot both claim the same pack', () => {
    const result = allocateCartLine([batch('a', { sealed: 2, loose: 0, content: 10 })], { qty: 2, looseQty: 5 });

    expect(result.sealedShortfall).toBe(0);
    expect(sealedLines(result)[0].qty).toBe(2);
    expect(result.looseShortfall).toBe(5);
    expect(looseLine(result)).toBeUndefined();
  });

  test('the loose half can still be filled from a pack the sealed half did not need', () => {
    const result = allocateCartLine([batch('a', { sealed: 3, loose: 0, content: 10 })], { qty: 2, looseQty: 5 });
    expect(result.sealedShortfall).toBe(0);
    expect(result.looseShortfall).toBe(0);
    expect(looseLine(result).strips_to_open).toBe(1);
  });
});

describe('non-countable packs are never split', () => {
  const syrup = batch('syr', { sealed: 6, loose: 0, content: 100, unit: 'ML' });
  const ointment = batch('oint', { sealed: 5, loose: 0, content: 30, unit: 'GM' });

  test('100ML of syrup is six bottles, not six hundred doses', () => {
    const result = allocateCartLine([syrup], { looseQty: 5 });
    expect(result.lines).toEqual([]);
    expect(result.looseShortfall).toBe(5);
  });

  test('30GM of ointment likewise', () => {
    expect(allocateCartLine([ointment], { looseQty: 1 }).looseShortfall).toBe(1);
  });

  test('but selling them whole still works exactly as before', () => {
    const result = allocateCartLine([syrup], { qty: 2 });
    expect(result.sealedShortfall).toBe(0);
    expect(result.lines[0].qty).toBe(2);
  });

  test('a pack of one is already its own smallest unit', () => {
    const single = batch('one', { sealed: 4, content: 1, unit: 'PIECE' });
    expect(supportsLooseSale([single])).toBe(false);
  });
});

describe('supportsLooseSale / looseAvailable — the counter-facing figures', () => {
  test('separates "not sold loose" from "not enough"', () => {
    expect(supportsLooseSale([batch('a', { sealed: 5, content: 10 })])).toBe(true);
    expect(supportsLooseSale([batch('a', { sealed: 5, content: 100, unit: 'ML' })])).toBe(false);
    expect(supportsLooseSale([])).toBe(false);
  });

  test('counts what is open plus what every sealed pack would yield', () => {
    expect(looseAvailable([
      batch('a', { sealed: 2, loose: 3, content: 10 }),
      batch('b', { sealed: 1, loose: 0, content: 10 }),
    ])).toBe(33); // (2×10 + 3) + (1×10)
  });

  test('ignores batches that cannot be split', () => {
    expect(looseAvailable([batch('syr', { sealed: 6, content: 100, unit: 'ML' })])).toBe(0);
  });
});

describe('allocateLooseFromPool mutates the pool it is given', () => {
  // This is what makes a mixed line correct — and what makes a second call
  // against the same pool see the first call's consumption.
  test('sealed and loose balances reflect the allocation', () => {
    const pool = [{ id: 'a', sealed: 10, loose: 4, content: 10, splittable: true, selling_price: 50, mrp: 60 }];
    allocateLooseFromPool(pool, 6);
    expect(pool[0]).toMatchObject({ sealed: 9, loose: 8 });
  });
});
