/**
 * Unit tests — PostgREST helpers. Pure, no database.
 */

const { ilikeTerm, parsePagination } = require('../../src/utils/postgrest');

describe('ilikeTerm', () => {
  test('wraps the term in wildcards and lowercases', () => {
    expect(ilikeTerm('Paracetamol')).toBe('%paracetamol%');
  });

  test('neutralizes PostgREST or() syntax characters', () => {
    // A comma or parens inside .or('name.ilike.%<term>%') alters the filter.
    expect(ilikeTerm('a,b.ilike.(x)')).not.toMatch(/[,()]/);
  });

  test('neutralizes LIKE wildcards from user input', () => {
    expect(ilikeTerm('100%')).toBe('%100%');
    expect(ilikeTerm('a%b')).toBe('%a b%');
  });

  test('handles null/undefined safely', () => {
    expect(ilikeTerm(undefined)).toBe('%%');
  });
});

describe('parsePagination', () => {
  test('applies defaults', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 30 });
  });

  test('caps limit at maxLimit', () => {
    expect(parsePagination({ limit: '5000' }).limit).toBe(100);
  });

  test('floors page at 1 and rejects garbage', () => {
    expect(parsePagination({ page: '-3', limit: 'abc' })).toEqual({ page: 1, limit: 30 });
  });
});
