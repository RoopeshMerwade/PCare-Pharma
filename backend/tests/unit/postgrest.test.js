/**
 * Unit tests — PostgREST helpers. Pure, no database.
 */

const { ilikeTerm, parsePagination, paginationMeta, applySearch } = require('../../src/utils/postgrest');

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

describe('paginationMeta', () => {
  test('an empty result is 0 pages, not 1', () => {
    // What medicines.service.js already returned; Pagination.jsx treats 0 and
    // 1 identically (`if (!pages || pages <= 1) return null`).
    expect(paginationMeta(1, 30, 0)).toEqual({ page: 1, limit: 30, total: 0, pages: 0 });
  });

  test('rounds a partial last page up', () => {
    expect(paginationMeta(2, 15, 31).pages).toBe(3);
    expect(paginationMeta(1, 15, 30).pages).toBe(2);  // exact multiple, no phantom page
    expect(paginationMeta(1, 15, 1).pages).toBe(1);
  });

  test('a missing count is 0 pages, never NaN', () => {
    // Supabase returns count: null when the Content-Range header is absent.
    // Math.ceil(null/30) is 0 but Math.ceil(undefined/30) is NaN, which renders
    // as "NaN pages" under the table — the reason this helper exists.
    expect(paginationMeta(1, 30, null)).toEqual({ page: 1, limit: 30, total: 0, pages: 0 });
    expect(paginationMeta(1, 30, undefined)).toEqual({ page: 1, limit: 30, total: 0, pages: 0 });
    expect(paginationMeta(1, 30, NaN).pages).toBe(0);
  });

  test('echoes the page and limit it was asked about', () => {
    // Page 9999 of a 2-page result still reports page 9999 — the caller asked
    // for it, and Pagination needs the real `pages` to offer "Previous".
    expect(paginationMeta(9999, 10, 15)).toEqual({ page: 9999, limit: 10, total: 15, pages: 2 });
  });
});

describe('applySearch', () => {
  // A stand-in for a postgrest-js builder: .or() returns the builder, as the
  // real one does (it mutates its own URL and returns `this`).
  const fakeQuery = () => {
    const calls = [];
    const q = { calls, or: (arg) => { calls.push(arg); return q; } };
    return q;
  };

  test('returns the query untouched when there is nothing to search for', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const q = fakeQuery();
      expect(applySearch(q, blank, ['name'])).toBe(q);   // same identity
      expect(q.calls).toHaveLength(0);                    // and no filter added
    }
  });

  test('builds ONE or() across every column', () => {
    const q = fakeQuery();
    applySearch(q, 'amox', ['name', 'generic_name', 'manufacturer']);
    expect(q.calls).toEqual(['name.ilike.%amox%,generic_name.ilike.%amox%,manufacturer.ilike.%amox%']);
  });

  test('the term is sanitised, so a search cannot alter the filter', () => {
    // The whole reason this wrapper exists rather than each service hand-rolling
    // the string: ilikeTerm strips PostgREST filter syntax out of the TERM,
    // leaving only the commas this function put between columns.
    const q = fakeQuery();
    applySearch(q, 'a,b.ilike.(x)', ['name', 'generic_name']);
    const [filter] = q.calls;
    expect(filter.split(',')).toHaveLength(2);   // one comma, ours
    expect(filter).not.toMatch(/[()]/);
  });
});
