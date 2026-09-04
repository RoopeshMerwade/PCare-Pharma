import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { money, plural } from '../../lib/format';
import { MedicineSearchInput } from '../../hooks/useMedicineSearch';
import PageHeader from '../../patterns/PageHeader';
import Button from '../../ui/Button';
import Card, { CardBody, CardHeader, CardTitle } from '../../ui/Card';
import Field from '../../ui/Field';
import Input, { NumericInput, Textarea } from '../../ui/Input';
import Badge from '../../ui/Badge';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogClose } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { Money, Qty } from '../../domain/Money';
import { stockStatus } from '../../domain/stock';
import {
  supportsLooseSale, packContents, packLabel, availabilityLabel,
  looseAvailable, lineTotals, wholePackHint, contentNoun, sealedNoun, dispensedLabel,
} from '../../domain/pack';
import { PillIcon } from '../../ui/icons';

/* ═══════════════════════════════════════════════════════════════════════════
   New bill — the POS screen, and the highest-consequence surface in the app.

   Three rules from the guidelines land here specifically:

   · The submit button is NEVER silently disabled. §6 calls a greyed-out
     primary with no explanation a dead end; instead it stays live and names
     what is blocking it at the point of failure.

   · Quantities never silently clamp (§3.5). Typing 40 when 12 are in stock
     leaves 40 on screen with "Only 12 strips in stock" beside it, because
     quietly changing it to 12 is how a sale gets rung up wrong.

   · The adherence warning is advisory, never a block. Module 21 returns
     409 ADHERENCE_ACK_REQUIRED and the sale proceeds on acknowledgement —
     a deliberate product decision, so the dialog is worded as a prompt to
     check in with the patient, not as a refusal.

   Module 27 adds a second quantity box to countable lines. It appears ONLY
   for a medicine whose pack contents are recorded and countable — a 100ML
   syrup and a 30GM tube get the single Quantity box they always had, because
   offering to sell one millilitre of anything is not a thing a pharmacy does.

   Submitting goes through a summary dialog first, for Owner and Staff alike.
   Bills are immutable once created — a mistake is not editable, it has to be
   unwound through a Customer Return (module 12) — so the one moment worth
   spending a tap on is the moment before that becomes true. The dialog is
   read-only on purpose: it restates the cart rather than offering a last
   chance to change it, because a field that edits here is a field whose
   validation lives in two places.
   ═══════════════════════════════════════════════════════════════════════════ */

const PAYMENT_MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'credit', label: 'Credit' },
];

/* Field puts `className` on the wrapper, which holds the error message as well
   as the label — so a `capitalize` class there would title-case "Only 5 Units
   Spare." Capitalising the label string itself keeps the error a sentence. */
const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* One place that turns a catalogue row into a cart line, so adding a medicine
   and swapping one out cannot drift apart on which fields they carry — the
   pack columns were exactly the kind of thing the second copy would forget. */
function cartLine(medicine, qty, looseQty) {
  return {
    medicine_id: medicine.id,
    name: medicine.name,
    generic_name: medicine.generic_name,
    unit: medicine.unit,
    qty,
    loose_qty: looseQty,
    unit_price: Number(medicine.default_selling_price) || 0,
    total_stock: Number(medicine.total_stock) || 0,
    total_loose_stock: Number(medicine.total_loose_stock) || 0,
    pack_content_quantity: medicine.pack_content_quantity,
    pack_content_unit: medicine.pack_content_unit,
    loose_sale_supported: medicine.loose_sale_supported,
    is_low_stock: medicine.is_low_stock,
    low_stock_threshold: medicine.low_stock_threshold,
  };
}

