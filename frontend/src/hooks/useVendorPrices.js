import { useCallback, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * Vendor rates for however many lines the requisition dialog holds, in as few
 * requests as possible.
 *
 * NO WATERFALL. `ensure(ids)` diffs against what is already cached and issues
 * ONE batched request for whatever is missing. Adding a medicine by hand costs
 * one request for one id (user-paced, not a cascade); tipping in twelve
 * low-stock medicines at once costs one request for all twelve; reopening the
 * dialog costs none.
 *
 * `undefined` from `pricesFor` means "not fetched yet" and `[]` means "no
 * distributors at all". The API returns an explicit entry for every id asked
 * for precisely so the dialog can tell those apart — one shows a spinner, the
 * other shows a sentence.
 *
 * The cache lives in this hook's component, not at module scope. It should
 * outlive a dialog open/close, and it should NOT outlive a page visit: a price
 * that changed while the user was away is one that should be re-read.
 *
 * The API caps a batch at 50 ids, which is also the cap on lines in a request,
 * so a legitimate dialog can never exceed it. Chunking anyway costs four lines
 * and means a future "price the whole low-stock list" cannot trip a 422.
 */
const BATCH_LIMIT = 50;

export default function useVendorPrices() {
  // A ref, not state: writing to it must not re-render, and every read below
  // needs the value as of *now* rather than as of the last render — two
  // ensure() calls in one tick would otherwise both see an empty cache and
  // both fetch.
  const cache = useRef(new Map());
  const inFlight = useRef(new Set());
  const [, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);

  const pricesFor = useCallback((medicineId) => cache.current.get(medicineId), []);

  const ensure = useCallback(async (medicineIds) => {
    const wanted = [...new Set(medicineIds)].filter(
      (id) => id && !cache.current.has(id) && !inFlight.current.has(id)
    );
    if (wanted.length === 0) return;

    wanted.forEach((id) => inFlight.current.add(id));
    setLoading(true);

    const chunks = [];
    for (let i = 0; i < wanted.length; i += BATCH_LIMIT) {
      chunks.push(wanted.slice(i, i + BATCH_LIMIT));
    }

    try {
      const responses = await Promise.all(chunks.map((chunk) =>
        api.get(`/stock-requisitions/vendor-prices?medicine_ids=${chunk.join(',')}`)
      ));

      responses.forEach((res) => {
        Object.entries(res.data.vendors || {}).forEach(([id, vendors]) => {
          cache.current.set(id, vendors);
        });
      });
    } catch {
      // A failed price lookup must not block the request. The lines stay
      // usable, the vendor control shows "couldn't load", and submitting sends
      // supplier_id: null — which is a legitimate line, not a broken one.
      wanted.forEach((id) => { if (!cache.current.has(id)) cache.current.set(id, []); });
    } finally {
      wanted.forEach((id) => inFlight.current.delete(id));
      setLoading(false);
      setVersion((v) => v + 1);
    }
  }, []);

  return { pricesFor, ensure, loading };
}
