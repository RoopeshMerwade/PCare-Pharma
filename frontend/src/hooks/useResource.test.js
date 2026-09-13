import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useResource from './useResource';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }));

/* The `meta` passthrough exists so catalogue-wide stat counts can ride the same
   response as the rows. Before it, useResource destructured `picked` down to
   exactly `rows` and `pagination` and silently dropped everything else — a
   `stats` key returned by `select` simply vanished.

   The regression that matters most here is the FIRST test: six existing callers
   return no `meta`, and none of them may start seeing anything new. */

const respond = (data) => api.get.mockResolvedValue({ data });

beforeEach(() => {
  vi.clearAllMocks();
  respond({ rows: [], pagination: { page: 1, pages: 1, total: 0, limit: 15 } });
});

describe('useResource — meta passthrough', () => {
  test('meta is null when select does not return one', async () => {
    // The contract for every caller that has not opted in.
    respond({ medicines: [{ id: 'm1' }], pagination: { page: 1, pages: 2, total: 20, limit: 15 } });

    const { result } = renderHook(() => useResource({
      endpoint: '/medicines',
      select: (res) => ({ rows: res.data.medicines, pagination: res.data.pagination }),
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.meta).toBeNull();
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.pagination.total).toBe(20);
  });

  test('meta is surfaced when select returns one', async () => {
    respond({
      inventory: [{ id: 'm1' }],
      pagination: { page: 1, pages: 3, total: 42, limit: 15 },
      stats: { total: 42, out: 7, low: 12, near: 3 },
    });

    const { result } = renderHook(() => useResource({
      endpoint: '/inventory',
      select: (res) => ({
        rows: res.data.inventory,
        pagination: res.data.pagination,
        meta: { stats: res.data.stats },
      }),
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.meta.stats).toEqual({ total: 42, out: 7, low: 12, near: 3 });
  });

  test('meta clears on error, so stale counts cannot outlive their rows', async () => {
    respond({
      inventory: [{ id: 'm1' }],
      pagination: { page: 1, pages: 1, total: 1, limit: 15 },
      stats: { total: 1, out: 0, low: 0, near: 0 },
    });

    const select = (res) => ({
      rows: res.data.inventory,
      pagination: res.data.pagination,
      meta: { stats: res.data.stats },
    });
    const { result } = renderHook(() => useResource({ endpoint: '/inventory', select }));
    await waitFor(() => expect(result.current.meta).not.toBeNull());

    api.get.mockRejectedValue(new Error('network down'));
    await act(async () => { await result.current.reload(); });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.meta).toBeNull();
    expect(result.current.rows).toEqual([]);
  });

  test('a superseded slow response does not overwrite newer meta', async () => {
    // The same staleness guard the rows already had. Without it the chips could
    // end up describing an older search than the table beneath them — and on
    // Inventory those chips are the control that sets the filter.
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });

    api.get
      .mockReturnValueOnce(first)
      .mockResolvedValue({
        data: { inventory: [], pagination: { page: 2, pages: 2, total: 2, limit: 1 }, stats: { total: 999 } },
      });

    const select = (res) => ({
      rows: res.data.inventory,
      pagination: res.data.pagination,
      meta: { stats: res.data.stats },
    });
    const { result } = renderHook(() => useResource({ endpoint: '/inventory', select }));

    // Start a second request while the first is still in flight, then let the
    // stale one land last.
    await act(async () => { result.current.goToPage(2); });
    await waitFor(() => expect(result.current.meta?.stats?.total).toBe(999));

    await act(async () => {
      releaseFirst({ data: { inventory: [], pagination: { page: 1, pages: 2, total: 2, limit: 1 }, stats: { total: 111 } } });
      await first;
    });

    expect(result.current.meta.stats.total).toBe(999);
  });
});

describe('useResource — the pager contract these endpoints now satisfy', () => {
  test('a response with no pagination still falls back to one page', async () => {
    // Why Inventory and Suppliers never showed a pager: this fallback plus
    // Pagination.jsx returning null at pages <= 1.
    respond({ rows: [{ id: 1 }, { id: 2 }] });
    const { result } = renderHook(() => useResource({
      endpoint: '/legacy',
      select: (res) => ({ rows: res.data.rows, pagination: res.data.pagination }),
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pagination.pages).toBe(1);
    expect(result.current.pagination.total).toBe(2);
  });

  test('page and limit are always sent', async () => {
    renderHook(() => useResource({ endpoint: '/inventory', pageSize: 30 }));
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.get.mock.calls[0][0]).toContain('page=1');
    expect(api.get.mock.calls[0][0]).toContain('limit=30');
  });
});
