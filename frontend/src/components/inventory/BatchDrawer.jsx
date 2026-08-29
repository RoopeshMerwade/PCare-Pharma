import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { date, daysUntil, plural } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import FormDialog from '../../patterns/FormDialog';
import { Drawer, DrawerContent, DrawerHeader, DrawerBody } from '../../ui/Drawer';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input, { NumericInput, Textarea } from '../../ui/Input';
import Select from '../../ui/Select';
import EmptyState from '../../ui/EmptyState';
import ErrorState from '../../ui/ErrorState';
import Skeleton, { SkeletonRegion } from '../../ui/Skeleton';
import { Money, Qty } from '../../domain/Money';
import { contentNoun, perUnitPrice } from '../../domain/pack';
import { ExpiryBadge, StockBadge } from '../../domain/StatusBadge';
import { PlusIcon } from '../../ui/icons';

/* Batch detail for one medicine. Built on the shared Drawer, so it inherits
   the focus trap, Escape handling and scroll lock the previous hand-rolled
   panel did not have — it stacked three separate `fixed inset-0` layers.

   Cost price is owner-only (A9). Staff see quantity, expiry and selling
   price; unit cost and margin are simply not rendered for them. */

export default function BatchDrawer({ medicine, open, onOpenChange, onChanged }) {
  const { isOwner } = useAuth();
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(null);
  const [writingOff, setWritingOff] = useState(null);

  const fetchBatches = useCallback(async () => {
    if (!medicine) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/inventory/${medicine.id}/batches?includeExpired=true`);
      setBatches(res.data.batches);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [medicine]);

  useEffect(() => { if (open) fetchBatches(); }, [open, fetchBatches]);

  if (!medicine) return null;

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader
            title={medicine.name}
            description={[medicine.manufacturer, medicine.unit].filter(Boolean).join(' · ')}
          />

          <div className="flex items-center justify-between gap-s3 border-b border-border bg-muted px-s4 py-s3">
            <span className="text-base text-muted-foreground">Total stock</span>
            <div className="flex items-center gap-s2">
              <Qty value={medicine.total_stock} unit={medicine.unit} />
              {/* total_stock counts sealed packs only — it feeds the reorder
                  threshold and StockBadge, and folding part-packs in would
                  change what "low stock" means. Loose units are additional,
                  and are stated as such. */}
              {Number(medicine.total_loose_stock) > 0 && (
                <span className="text-base text-warning-ink">
                  + {plural(Number(medicine.total_loose_stock), contentNoun(medicine.pack_content_unit))} loose
                </span>
              )}
              <StockBadge medicine={medicine} />
            </div>
          </div>

          {isOwner && (
            <div className="border-b border-border px-s4 py-s2">
              <Button variant="primary" size="compact" onClick={() => setAddOpen(true)}>
                <PlusIcon className="h-4 w-4" />
                Add batch
              </Button>
            </div>
          )}

          <DrawerBody>
            {error ? (
              <ErrorState title="Couldn't load batches" message={error.message} onRetry={fetchBatches} />
            ) : loading ? (
              // A batch card is taller than a list row: identity and expiry on
              // the left, the count and its badge on the right, prices along
              // the foot. The list is scrolled and acted on immediately, so it
              // is worth standing in at the right height.
              <SkeletonRegion label="Loading batches…">
                <ul className="flex flex-col gap-s3">
                  {[0, 1, 2].map((n) => (
                    <li key={n} className="rounded-card border border-border bg-card p-s3">
                      <div className="flex items-start justify-between gap-s3">
                        <div className="flex min-w-0 flex-col gap-s1">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-4 w-40" />
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-s1">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-5 w-24 rounded-pill" />
                        </div>
                      </div>
                      <div className="mt-s3 border-t border-border pt-s2">
                        <Skeleton className="h-4 w-48" />
                      </div>
                    </li>
                  ))}
                </ul>
              </SkeletonRegion>
            ) : batches.length === 0 ? (
              <EmptyState
                title="No batches on record"
                body={
                  isOwner
                    ? 'Stock appears here once a purchase order is received, or when you add an opening batch manually.'
                    : 'Stock appears here once the owner receives a purchase order for this medicine.'
                }
              />
            ) : (
              <ul className="flex flex-col gap-s3">
                {batches.map((batch) => (
                  <BatchCard
                    key={batch.id}
                    batch={batch}
                    isOwner={isOwner}
                    onAdjust={() => setAdjusting(batch)}
                    onWriteOff={() => setWritingOff(batch)}
                  />
                ))}
              </ul>
            )}
          </DrawerBody>
        </DrawerContent>
      </Drawer>

      <AddBatchModal
        medicine={medicine}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => { fetchBatches(); onChanged?.('Batch added and stock updated.'); }}
      />

      <StockAdjustModal
        batch={adjusting}
        open={Boolean(adjusting)}
        onOpenChange={(next) => { if (!next) setAdjusting(null); }}
        onAdjusted={() => { setAdjusting(null); fetchBatches(); onChanged?.('Stock adjusted.'); }}
      />

      <WriteOffModal
        batch={writingOff}
        open={Boolean(writingOff)}
        onOpenChange={(next) => { if (!next) setWritingOff(null); }}
        onDone={() => { setWritingOff(null); fetchBatches(); onChanged?.('Batch written off.'); }}
      />
    </>
  );
}

function BatchCard({ batch, isOwner, onAdjust, onWriteOff }) {
  const days = daysUntil(batch.exp_date);
  const isExpired = days !== null && days < 0;
  const looseQty = Number(batch.loose_qty) || 0;
  // An opened pack is stock. Without counting it here a batch showing "0
  // strips" would read as empty while eight tablets sit on the shelf against
  // this expiry date — and the write-off button, which is gated on having
  // something to write off, would never appear for them.
  const hasStock = batch.stock_qty > 0 || looseQty > 0;

  return (
    <li
      className={cn(
        'rounded-card border bg-card p-s3',
        isExpired ? 'border-destructive/40' : 'border-border'
      )}
    >
      <div className="flex items-start justify-between gap-s3">
        <div className="min-w-0">
          <p className="font-mono text-base font-bold text-foreground">{batch.batch_no}</p>
          <p className="mt-s1 text-base text-muted-foreground">
            Expires {date(batch.exp_date)}
            {days !== null && (isExpired ? ` · ${plural(Math.abs(days), 'day')} ago` : ` · in ${plural(days, 'day')}`)}
          </p>
          {batch.mfg_date && <p className="text-base text-muted-foreground">Made {date(batch.mfg_date)}</p>}
        </div>
        <div className="shrink-0 text-right">
          <Qty value={batch.stock_qty} unit={batch.medicine_unit} tone={hasStock ? undefined : 'critical'} />
          {/* Shown as a second figure, never folded into the first: 9 strips
              and 8 tablets is not "9.8 strips" and not "98 tablets". They are
              physically different things and the shelf count has to say so. */}
          {looseQty > 0 && (
            <p className="mt-s1 text-base text-warning-ink">
              + {plural(looseQty, contentNoun(batch.effective_content_unit))} loose
            </p>
          )}
          <div className="mt-s1"><ExpiryBadge daysToExpiry={days} /></div>
        </div>
      </div>

      <dl className="mt-s3 flex flex-wrap gap-x-s4 gap-y-s1 border-t border-border pt-s2">
        {/* A9: unit cost is owner-only and is absent from the DOM for staff,
            not hidden with a class. */}
        {isOwner && (
          <div className="flex items-baseline gap-s1">
            <dt className="text-base text-muted-foreground">Cost</dt>
            <dd><Money value={batch.unit_cost} /></dd>
          </div>
        )}
        <div className="flex items-baseline gap-s1">
          <dt className="text-base text-muted-foreground">MRP</dt>
          <dd><Money value={batch.mrp} /></dd>
        </div>
        <div className="flex items-baseline gap-s1">
          <dt className="text-base text-muted-foreground">Sells at</dt>
          <dd><Money value={batch.selling_price} /></dd>
        </div>
        {/* Only where the pack is splittable — on a 100ML bottle a "per unit"
            price would be a price per millilitre, which nobody sells. */}
        {batch.loose_sale_supported && (
          <div className="flex items-baseline gap-s1">
            <dt className="text-base text-muted-foreground">
              Per {contentNoun(batch.effective_content_unit)}
            </dt>
            <dd><Money value={perUnitPrice(batch.selling_price, batch.effective_content_quantity)} /></dd>
          </div>
        )}
      </dl>

      {isOwner && (
        <div className="mt-s3 flex flex-wrap gap-s2">
          <Button variant="secondary" size="compact" onClick={onAdjust}>Adjust stock</Button>
          {isExpired && hasStock && (
            <Button variant="destructive" size="compact" onClick={onWriteOff}>Write off</Button>
          )}
        </div>
      )}
    </li>
  );
}

export function StockAdjustModal({ batch, open, onOpenChange, onAdjusted }) {
  const [qty, setQty] = useState('');
  const [direction, setDirection] = useState('add');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) { setQty(''); setDirection('add'); setNote(''); setErrors({}); }
  }, [open]);

  if (!batch) return null;

  const parsed = parseInt(qty, 10);
  const signed = direction === 'remove' ? -Math.abs(parsed) : Math.abs(parsed);
  const resulting = (batch.stock_qty ?? 0) + (Number.isFinite(signed) ? signed : 0);

  const validate = () => {
    const found = {};
    if (!Number.isFinite(parsed) || parsed === 0) {
      found.qty = 'Enter how many units to add or remove.';
    } else if (resulting < 0) {
      // Never silently clamp — say exactly what is available (§3.5).
      found.qty = `Only ${batch.stock_qty} ${batch.medicine_unit} are in this batch. Remove ${batch.stock_qty} or fewer.`;
    }
    if (note.trim().length < 5) {
      found.note = 'Explain the reason in at least 5 characters — this goes on the permanent ledger.';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    await api.post('/inventory/adjust', { batch_id: batch.id, adjustment_qty: signed, note });
    onAdjusted();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust stock"
      description={`${batch.medicine_name} · batch ${batch.batch_no} · ${batch.stock_qty} ${batch.medicine_unit} on hand`}
      submitLabel="Save adjustment"
      onSubmit={handleSubmit}
    >
      <Field label="Direction">
        <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="add">Add stock — found more than recorded</option>
          <option value="remove">Remove stock — damaged, lost or miscounted</option>
        </Select>
      </Field>

      <Field
        label="Quantity"
        required
        error={errors.qty}
        hint={batch.medicine_unit}
      >
        <NumericInput integer value={qty} onChange={(v) => { setQty(v); setErrors((e) => ({ ...e, qty: '' })); }} placeholder="0" />
      </Field>

      {Number.isFinite(parsed) && parsed !== 0 && resulting >= 0 && (
        <p className="text-base text-muted-foreground">
          After this adjustment the batch will hold <strong className="text-foreground">{resulting} {batch.medicine_unit}</strong>.
        </p>
      )}

      <Field label="Reason" required error={errors.note}>
        <Textarea
          value={note}
          onChange={(e) => { setNote(e.target.value); setErrors((er) => ({ ...er, note: '' })); }}
          rows={3}
          placeholder="e.g. Physical count found 2 extra strips"
        />
      </Field>
    </FormDialog>
  );
}

function WriteOffModal({ batch, open, onOpenChange, onDone }) {
  if (!batch) return null;

  const handleSubmit = async () => {
    await api.patch(`/inventory/batch/${batch.id}/writeoff`);
    onDone();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Write off batch ${batch.batch_no}?`}
      submitLabel="Write off batch"
      onSubmit={handleSubmit}
    >
      <p className="text-base text-muted-foreground">
        This removes all {batch.stock_qty} {batch.medicine_unit} remaining in batch {batch.batch_no} of{' '}
        {batch.medicine_name} from sellable stock, and records the loss against this batch.
      </p>
      <p className="text-base text-muted-foreground">
        The ledger is append-only, so the write-off is recorded as a new entry rather than erasing history — but the
        stock cannot be restored except by a fresh adjustment.
      </p>
    </FormDialog>
  );
}

