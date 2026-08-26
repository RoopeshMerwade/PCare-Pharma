import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

/* ═══════════════════════════════════════════════════════════════════════════
   useInvoiceReview — the review screen's state, and its one hard rule.

   THE RULE: a server response updates DERIVED data and the fields it was just
   given. It never overwrites a field the reviewer is currently editing.

   Why that needs stating: every save returns the whole invoice with freshly
   recomputed warnings, because warnings are derived and must never go stale.
   But a reviewer working down a 30-line invoice types in one field while the
   previous field's PATCH is still in flight. Merging the whole response back
   would blank whatever they had typed in the meantime — the classic
   "the form keeps eating my input" bug, and an especially bad one here because
   the eaten value is a batch number nobody notices is wrong until a recall.

   So `mergeResponse` takes the set of fields that were sent and applies only
   those, plus everything the server owns outright (warnings, match provenance,
   the joined medicine, status, counts).

   Saves are also serialised per line, keyed by line id. Two PATCHes to the same
   line can't overtake each other, and PATCHes to different lines still overlap
   freely — which is what keeps a 30-line invoice from feeling like dial-up.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Fields the server owns and always wins on. */
const SERVER_OWNED_INVOICE = [
  'status', 'validation_warnings', 'can_import', 'purchase_id', 'purchase_number',
  'supplier_name', 'approved_by_name', 'approved_at', 'rejected_reason',
  'unmapped_count', 'item_error_count', 'blocking_error_count', 'line_count',
];

const SERVER_OWNED_ITEM = ['warnings', 'match_source', 'match_confidence', 'match_candidates', 'medicines'];

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

export default function useInvoiceReview(invoiceId) {
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingCount, setSavingCount] = useState(0);
  const [saveError, setSaveError] = useState(null);

  // One promise chain per line id (plus one for the header under the '' key),
  // so writes to the same row serialise without blocking other rows.
  const chains = useRef(new Map());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (!invoiceId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.get(`/supplier-invoices/${invoiceId}`)
      .then((res) => { if (!cancelled) setInvoice(res.data.invoice); })
      .catch((err) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [invoiceId]);

  /** Applies a server response without clobbering in-flight edits. */
  const mergeResponse = useCallback((fresh, { invoiceFields = [], itemFields = new Map() } = {}) => {
    setInvoice((current) => {
      if (!current) return fresh;

      const freshItemsById = new Map((fresh.items || []).map((i) => [i.id, i]));

      const items = (current.items || []).map((item) => {
        const incoming = freshItemsById.get(item.id);
        if (!incoming) return item;
        return {
          ...item,
          ...pick(incoming, SERVER_OWNED_ITEM),
          // Only the fields this save actually sent for this line.
          ...pick(incoming, itemFields.get(item.id) || []),
        };
      });

      // A line the server knows about and the client does not (a concurrent
      // change from another session) is appended rather than dropped.
      const extra = (fresh.items || []).filter((i) => !items.some((mine) => mine.id === i.id));

      return {
        ...current,
        ...pick(fresh, SERVER_OWNED_INVOICE),
        ...pick(fresh, invoiceFields),
        items: [...items, ...extra].sort((a, b) => a.line_no - b.line_no),
      };
    });
  }, []);

  /** Queues a write on `key`'s chain, tracking the in-flight count for the UI. */
  const enqueue = useCallback((key, work) => {
    const previous = chains.current.get(key) || Promise.resolve();
    setSavingCount((n) => n + 1);

    const next = previous
      .catch(() => {}) // a failed save must not wedge the queue for that row
      .then(work)
      .catch((err) => {
        if (alive.current) setSaveError(err);
        throw err;
      })
      .finally(() => { if (alive.current) setSavingCount((n) => Math.max(n - 1, 0)); });

    chains.current.set(key, next.catch(() => {}));
    return next;
  }, []);

  /** Local-only edit. Called on every keystroke; never hits the network. */
  const editItem = useCallback((itemId, changes) => {
    setInvoice((current) => current && ({
      ...current,
      items: current.items.map((i) => (i.id === itemId ? { ...i, ...changes } : i)),
    }));
  }, []);

  const editHeader = useCallback((changes) => {
    setInvoice((current) => current && ({ ...current, ...changes }));
  }, []);

  /** Persists a line. `changes` is the subset that actually changed. */
  const saveItem = useCallback((itemId, changes) => {
    const fields = Object.keys(changes);
    if (!fields.length) return Promise.resolve();
    setSaveError(null);
    return enqueue(itemId, async () => {
      const res = await api.patch(`/supplier-invoices/${invoiceId}/items/${itemId}`, changes);
      if (alive.current) mergeResponse(res.data.invoice, { itemFields: new Map([[itemId, fields]]) });
    });
  }, [enqueue, invoiceId, mergeResponse]);

  const saveHeader = useCallback((changes) => {
    const fields = Object.keys(changes);
    if (!fields.length) return Promise.resolve();
    setSaveError(null);
    return enqueue('', async () => {
      const res = await api.patch(`/supplier-invoices/${invoiceId}`, changes);
      if (alive.current) mergeResponse(res.data.invoice, { invoiceFields: fields });
    });
  }, [enqueue, invoiceId, mergeResponse]);

  /**
   * Replaces the whole local invoice with the server's. Used after actions that
   * change everything at once — approve, reject, quick-add — where there is no
   * in-flight edit worth protecting because the screen is about to change mode.
   */
  const replace = useCallback((fresh) => { if (alive.current) setInvoice(fresh); }, []);

  const reload = useCallback(async () => {
    const res = await api.get(`/supplier-invoices/${invoiceId}`);
    replace(res.data.invoice);
  }, [invoiceId, replace]);

  return {
    invoice, loading, error,
    saving: savingCount > 0,
    saveError, clearSaveError: () => setSaveError(null),
    editItem, editHeader, saveItem, saveHeader, replace, reload,
  };
}