export default function BillingPage() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({
    customer_name: '', customer_phone: '', payment_mode: 'cash', discount_amount: '', notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [lastBill, setLastBill] = useState(null);
  const [adherenceWarnings, setAdherenceWarnings] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const addItem = (medicine) => {
    setItems((current) => {
      const existing = current.find((i) => i.medicine_id === medicine.id);
      if (existing) {
        return current.map((i) =>
          i.medicine_id === medicine.id ? { ...i, qty: String((parseInt(i.qty, 10) || 0) + 1) } : i
        );
      }
      return [...current, cartLine(medicine, '1', '')];
    });
  };

  const handleSwapItem = (index, newMedicine) => {
    setItems((current) =>
      current.map((item, i) => {
        if (i !== index) return item;
        /* Quantities carry over, but the loose count is dropped unless the
           substitute is also splittable — a swap from a strip to a syrup would
           otherwise leave "3 tablets" attached to a bottle, and the server
           would reject the whole sale at submit rather than here. */
        const keepLoose = supportsLooseSale(newMedicine) ? item.loose_qty : '';
        return cartLine(newMedicine, item.qty, keepLoose);
      })
    );
    toast.success(`Swapped to ${newMedicine.name}`);
  };

  const setQty = (index, value) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, qty: value } : item)));

  const setLooseQty = (index, value) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, loose_qty: value } : item)));

  const removeItem = (index) => setItems((current) => current.filter((_, i) => i !== index));

  const lineTotal = (item) => lineTotals(item).total;
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  const discount = parseFloat(form.discount_amount) || 0;
  const total = Math.max(0, subtotal - discount);

  /* Every reason the sale cannot go through, in the order a person would hit
     them. The first one is what the button reports. */
  const blockingReason = (() => {
    if (items.length === 0) return 'Add at least one medicine before completing the sale.';

    /* A line now needs a quantity in EITHER box. "0 strips and 3 tablets" is a
       complete instruction; "0 and 0" is the empty line this has always
       caught. */
    const emptyQty = items.find((i) => !parseInt(i.qty, 10) && !parseInt(i.loose_qty, 10));
    if (emptyQty) {
      const noun = supportsLooseSale(emptyQty)
        ? `${emptyQty.unit} or ${contentNoun(emptyQty.pack_content_unit, { plural: true })}`
        : emptyQty.unit;
      return `Enter how many ${noun} of ${emptyQty.name} you're dispensing.`;
    }

    const overStock = items.find((i) => (parseInt(i.qty, 10) || 0) > i.total_stock);
    if (overStock) {
      return `Only ${overStock.total_stock} ${overStock.unit} of ${overStock.name} are in stock — reduce the quantity or remove the item.`;
    }

    /* Sealed packs asked for on the same line are already spoken for, so what
       is left for the loose box is what the remaining packs would yield plus
       what is already open. Matches how the server resolves the two halves
       against one shared view of the batch. */
    const overLoose = items.find((i) => {
      const wanted = parseInt(i.loose_qty, 10) || 0;
      if (!wanted) return false;
      const committed = (parseInt(i.qty, 10) || 0) * packContents(i);
      return wanted > looseAvailable(i) - committed;
    });
    if (overLoose) {
      const noun = contentNoun(overLoose.pack_content_unit, { plural: true });
      const spare = looseAvailable(overLoose) - (parseInt(overLoose.qty, 10) || 0) * packContents(overLoose);
      return `Only ${Math.max(spare, 0)} ${noun} of ${overLoose.name} can be dispensed once the whole ${sealedNoun(overLoose.unit, { plural: true })} on this line are counted.`;
    }

    if (discount > subtotal) {
      return `The discount can't be more than the subtotal of ${money(subtotal)}.`;
    }
    return null;
  })();

  const buildPayload = (acknowledgedWarnings) => ({
    customer_name: form.customer_name.trim() || 'Walk-in Customer',
    customer_phone: form.customer_phone.trim() || null,
    payment_mode: form.payment_mode,
    discount_amount: discount,
    notes: form.notes.trim() || null,
    /* loose_qty is omitted entirely when it is zero, so a cart with no split
       lines sends the exact request body it sent before Module 27. */
    items: items.map((i) => {
      const looseQty = parseInt(i.loose_qty, 10) || 0;
      return {
        medicine_id: i.medicine_id,
        qty: parseInt(i.qty, 10) || 0,
        ...(looseQty > 0 ? { loose_qty: looseQty } : {}),
      };
    }),
    ...(acknowledgedWarnings ? { acknowledged_warnings: acknowledgedWarnings } : {}),
  });

  const submitBill = async (acknowledgedWarnings) => {
    setLoading(true);
    try {
      const res = await api.post('/billing', buildPayload(acknowledgedWarnings));
      setLastBill(res.data.bill);
      setItems([]);
      setForm({ customer_name: '', customer_phone: '', payment_mode: 'cash', discount_amount: '', notes: '' });
      setAdherenceWarnings(null);
      // §5: the confirmation echoes the button's own words.
      toast.success(`Sale completed — ${res.data.bill.bill_number}, ${money(res.data.bill.total)}`);
    } catch (err) {
      if (err.code === 'ADHERENCE_ACK_REQUIRED' && err.details?.warnings) {
        setAdherenceWarnings(err.details.warnings);
      } else {
        toast.error(err.message);
      }
    } finally {
      setLoading(false);
      /* Closed on every outcome, not just success. On the adherence branch the
         warnings are set in the catch above and both updates land in the same
         batch, so the summary gives way to the adherence prompt rather than
         stacking two modals; on a plain failure it clears so the toast naming
         the problem is not behind an overlay. */
      setConfirming(false);
    }
  };

  /* Submitting opens the summary; the summary submits. Everything that would
     block the sale has already been checked here, so the dialog never has to
     report a problem — it only has to show what is about to happen. */
  const handleSubmit = (event) => {
    event.preventDefault();
    if (blockingReason) return;
    setConfirming(true);
  };

  return (
    <div className="mx-auto w-full max-w-[48rem]">
      <PageHeader title="New bill" subtitle="Search the catalogue, set quantities, take payment" />

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-s4">
        <Card>
          <CardHeader><CardTitle>Customer</CardTitle></CardHeader>
          <CardBody className="grid gap-s4 pt-s3 sm:grid-cols-2">
            <Field label="Name" hint="(optional)">
              <Input
                value={form.customer_name}
                onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                placeholder="Walk-in Customer"
                autoComplete="off"
              />
            </Field>
            <Field label="Phone" hint="(optional — links their history)">
              <Input
                type="tel"
                inputMode="numeric"
                value={form.customer_phone}
                onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
                placeholder="98xxxxxxx0"
                autoComplete="off"
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Medicines</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-s4 pt-s3">
            <MedicineSearchInput onSelect={addItem} placeholder="Search and add a medicine…" />

            {items.length > 0 && (
              <ul className="flex flex-col gap-s3">
                {items.map((item, index) => (
                  <LineItem
                    key={item.medicine_id}
                    item={item}
                    index={index}
                    onQtyChange={setQty}
                    onLooseQtyChange={setLooseQty}
                    onRemove={() => removeItem(index)}
                    onSwap={(altMed) => handleSwapItem(index, altMed)}
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Payment</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-s4 pt-s3">
            <fieldset>
              <legend className="mb-s2 text-base font-bold text-foreground">Paid by</legend>
              <div className="flex flex-wrap gap-s2">
                {PAYMENT_MODES.map((mode) => (
                  <Button
                    key={mode.value}
                    type="button"
                    variant={form.payment_mode === mode.value ? 'primary' : 'secondary'}
                    aria-pressed={form.payment_mode === mode.value}
                    onClick={() => setForm((f) => ({ ...f, payment_mode: mode.value }))}
                  >
                    {mode.label}
                  </Button>
                ))}
              </div>
            </fieldset>

            <div className="sm:max-w-[14rem]">
              <Field
                label="Discount"
                hint="₹"
                error={discount > subtotal ? `The discount can't exceed the subtotal of ${money(subtotal)}.` : undefined}
              >
                <NumericInput
                  value={form.discount_amount}
                  onChange={(v) => setForm((f) => ({ ...f, discount_amount: v }))}
                  placeholder="0.00"
                />
              </Field>
            </div>

            <Field label="Notes" hint="(optional)">
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                placeholder="Anything worth recording against this sale"
              />
            </Field>
          </CardBody>
        </Card>

        {items.length > 0 && (
          <Card>
            <CardBody className="flex flex-col gap-s2">
              <div className="flex items-baseline justify-between gap-s3">
                <span className="text-base text-muted-foreground">
                  Subtotal · {plural(items.length, 'item')}
                </span>
                <Money value={subtotal} />
              </div>
              {discount > 0 && (
                <div className="flex items-baseline justify-between gap-s3">
                  <span className="text-base text-muted-foreground">Discount</span>
                  <Money value={-discount} tone="ok" />
                </div>
              )}
              <div className="flex items-baseline justify-between gap-s3 border-t border-border pt-s2">
                <span className="text-sm font-bold text-foreground">Total</span>
                <Money value={total} className="text-md" />
              </div>
            </CardBody>
          </Card>
        )}

        <Button
          type="submit"
          variant="primary"
          size="block"
          className="border-0"
          loading={loading}
          blockedReason={blockingReason}
        >
          {`Complete sale — ${money(total)}`}
        </Button>
      </form>

      {lastBill && <LastBillReceipt bill={lastBill} onDismiss={() => setLastBill(null)} />}

      <BillSummaryDialog
        open={confirming}
        items={items}
        form={form}
        subtotal={subtotal}
        discount={discount}
        total={total}
        loading={loading}
        onCancel={() => setConfirming(false)}
        onConfirm={() => submitBill()}
      />

      <AdherenceDialog
        warnings={adherenceWarnings}
        loading={loading}
        onCancel={() => setAdherenceWarnings(null)}
        onAcknowledge={() => {
          const warnings = adherenceWarnings;
          setAdherenceWarnings(null);
          submitBill(warnings);
        }}
      />
    </div>
  );
}

function LineItem({ item, index, onQtyChange, onLooseQtyChange, onRemove, onSwap }) {
  const qty = parseInt(item.qty, 10) || 0;
  const looseQty = parseInt(item.loose_qty, 10) || 0;
  const exceedsStock = qty > item.total_stock;
  const splittable = supportsLooseSale(item);
  const totals = lineTotals(item);
  const contents = packContents(item);
  const looseNoun = contentNoun(item.pack_content_unit, { plural: true });
  // Whole packs on this line are already committed, so only what is left over
  // is available to the loose box.
  const spareLoose = looseAvailable(item) - qty * contents;
  const exceedsLoose = splittable && looseQty > spareLoose;
  const packHint = wholePackHint(item);
  const status = stockStatus(item);
  const [alternatives, setAlternatives] = useState([]);
  const [loadingAlts, setLoadingAlts] = useState(false);

  /* Keyed on the medicine alone, NOT on exceedsStock. exceedsStock flips while
     the cashier is still typing a quantity, and having it in the dependency
     list refired this request on a keystroke. The molecule's substitutes do
     not change between "4" and "40", so fetch once per medicine and let the
     render decide whether to show the result.

     The cancelled flag guards the swap case: replacing the line unmounts this
     effect mid-flight, and without it a late response from the OLD medicine
     lands in the NEW line's state and offers substitutes for the wrong drug. */
  useEffect(() => {
    if (!item.medicine_id) return undefined;

    let cancelled = false;
    setLoadingAlts(true);

    api.get(`/medicines/${item.medicine_id}/alternatives`)
      .then((res) => { if (!cancelled) setAlternatives(res.data.alternatives || []); })
      .catch(() => { if (!cancelled) setAlternatives([]); })
      .finally(() => { if (!cancelled) setLoadingAlts(false); });

    return () => { cancelled = true; };
  }, [item.medicine_id]);

  // Substitutes are only worth the counter's attention when this line can't be
  // filled as it stands.
  const needsAlternatives = item.total_stock <= 0 || exceedsStock || item.is_low_stock;
  const showAlternatives = needsAlternatives && alternatives.length > 0;

  return (
    <li className="flex flex-col gap-s2 rounded-card border border-border bg-card p-s3 transition-colors">
      <div className="flex flex-wrap items-start justify-between gap-s3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-s2">
            <span className="text-base font-bold text-foreground">{item.name}</span>
            {status.key !== 'ok' && <Badge tone={status.tone}>{status.label}</Badge>}
          </div>
          <p className="mt-s1 text-base text-muted-foreground">
            {money(item.unit_price)} per {sealedNoun(item.unit)}
            {splittable && ` · ${money(totals.loosePrice)} per ${contentNoun(item.pack_content_unit)}`}
            {' · '}{availabilityLabel(item)} in stock
            {item.generic_name && (
              <span className="ml-s2 font-mono text-xs text-accent">({item.generic_name})</span>
            )}
          </p>
          {/* Only for a splittable line: what one pack actually holds is the
              fact the cashier needs to reason about before typing into the
              second box. */}
          {splittable && (
            <p className="text-base text-muted-foreground">{packLabel(item)}</p>
          )}
        </div>

        <div className="flex items-start gap-s2">
          {/* One box for a whole pack, two when the pack can be broken. The
              labels stay visible in the split case — an unlabelled pair of
              numeric boxes at a POS counter is exactly how three tablets get
              rung up as three strips. */}
          <div className={cn('w-[7rem]', splittable && 'w-[6rem]')}>
            <Field
              label={splittable ? sentenceCase(sealedNoun(item.unit, { plural: true })) : `Quantity of ${item.name}`}
              className={cn(!splittable && '[&>label]:sr-only')}
              error={
                exceedsStock
                  ? `Only ${item.total_stock} ${item.unit} in stock.`
                  : undefined
              }
            >
              {/* The visible label is one word so the two boxes stay readable
                  side by side, but "Strips" repeated down a cart tells a
                  screen-reader user nothing about which line they are in — so
                  the accessible name carries the medicine. It still contains
                  the visible text, which is what WCAG 2.5.3 requires. */}
              <NumericInput
                integer
                value={item.qty}
                onChange={(value) => onQtyChange(index, value)}
                className="text-center"
                aria-label={splittable
                  ? `${sentenceCase(sealedNoun(item.unit, { plural: true }))} of ${item.name}`
                  : undefined}
              />
            </Field>
          </div>

          {splittable && (
            <div className="w-[6rem]">
              <Field
                label={sentenceCase(looseNoun)}
                error={exceedsLoose ? `Only ${Math.max(spareLoose, 0)} ${looseNoun} spare.` : undefined}
              >
                <NumericInput
                  integer
                  value={item.loose_qty}
                  onChange={(value) => onLooseQtyChange(index, value)}
                  className="text-center"
                  placeholder="0"
                  aria-label={`${sentenceCase(looseNoun)} of ${item.name}, sold singly`}
                />
              </Field>
            </div>
          )}

          <div className="flex min-h-target flex-col items-end justify-center">
            <Money value={totals.total} className={cn((exceedsStock || exceedsLoose) && 'text-destructive')} />
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label={`Remove ${item.name} from this bill`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Button>
        </div>
      </div>

      {/* What the customer actually walks out with, spelled out once the line
          mixes denominations. "2 strips + 3 tablets" is two numbers in two
          units, and the count of loose pieces is the one a pharmacist checks
          against what they are about to cut off a strip. */}
      {splittable && (qty > 0 || looseQty > 0) && (
        <p className="text-base text-muted-foreground">
          Dispensing {dispensedLabel(item)}
          {totals.contentUnits ? ` · ${totals.contentUnits} ${looseNoun} in total` : null}
        </p>
      )}

      {/* Advisory, never enforced. A full pack's worth of singles may still be
          the right instruction — the batch may already have that many loose
          from an earlier sale, in which case nothing needs opening at all. */}
      {packHint && !exceedsLoose && (
        <p className="text-base text-warning-ink">{packHint}</p>
      )}

      {/* The line above states the problem in the amber/red ramp; the remedy
          answers in mint. Keeping both in amber made the fix read as a second
          warning, which is the opposite of what a queue needs. */}
      {showAlternatives && (
        <div className="mt-s1 w-full animate-fade-in rounded-control border border-success/30 bg-success-wash p-s3">
          <h4 className="flex items-center gap-s2 text-base font-bold text-success">
            <PillIcon className="h-5 w-5 shrink-0" />
            <span className="min-w-0">
              Same composition ({item.generic_name}) in stock:
            </span>
          </h4>

          <ul className="mt-s2 flex flex-wrap gap-s2">
            {alternatives.map((alt) => {
              const saving = item.unit_price - Number(alt.default_selling_price || 0);
              const unitNoun = (alt.unit || 'unit').replace(/s$/, '');
              return (
                <li key={alt.id}>
                  <button
                    type="button"
                    onClick={() => onSwap(alt)}
                    /* The full sentence lives in aria-label because the visible
                       chip is deliberately terse — a screen reader otherwise
                       hears "Crocin 18 strips 42.00" with no verb. */
                    aria-label={
                      `Swap ${item.name} for ${alt.name}, ${alt.total_stock} ${alt.unit} in stock` +
                      `, ${money(alt.default_selling_price)} per ${unitNoun}` +
                      (saving > 0 ? `, saving ${money(saving)} per ${unitNoun}` : '')
                    }
                    className={cn(
                      'flex min-h-target flex-col justify-center gap-s1 rounded-control border border-success/40',
                      'bg-card px-s3 py-s2 text-left shadow-1',
                      'transition-colors duration-instant hover:border-success hover:bg-success-wash'
                    )}
                  >
                    <span className="text-base font-bold text-foreground">{alt.name}</span>
                    <span className="flex flex-wrap items-baseline gap-s2">
                      <Money value={alt.default_selling_price} className="font-normal" />
                      <Qty
                        value={alt.total_stock}
                        unit={alt.unit}
                        className="font-normal text-muted-foreground"
                      />
                      {saving > 0 && (
                        <span className="whitespace-nowrap rounded-pill bg-success-wash px-s2 text-base font-bold text-success">
                          Save {money(saving)}/{unitNoun}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <p className="mt-s2 text-base text-muted-foreground">
            Confirm dosage form with customer before dispensing.
          </p>
        </div>
      )}

      {/* Without this the banner appears ~300ms after the line, moving the
          quantity box out from under the cashier's finger mid-tap. */}
      {needsAlternatives && loadingAlts && (
        <p className="mt-s1 text-base text-muted-foreground">
          Checking for same-composition substitutes…
        </p>
      )}
    </li>
  );
}

function LastBillReceipt({ bill, onDismiss }) {
  return (
    <Card className="mt-s5 border-accent">
      <CardHeader
        action={<Button variant="ghost" size="compact" onClick={onDismiss}>Dismiss</Button>}
      >
        <CardTitle>Sale completed</CardTitle>
        <p className="mt-s1 font-mono text-base text-muted-foreground">{bill.bill_number}</p>
      </CardHeader>
      <CardBody className="pt-s3">
        <ul className="flex flex-col gap-s1">
          {(bill.items || []).map((item, idx) => (
            <li key={idx} className="flex items-baseline justify-between gap-s3">
              {/* The denomination has to survive onto the receipt. "Crocin × 2"
                  meaning two tablets and "Crocin × 2" meaning two strips is a
                  five-fold difference in what was handed over, and this is the
                  last screen anyone checks it on. */}
              <span className="min-w-0 truncate text-base text-foreground">
                {item.medicines?.name} × {item.qty}
                {item.is_loose
                  ? ` ${contentNoun(item.medicines?.pack_content_unit || item.pack_content_unit, { plural: item.qty !== 1 })}`
                  : ` ${sealedNoun(item.medicines?.unit || item.unit, { plural: item.qty !== 1 })}`}
              </span>
              <Money value={item.qty * item.unit_price} />
            </li>
          ))}
        </ul>
        <div className="mt-s3 flex items-baseline justify-between gap-s3 border-t border-border pt-s2">
          <span className="text-sm font-bold text-foreground">Total</span>
          <Money value={bill.total} className="text-md" />
        </div>
        <p className="mt-s2 text-base text-muted-foreground">
          {bill.payment_mode} · {bill.customer_name}
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * The last screen before an immutable bill exists.
 *
 * Read-only by design. It restates the cart in the words the counter will read
 * back to the customer — who it is for, what is being handed over in BOTH
 * denominations, what is being charged and how it is being paid — and offers
 * exactly two ways out: go back and change it, or commit.
 *
 * It is not gated on role. Owner and Staff both ring up sales, both create the
 * same immutable record, and a confirmation that only one of them sees is a
 * check the other cannot fail.
 */
function BillSummaryDialog({ open, items, form, subtotal, discount, total, loading, onCancel, onConfirm }) {
  const customerName = form.customer_name.trim() || 'Walk-in Customer';
  const phone = form.customer_phone.trim();
  const notes = form.notes.trim();
  const paymentLabel = PAYMENT_MODES.find((m) => m.value === form.payment_mode)?.label || form.payment_mode;

  return (
    /* Dismissal is withheld while the request is in flight, the same way
       ConfirmDialog withholds it — closing mid-POST would leave the cashier on
       an empty-looking cart with a sale still landing behind it. */
    <Dialog open={open} onOpenChange={loading ? undefined : (next) => { if (!next) onCancel(); }}>
      <DialogContent>
        <DialogHeader
          title="Check this bill before completing"
          description="A bill can't be edited once it's created — a correction has to go through a customer return."
        />
        <DialogBody className="flex flex-col gap-s4">
          <section>
            <h3 className="text-base font-bold text-foreground">{customerName}</h3>
            <p className="text-base text-muted-foreground">
              {phone ? `${phone} · ` : ''}Paying by {paymentLabel}
            </p>
          </section>

          <section>
            <h3 className="mb-s2 text-base font-bold text-foreground">
              Dispensing · {plural(items.length, 'item')}
            </h3>
            <ul className="flex flex-col gap-s2">
              {items.map((item) => (
                <li key={item.medicine_id} className="flex items-baseline justify-between gap-s3">
                  <span className="min-w-0">
                    <span className="text-base text-foreground">{item.name}</span>
                    {/* The denomination is the whole point of this screen: "2"
                        meaning two tablets and "2" meaning two strips differ
                        tenfold in what leaves the shelf, and this is the last
                        place anyone can catch it. */}
                    <span className="block text-base text-muted-foreground">{dispensedLabel(item)}</span>
                  </span>
                  <Money value={lineTotals(item).total} />
                </li>
              ))}
            </ul>
          </section>

          {notes && (
            <section>
              <h3 className="text-base font-bold text-foreground">Notes</h3>
              <p className="text-base text-muted-foreground">{notes}</p>
            </section>
          )}

          <section className="flex flex-col gap-s2 border-t border-border pt-s3">
            <div className="flex items-baseline justify-between gap-s3">
              <span className="text-base text-muted-foreground">Subtotal</span>
              <Money value={subtotal} />
            </div>
            {discount > 0 && (
              <div className="flex items-baseline justify-between gap-s3">
                <span className="text-base text-muted-foreground">Discount</span>
                <Money value={-discount} tone="ok" />
              </div>
            )}
            <div className="flex items-baseline justify-between gap-s3">
              <span className="text-sm font-bold text-foreground">Total</span>
              <Money value={total} className="text-md" />
            </div>
          </section>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={loading}>Go back and edit</Button>
          </DialogClose>
          {/* §5: the confirming button repeats the commitment, it does not say
              "OK". The figure is here so the amount is on the button the
              cashier's finger is already on. */}
          <Button variant="primary" loading={loading} onClick={onConfirm}>
            {`Confirm sale — ${money(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdherenceDialog({ warnings, loading, onCancel, onAcknowledge }) {
  const open = Boolean(warnings);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent>
        <DialogHeader
          title="Worth a word with this patient"
          description="This doesn't stop the sale. Acknowledging records who reviewed it."
        />
        <DialogBody>
          <ul className="flex flex-col gap-s3">
            {(warnings || []).map((w, i) => (
              <li
                key={i}
                className={cn(
                  'rounded-card border p-s3',
                  w.status === 'overdue'
                    ? 'border-destructive/30 bg-destructive-wash'
                    : 'border-warning/30 bg-warning-wash'
                )}
              >
                <p className={cn('text-base font-bold', w.status === 'overdue' ? 'text-destructive-ink' : 'text-warning-ink')}>
                  {w.medicine_name}
                </p>
                <p className={cn('mt-s1 text-base', w.status === 'overdue' ? 'text-destructive-ink' : 'text-warning-ink')}>
                  {w.status === 'overdue' ? (
                    <>
                      This patient is <strong>{plural(w.days_since_last_purchase, 'day')} overdue</strong> on a{' '}
                      {plural(w.refill_cycle_days, 'day')} cycle. They may have stopped taking it — worth a quick check-in.
                    </>
                  ) : (
                    <>
                      Only <strong>{plural(w.days_since_last_purchase, 'day')}</strong> since their last collection, on a{' '}
                      {plural(w.refill_cycle_days, 'day')} cycle. Earlier than expected — confirm that&rsquo;s intended before dispensing.
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={loading}>Go back to the bill</Button>
          </DialogClose>
          <Button variant="primary" loading={loading} onClick={onAcknowledge}>
            Acknowledge and complete sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
