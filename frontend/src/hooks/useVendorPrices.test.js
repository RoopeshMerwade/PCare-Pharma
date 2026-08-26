import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useVendorPrices from './useVendorPrices';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }));

const vendorsFor = (ids) => ({
  data: { vendors: Object.fromEntries(ids.map((id) => [id, []])) },
});

beforeEach(() => vi.clearAllMocks());

describe('useVendorPrices', () => {
  test('batches every id into ONE request', async () => {
    // The whole point of the hook: adding twelve low-stock medicines at once
    // must not cost twelve round trips.
    api.get.mockResolvedValue(vendorsFor(['a', 'b', 'c']));
    const { result } = renderHook(() => useVendorPrices());

    await act(async () => { await result.current.ensure(['a', 'b', 'c']); });

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0][0]).toContain('medicine_ids=a,b,c');
  });

  test('does not refetch what is already cached', async () => {
    api.get.mockResolvedValue(vendorsFor(['a']));
    const { result } = renderHook(() => useVendorPrices());

    await act(async () => { await result.current.ensure(['a']); });
    await act(async () => { await result.current.ensure(['a']); });

    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test('asks only for the ids it is missing', async () => {
    api.get.mockResolvedValueOnce(vendorsFor(['a'])).mockResolvedValueOnce(vendorsFor(['b']));
    const { result } = renderHook(() => useVendorPrices());

    await act(async () => { await result.current.ensure(['a']); });
    await act(async () => { await result.current.ensure(['a', 'b']); });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get.mock.calls[1][0]).toContain('medicine_ids=b');
    expect(api.get.mock.calls[1][0]).not.toContain('a,');
  });

  test('caches an empty result so it is not asked for again', async () => {
    // [] means "no distributors at all" and is a real answer. Treating it as a
    // cache miss would re-request it on every render.
    api.get.mockResolvedValue(vendorsFor(['a']));
    const { result } = renderHook(() => useVendorPrices());

    await act(async () => { await result.current.ensure(['a']); });
    await waitFor(() => expect(result.current.pricesFor('a')).toEqual([]));

    await act(async () => { await result.current.ensure(['a']); });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test('a failed lookup does not leave the line stuck loading forever', async () => {
    // undefined renders a spinner; [] renders "no rate on record" and keeps the
    // line submittable. A rejected request must land on the second.
    api.get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useVendorPrices());

    await act(async () => { await result.current.ensure(['a']); });
    await waitFor(() => expect(result.current.pricesFor('a')).toEqual([]));
  });

  test('an unfetched medicine reads as undefined, not as empty', async () => {
    const { result } = renderHook(() => useVendorPrices());
    expect(result.current.pricesFor('never-asked')).toBeUndefined();
  });
});
