// ── PostgREST query helpers.

// User-supplied search text is interpolated into .or('col.ilike.%term%,...')
// filter strings. Commas, parentheses and dots are PostgREST filter syntax —
// left unescaped they let a search term alter the filter (or just 500).
// Strip them; % and \ are LIKE wildcards, also neutralized.
function ilikeTerm(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[,().%\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `%${cleaned}%`;
}

// Consistent pagination parsing: 1-based page, hard cap on limit.
function parsePagination(query, { defaultLimit = 30, maxLimit = 100 } = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit };
}

/**
 * The response envelope every paginated service returns.
 *
 * Extracted because eight services build it by hand and they had already
 * drifted: some divide a possibly-null `count` straight through, and
 * `Math.ceil(null / limit)` is 0 while `Math.ceil(undefined / limit)` is NaN —
 * one of which renders as "NaN pages" under the table.
 *
 * `pages: 0` on an empty result is deliberate rather than floored to 1: it is
 * what medicines.service.js already returns, and Pagination.jsx treats 0 and 1
 * identically (`if (!pages || pages <= 1) return null`).
 */
function paginationMeta(page, limit, count) {
  const total = Number.isFinite(count) ? count : 0;
  return { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) };
}

/**
 * Applies a free-text search across `columns` as one top-level `or=(...)`.
 *
 * Returns the query untouched when there is nothing to search for, so callers
 * do not each re-implement the blank-string guard. `ilikeTerm` is already the
 * sanitiser; this exists so the `.or()` string built around it has ONE
 * definition to audit for filter injection rather than one per service.
 */
function applySearch(query, search, columns) {
  if (!search?.trim()) return query;
  const term = ilikeTerm(search);
  return query.or(columns.map((c) => `${c}.ilike.${term}`).join(','));
}

module.exports = { ilikeTerm, parsePagination, paginationMeta, applySearch };
