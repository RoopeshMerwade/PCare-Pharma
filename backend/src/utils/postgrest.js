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

module.exports = { ilikeTerm, parsePagination };
