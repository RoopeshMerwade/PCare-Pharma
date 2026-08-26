import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { daysUntil, qty as formatQty } from '../../lib/format';
import FormDialog from '../../patterns/FormDialog';
import Field from '../../ui/Field';
import Input, { NumericInput } from '../../ui/Input';
import ErrorState from '../../ui/ErrorState';
import { SkeletonRows } from '../../ui/Skeleton';
import { Money } from '../../domain/Money';

/* ═══════════════════════════════════════════════════════════════════════════
   ReceivePurchaseModal — the goods-inwards screen.

   Everything typed here becomes an inventory_batch and its opening ledger
   entry, in one transaction, via receive_purchase_atomic. Three constraints
   come from that RPC rather than from the UI, and the form enforces them
   BEFORE submitting, because the alternative is a rolled-back receipt and a
   Postgres error string in front of a person holding a delivery:

     · Only a `sent` order can be received. The RPC raises INVALID_STATUS
       otherwise, and there is no partial-receipt path — one receipt closes
       the order.
     · selling_price must be ≤ mrp. Enforced twice server-side (the RPC's
       PRICE_EXCEEDS_MRP guard and a CHECK on inventory_batches), so a form
       that lets it through is a form that always fails on submit.
     · batch_no is stored upper(trim(...)). Uppercased on the way in so the
       list afterwards matches what was typed.

   unit_cost is deliberately NOT an input. It is fixed by the order that was
   raised, and the RPC reads it from purchase_items — letting the counter edit
   the agreed cost while unpacking the carton would silently rewrite the
   order's value and every margin computed from it.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Local-time YYYY-MM-DD. toISOString() is UTC and rolls the date backwards
 *  before 05:30 IST, which would let a batch expiring today slip through. */
function isoToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLine(item) {
  const medicine = item.medicines || {};
  return {
    purchase_item_id: item.id,
    name: medicine.name || 'Unknown medicine',
    unit: medicine.unit || 'units',
    qty_ordered: item.qty_ordered,
    unit_cost: item.unit_cost,
    // Defaults chosen so the common case — full delivery at the standard
    // price — is a batch number and an expiry date, nothing more.
    qty_received: String(item.qty_ordered ?? ''),
    batch_no: '',
    exp_date: '',
    mfg_date: '',
    mrp: '',
    selling_price: medicine.default_selling_price != null ? String(medicine.default_selling_price) : '',
  };
}

export function validateLine(line) {
  const found = {};

  const received = parseInt(line.qty_received, 10);
  if (!received || received < 1) found.qty_received = 'Enter how many actually arrived — at least 1.';

  if (!line.batch_no.trim()) found.batch_no = 'Batch number is printed on the strip or carton.';

  if (!line.exp_date) {
    found.exp_date = 'Expiry date is required — FEFO billing sells the nearest expiry first.';
  } else if ((daysUntil(line.exp_date) ?? 0) <= 0) {
    found.exp_date = 'This batch has already expired. Do not take it into stock — return it to the supplier.';
  }

  if (line.mfg_date && line.exp_date && line.mfg_date >= line.exp_date) {
    found.mfg_date = 'Manufacture date must fall before the expiry date.';
  }

  const mrp = parseFloat(line.mrp);
  if (!(mrp >= 0.01)) found.mrp = 'Enter the MRP printed on the pack.';

  const selling = parseFloat(line.selling_price);
  if (!(selling >= 0.01)) {
    found.selling_price = 'Enter the price this batch will sell at.';
  } else if (mrp >= 0.01 && selling > mrp) {
    // The RPC rejects this outright, so catching it here is the difference
    // between an inline message and a failed transaction.
    found.selling_price = 'Selling price cannot be above the MRP.';
  }

  return found;
}

