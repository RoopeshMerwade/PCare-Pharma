// Pure — no credentials, no network, no Supabase. Mirrored by
// frontend/src/lib/phone.test.js; keep the two in step.

const {
  isContactPhone,
  normalizeContactPhone,
} = require('../../src/utils/phone');

describe('isContactPhone — landlines are the point', () => {
  // The number that started this: MEDICO's letterhead, as extracted. Two
  // printed numbers run together by the scan, but a real value a reviewer
  // should be able to save and correct later — isMobilePhone('en-IN') refused
  // it and there is no other screen on which to fix it.
  test('accepts the extracted letterhead number that used to 422', () => {
    expect(isContactPhone('08373-266025261596')).toBe(true);
  });

  test.each([
    ['STD landline with a hyphen', '0836-2661234'],
    ['STD landline with a space', '0836 2661234'],
    ['two numbers on one line', '0836-2661234 / 2661235'],
    ['parenthesised area code', '(080) 2345-6789'],
    ['plain mobile', '9845098450'],
    ['mobile with country code', '+91 98450 98450'],
    ['country code, no spaces', '+919845098450'],
    ['leading-zero trunk prefix', '09845098450'],
    ['comma-separated pair', '2661234, 2661235'],
    ['six-digit local number', '266025'],
  ])('accepts %s', (_label, value) => {
    expect(isContactPhone(value)).toBe(true);
  });

  test.each([
    ['a label swept in with the number', 'Ph: 9845098450'],
    ['a name', 'call Rajesh'],
    ['a GSTIN pasted into the wrong box', '29AABCU9603R1ZX'],
    ['too few digits to dial', '12345'],
    ['an account number', '1'.repeat(26)],
    ['longer than the column deserves', `${'9'.repeat(20)} / ${'8'.repeat(20)}`],
    ['empty', ''],
    ['whitespace only', '   '],
    ['a number, not a string', 9845098450],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isContactPhone(value)).toBe(false);
  });

  // Blankness is `.optional()`'s call, not the shape rule's. Folding the two
  // together is exactly how the field ended up labelled "(optional)" while
  // being impossible to leave empty.
  test('says nothing about whether the field may be omitted', () => {
    expect(isContactPhone('')).toBe(false);
    expect(normalizeContactPhone('')).toBeNull();
  });
});

describe('normalizeContactPhone', () => {
  test('collapses whitespace and trims', () => {
    expect(normalizeContactPhone('  0836 -  2661234  ')).toBe('0836 - 2661234');
  });

  // The forms submit '' for "no phone". Storing that alongside NULL would give
  // the column two spellings of absent.
  test.each([['', null], ['   ', null], ['\n\t ', null]])(
    'turns %j into null',
    (input, expected) => {
      expect(normalizeContactPhone(input)).toBe(expected);
    },
  );

  test('passes non-strings through untouched so the validator can see them', () => {
    expect(normalizeContactPhone(null)).toBeNull();
    expect(normalizeContactPhone(undefined)).toBeUndefined();
    expect(normalizeContactPhone(9845098450)).toBe(9845098450);
  });

  test('leaves a good number alone', () => {
    expect(normalizeContactPhone('+91 98450 98450')).toBe('+91 98450 98450');
  });
});
