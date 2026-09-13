import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/* ═══════════════════════════════════════════════════════════════════════════
   useResource — the list-page fetch loop, once.

   Three pages hand-rolled this (MedicinesPage, InventoryPage, BillsListPage)
   and the rest improvised variants of it. Each carried its own debounce
   timing, its own "reset to page 1 when a filter changes" rule — which some
   forgot, so filtering while on page 4 of a 4-page result showed an empty
   list — and its own error handling.

   Debounce applies to filter changes only. Paging is deliberately immediate:
   a 350ms delay after clicking "Next" reads as a broken button.
   ═══════════════════════════════════════════════════════════════════════════ */

const DEBOUNCE_MS = 350;

export default function useResource({
  endpoint,
  initialFilters = {},
  pageSize = 15,
  select,
  enabled = true,
}) {
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0, limit: pageSize });
  /* Anything the endpoint returns beside rows and pagination — catalogue-wide
     stat counts, so far. It rides the SAME response as the rows on purpose: a
     separate stats fetch would carry its own debounce and its own staleness
     guard, so after every keystroke the counts would describe the previous
     search while the table below already showed the new one. On Inventory
     those counts are clickable chips that SET a filter, so a count that
     disagrees with the list under it is not a cosmetic lag.

     Named `meta` rather than `stats` to keep the hook domain-neutral. */
  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Guards against a slow early response overwriting a newer one — the classic
  // "type fast, see stale results" bug.
  const requestId = useRef(0);

  // `select` is written inline by each caller, so it has a new identity every
  // render. Holding it in a ref keeps fetchPage stable; the ref is updated in
  // an effect rather than during render, because mutating a ref mid-render is
  // a real correctness hazard under concurrent rendering.
  const selectRef = useRef(select);
  useEffect(() => { selectRef.current = select; });

  const fetchPage = useCallback(
    async (currentFilters, currentPage) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({ page: String(currentPage), limit: String(pageSize) });
      for (const [key, value] of Object.entries(currentFilters)) {
        if (value !== '' && value !== null && value !== undefined) params.set(key, String(value));
      }

      try {
        const res = await api.get(`${endpoint}?${params}`);
        if (id !== requestId.current) return; // superseded
        const picked = selectRef.current ? selectRef.current(res) : { rows: res.data, pagination: res.data?.pagination };
        setRows(picked.rows || []);
        setPagination(picked.pagination || { page: currentPage, pages: 1, total: (picked.rows || []).length, limit: pageSize });
        setMeta(picked.meta ?? null);
      } catch (err) {
        if (id !== requestId.current) return;
        setError(err);
        setRows([]);
        setMeta(null);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [endpoint, pageSize]
  );

  // Filter changes are debounced and always reset to the first page.
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(() => {
      setPage(1);
      fetchPage(filters, 1);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, enabled, fetchPage]);

  const goToPage = useCallback(
    (next) => {
      setPage(next);
      fetchPage(filters, next);
    },
    [fetchPage, filters]
  );

  const setFilter = useCallback((key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);

  // Callers pass an object literal, so compare by value rather than identity.
  const initialFiltersKey = JSON.stringify(initialFilters);
  const resetFilters = useCallback(
    () => setFilters(JSON.parse(initialFiltersKey)),
    [initialFiltersKey]
  );

  const reload = useCallback(() => fetchPage(filters, page), [fetchPage, filters, page]);

  /** True when the list is empty because of filters rather than because there
   *  is genuinely nothing — the two need different empty-state copy (§5). */
  const isFiltered = Object.values(filters).some((v) => v !== '' && v !== null && v !== undefined);

  return {
    rows, pagination, meta, loading, error,
    filters, setFilter, setFilters, resetFilters, isFiltered,
    page, goToPage, reload,
  };
}