function ReceiveLineCard({ line, index, errors, onChange, minDate }) {
  const received = parseInt(line.qty_received, 10) || 0;
  const short = received > 0 && received < line.qty_ordered;

  return (
    <fieldset className="rounded-card border border-border p-s3">
      <legend className="flex flex-wrap items-baseline gap-s2 px-s1">
        <span className="text-base font-bold text-foreground">{line.name}</span>
        <span className="text-base text-muted-foreground">
          Ordered {formatQty(line.qty_ordered, line.unit)}
        </span>
      </legend>

      <div className="grid gap-s3 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Received quantity"
          required
          hint={line.unit}
          error={errors.qty_received}
        >
          <NumericInput
            integer
            value={line.qty_received}
            onChange={(v) => onChange(index, 'qty_received', v)}
          />
        </Field>

        <Field label="Batch number" required error={errors.batch_no}>
          <Input
            value={line.batch_no}
            onChange={(e) => onChange(index, 'batch_no', e.target.value)}
            // Stored uppercase by the RPC; matching here keeps the batch the
            // user sees on the inventory page identical to the one they typed.
            onBlur={(e) => onChange(index, 'batch_no', e.target.value.trim().toUpperCase())}
            placeholder="BATCH-2026-A"
            autoComplete="off"
            className="font-mono"
          />
        </Field>

        <Field label="Expiry date" required error={errors.exp_date}>
          <Input
            type="date"
            value={line.exp_date}
            min={minDate}
            onChange={(e) => onChange(index, 'exp_date', e.target.value)}
          />
        </Field>

        <Field label="Manufacture date" hint="(optional)" error={errors.mfg_date}>
          <Input
            type="date"
            value={line.mfg_date}
            max={line.exp_date || undefined}
            onChange={(e) => onChange(index, 'mfg_date', e.target.value)}
          />
        </Field>

        <Field label="MRP" required hint="per unit" error={errors.mrp}>
          <NumericInput
            value={line.mrp}
            onChange={(v) => onChange(index, 'mrp', v)}
            placeholder="0.00"
          />
        </Field>

        <Field label="Selling price" required hint="per unit" error={errors.selling_price}>
          <NumericInput
            value={line.selling_price}
            onChange={(v) => onChange(index, 'selling_price', v)}
            placeholder="0.00"
          />
        </Field>
      </div>

      <div className="mt-s3 flex flex-wrap items-baseline justify-between gap-s2 border-t border-border pt-s2">
        <span className="text-base text-muted-foreground">
          Cost <Money value={line.unit_cost} className="text-base" /> per {line.unit.replace(/s$/, '')}
        </span>
        <span className="flex items-baseline gap-s2">
          {short && (
            // Not an error: short deliveries are normal. But the order closes
            // on this receipt, so it needs to be visible before submitting.
            <span className="text-base text-warning">
              {formatQty(line.qty_ordered - received, line.unit)} short of the order
            </span>
          )}
          <span className="text-base text-muted-foreground">Line value</span>
          <Money value={received * (parseFloat(line.unit_cost) || 0)} />
        </span>
      </div>
    </fieldset>
  );
}

export default function ReceivePurchaseModal({ purchase, open, onOpenChange, onReceived }) {
  const [lines, setLines] = useState([]);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [errors, setErrors] = useState([]);
  const minDate = isoToday();

  useEffect(() => {
    if (!open || !purchase) return undefined;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setErrors([]);
    setLines([]);
    setInvoiceNo('');

    api.get(`/purchases/${purchase.id}`)
      .then((res) => {
        if (cancelled) return;
        setLines((res.data.purchase.items || []).map(toLine));
      })
      .catch((err) => { if (!cancelled) setLoadError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, purchase]);

  const updateLine = (index, key, value) => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
    // Clear this field's message as soon as it is being corrected — leaving a
    // stale error under a field the user has just fixed reads as unfixable.
    setErrors((current) =>
      current.map((lineErrors, i) => (i === index ? { ...lineErrors, [key]: undefined } : lineErrors))
    );
  };

  const receivedValue = lines.reduce(
    (sum, l) => sum + (parseInt(l.qty_received, 10) || 0) * (parseFloat(l.unit_cost) || 0),
    0
  );

  const handleSubmit = async () => {
    const found = lines.map(validateLine);
    setErrors(found);
    if (found.some((lineErrors) => Object.keys(lineErrors).length > 0)) {
      throw new Error('Check the highlighted lines — every batch needs a number, a future expiry date and its prices.');
    }

    await api.post(`/purchases/${purchase.id}/receive`, {
      invoice_no: invoiceNo.trim() || null,
      items: lines.map((l) => ({
        purchase_item_id: l.purchase_item_id,
        batch_no: l.batch_no.trim().toUpperCase(),
        qty_received: parseInt(l.qty_received, 10),
        exp_date: l.exp_date,
        mfg_date: l.mfg_date || null,
        mrp: parseFloat(l.mrp),
        selling_price: parseFloat(l.selling_price),
      })),
    });

    onReceived();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={`Receive ${purchase?.purchase_number ?? 'order'}`}
      description={
        purchase
          ? `Goods from ${purchase.supplier_name}. Each line becomes a stock batch, so the batch number, expiry and prices must match the pack.`
          : undefined
      }
      submitLabel="Receive and add to stock"
      onSubmit={handleSubmit}
      submitBlockedReason={
        loading ? 'Still loading the order lines.'
          : loadError ? 'The order lines could not be loaded.'
          : lines.length === 0 ? 'This order has no lines to receive.'
          : null
      }
    >
      {loading && <SkeletonRows count={2} />}

      {loadError && (
        <ErrorState
          title="Couldn't load the order lines"
          message={loadError.message}
        />
      )}

      {!loading && !loadError && (
        <Field label="Distributor invoice / challan number" hint="(optional)">
          <Input
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            placeholder="e.g. INV-84920"
            className="font-mono"
          />
        </Field>
      )}

      {!loading && !loadError && lines.map((line, index) => (
        <ReceiveLineCard
          key={line.purchase_item_id}
          line={line}
          index={index}
          errors={errors[index] || {}}
          onChange={updateLine}
          minDate={minDate}
        />
      ))}

      {!loading && !loadError && lines.length > 0 && (
        <div className="flex items-baseline justify-between gap-s3 border-t border-border pt-s3">
          <span className="text-sm font-bold text-foreground">Value being received</span>
          <Money value={receivedValue} className="text-md" />
        </div>
      )}
    </FormDialog>
  );
}
