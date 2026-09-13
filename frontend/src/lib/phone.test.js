import { describe, test, expect } from 'vitest';
import { isContactPhone, normalizeContactPhone } from './phone';

// Deliberate mirror of backend/tests/unit/contact-phone.test.js. If one of
// these two files changes, the other is wrong until it does too.

describe('isContactPhone', () => {
  test('accepts the extracted letterhead number that used to 422', () => {
    expect(isContactPhone('08373-266025261596')).toBe(true);
  });

  test.each([
    ['0836-2661234'],
    ['0836 2661234'],
    ['0836-2661234 / 2661235'],
    ['(080) 2345-6789'],
    ['9845098450'],
    ['+91 98450 98450'],
    ['+919845098450'],
    ['09845098450'],
    ['2661234, 2661235'],
    ['266025'],
  ])('accepts %s', (value) => {
    expect(isContactPhone(value)).toBe(true);
  });

  test.each([
    ['Ph: 9845098450'],
    ['call Rajesh'],
    ['29AABCU9603R1ZX'],
    ['12345'],
    ['1'.repeat(26)],
    [''],
    ['   '],
  ])('rejects %s', (value) => {
    expect(isContactPhone(value)).toBe(false);
  });

  test('rejects non-strings', () => {
    expect(isContactPhone(9845098450)).toBe(false);
    expect(isContactPhone(null)).toBe(false);
    expect(isContactPhone(undefined)).toBe(false);
  });
});

describe('normalizeContactPhone', () => {
  test('collapses whitespace and trims', () => {
    expect(normalizeContactPhone('  0836 -  2661234  ')).toBe('0836 - 2661234');
  });

  test('turns every kind of blank into null', () => {
    expect(normalizeContactPhone('')).toBeNull();
    expect(normalizeContactPhone('   ')).toBeNull();
  });

  test('passes non-strings through untouched', () => {
    expect(normalizeContactPhone(null)).toBeNull();
    expect(normalizeContactPhone(9845098450)).toBe(9845098450);
  });
});