function AddBatchModal({ medicine, open, onOpenChange, onAdded }) {
  const [form, setForm] = useState({
    batch_no: '', exp_date: '', mfg_date: '',
    unit_cost: '', mrp: '', selling_price: '',
    opening_qty: '', reason: 'purchase_receipt', supplier_id: '',
  });
  const [errors, setErrors] = useState({});
  const [suppliers, setSuppliers] = useState([]);

  useEffect(() => {
    if (open) {
      const price = String(medicine.default_selling_price || '');
      setForm({
        batch_no: '', exp_date: '', mfg_date: '',
        unit_cost: '', mrp: price, selling_price: price,
        opening_qty: '', reason: 'purchase_receipt', supplier_id: '',
      });
      setErrors({});
    }
  }, [open, medicine]);

  /* The distributor list, for the optional "Bought from" field below.
     Fetched here rather than passed in because BatchDrawer is opened from three
     screens and none of them already holds it. A failure is silent and leaves
     the field empty: not knowing the distributor must never stop a batch being
     taken into stock. */
  useEffect(() => {
    if (!open || suppliers.length > 0) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/suppliers');
        if (!cancelled) setSuppliers(res.data.suppliers || []);
      } catch {
        if (!cancelled) setSuppliers([]);
      }
    })();
    return () => { cancelled = true; };
  }, [open, suppliers.length]);

  const set = (key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const found = {};
    if (!form.batch_no.trim()) found.batch_no = 'Enter the batch number printed on the pack.';
    if (!form.exp_date) found.exp_date = 'Enter the expiry date from the pack.';
    else if (daysUntil(form.exp_date) < 0) found.exp_date = 'That date has already passed. Check the pack again.';

    const cost = parseFloat(form.unit_cost);
    const mrp = parseFloat(form.mrp);
    const sell = parseFloat(form.selling_price);
    if (!Number.isFinite(cost) || cost < 0) found.unit_cost = 'Enter what you paid per unit, or 0 for free stock.';
    if (!Number.isFinite(mrp) || mrp <= 0) found.mrp = 'Enter the MRP printed on the pack.';
    if (!Number.isFinite(sell) || sell <= 0) found.selling_price = 'Enter the price you will sell at.';
    else if (Number.isFinite(mrp) && sell > mrp) {
      found.selling_price = `Selling above MRP isn't allowed. The MRP on this batch is ₹${mrp.toFixed(2)}.`;
    }

    const qty = parseInt(form.opening_qty, 10);
    if (!Number.isFinite(qty) || qty < 0) found.opening_qty = 'Enter how many units arrived.';

    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    await api.post('/inventory/batches', {
      ...form,
      medicine_id: medicine.id,
      mfg_date: form.mfg_date || null,
      unit_cost: parseFloat(form.unit_cost),
      mrp: parseFloat(form.mrp),
      selling_price: parseFloat(form.selling_price),
      opening_qty: parseInt(form.opening_qty, 10),
      // '' would fail isUUID; null is what "not recorded" means in the column.
      supplier_id: form.supplier_id || null,
    });
    onAdded();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Add batch — ${medicine.name}`}
      submitLabel="Add batch"
      onSubmit={handleSubmit}
    >
      <Field label="Batch number" required error={errors.batch_no}>
        <Input
          value={form.batch_no}
          onChange={(e) => set('batch_no')(e.target.value.toUpperCase())}
          placeholder="e.g. MF2245A"
          className="font-mono"
        />
      </Field>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Expiry date" required error={errors.exp_date}>
          <Input type="date" value={form.exp_date} onChange={set('exp_date')} />
        </Field>
        <Field label="Manufactured" hint="(optional)">
          <Input type="date" value={form.mfg_date} onChange={set('mfg_date')} />
        </Field>
      </div>

      <div className="grid gap-s4 sm:grid-cols-3">
        <Field label="Unit cost" required hint="₹" error={errors.unit_cost}>
          <NumericInput value={form.unit_cost} onChange={set('unit_cost')} placeholder="0.00" />
        </Field>
        <Field label="MRP" required hint="₹" error={errors.mrp}>
          <NumericInput value={form.mrp} onChange={set('mrp')} placeholder="0.00" />
        </Field>
        <Field label="Sells at" required hint="₹" error={errors.selling_price}>
          <NumericInput value={form.selling_price} onChange={set('selling_price')} placeholder="0.00" />
        </Field>
      </div>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Quantity received" required hint={medicine.unit} error={errors.opening_qty}>
          <NumericInput integer value={form.opening_qty} onChange={set('opening_qty')} placeholder="0" />
        </Field>
        <Field label="Reason">
          <Select value={form.reason} onChange={set('reason')}>
            <option value="purchase_receipt">Purchase receipt</option>
            <option value="opening_stock">Opening stock</option>
          </Select>
        </Field>
      </div>

      {/* Optional, and never blocks the batch — but it is what teaches the
          system what this distributor charges. Module 30's vendor comparison
          reads exactly this, so a batch entered without it is a rate the
          counter will not see next time they need to reorder. */}
      <Field
        label="Bought from"
        hint="(optional)"
        error={errors.supplier_id}
      >
        <Select
          value={form.supplier_id}
          onChange={set('supplier_id')}
          placeholder="Not recorded"
        >
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
    </FormDialog>
  );
}
