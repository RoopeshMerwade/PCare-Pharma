import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { money, shortDate, plural, count } from '../../lib/format';
import { Button, Field, NumericInput, Select, Spinner, Textarea } from '../../ui';
import { AlertIcon, BoxIcon, CloseIcon, PlusIcon } from '../../ui/icons';
import { Money, Qty } from '../../domain/Money';
import FormDialog from '../../patterns/FormDialog';
import { MedicineSearchInput } from '../../hooks/useMedicineSearch';
import useVendorPrices from '../../hooks/useVendorPrices';

/* ═══════════════════════════════════════════════════════════════════════════
   Raise a stock request.

   Every subcomponent below sits at MODULE SCOPE and must stay there. Defining
   one inside the parent gives it a new identity on every render, React unmounts
   and remounts the subtree, and the quantity input loses focus after a single
   keystroke — the "form only accepts one character" bug CLAUDE.md records
   being found and fixed three separate times. There is an ESLint rule and a
   regression test; this comment is the third fence.

   THE CLIENT SENDS NO PRICES. The submit body carries medicine_id, qty and
   supplier_id and nothing else — snapshotVendors() on the server reads the
   distributor's name and every figure from the database. A rate posted from a
   browser is a rate anybody can choose, and this document is one the owner
   spends money against. Do not "helpfully" add unit_cost here.
   ═══════════════════════════════════════════════════════════════════════════ */

const NO_VENDOR = '';

/** Priced distributors first, cheapest first; then the rest of the roster. */
function splitVendors(vendors) {
  if (!vendors) return null;
  const priced = vendors.filter((v) => v.last_unit_cost !== null && v.last_unit_cost !== undefined);
  const unpriced = vendors.filter((v) => v.last_unit_cost === null || v.last_unit_cost === undefined);
  return { priced, unpriced, all: vendors };
}

/**
 * Which distributor this line is actually asking for.
 *
 * DERIVED, not stored. The cheapest option is the default, and computing it at
 * render time rather than writing it back through an effect means three things:
 * the default appears the instant the prices land with no extra render pass, a
 * line added before its prices arrive is never left stuck on "none", and
 * `vendorTouched` is the only thing that has to be remembered — which is what
 * keeps "the user deliberately chose no distributor" distinct from "we have not
 * defaulted this yet". Storing the default instead is how clearing the vendor
 * silently re-selects the cheapest on the next update.
 */
function effectiveVendorId(line, vendors) {
  if (line.vendorTouched) return line.supplier_id;
  if (!vendors) return null;
  return vendors.find((v) => v.last_unit_cost !== null)?.supplier_id ?? null;
}

/**
 * The vendor control for one line.
 *
 * ui/Select is a native <select> by deliberate design, so an option cannot
 * render a rich row — which is why the price lives IN the option text. The
 * context a native option cannot carry (how old the rate is, what it saves
 * against the next distributor) sits underneath, for the chosen vendor only.
 */
function VendorSelect({ line, vendors, vendorId, onChange }) {
  const split = splitVendors(vendors);

  if (!split) {
    return (
      <div className="flex min-h-target items-center gap-s2 text-base text-muted-foreground">
        <Spinner className="h-4 w-4" />
        Looking up rates…
      </div>
    );
  }

  if (split.all.length === 0) {
    return (
      <p className="text-base text-muted-foreground">
        No distributors on record yet. Send the request anyway — the owner will source it.
      </p>
    );
  }

  const chosen = split.all.find((v) => v.supplier_id === vendorId) || null;
  const cheapest = split.priced[0] || null;
  const runnerUp = split.priced[1] || null;

  return (
    <div className="flex flex-col gap-s1">
      <Field label={`Distributor for ${line.medicine_name}`} className="[&>label]:sr-only">
        <Select
          value={vendorId || NO_VENDOR}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder="No distributor chosen"
        >
          {split.priced.map((v, i) => (
            <option key={v.supplier_id} value={v.supplier_id}>
              {v.supplier_name} — {money(v.last_unit_cost)}
              {i === 0 && split.priced.length > 1 ? ' (lowest)' : ''}
            </option>
          ))}
          {split.unpriced.map((v) => (
            <option key={v.supplier_id} value={v.supplier_id}>
              {v.supplier_name} — no rate on record
            </option>
          ))}
        </Select>
      </Field>

      {chosen && chosen.last_unit_cost !== null && (
        <p className="text-base text-muted-foreground">
          Last bought {shortDate(chosen.last_purchased_on)}
          {chosen.last_mrp !== null && <> · MRP {money(chosen.last_mrp)}</>}
          {/* The difference IS the decision this feature exists to support.
              Shown only when there is something to compare against. */}
          {runnerUp && chosen.supplier_id === cheapest?.supplier_id && (
            <> · {money(runnerUp.last_unit_cost - chosen.last_unit_cost)} cheaper than {runnerUp.supplier_name}</>
          )}
          {cheapest && chosen.supplier_id !== cheapest.supplier_id && (
            <> · {money(chosen.last_unit_cost - cheapest.last_unit_cost)} dearer than {cheapest.supplier_name}</>
          )}
        </p>
      )}

      {chosen && chosen.last_unit_cost === null && (
        <p className="text-base text-muted-foreground">
          We&rsquo;ve never bought this from {chosen.supplier_name}, so there&rsquo;s no rate to quote.
        </p>
      )}
    </div>
  );
}

function RequisitionLine({ line, vendors, onQty, onVendor, onRemove }) {
  const qty = parseInt(line.qty, 10) || 0;
  const vendorId = effectiveVendorId(line, vendors);
  const chosen = (vendors || []).find((v) => v.supplier_id === vendorId);
  const rate = chosen?.last_unit_cost ?? null;

  return (
    <li className="flex flex-wrap items-start gap-s3 rounded-card border border-border p-s3">
      <div className="min-w-[9rem] flex-1">
        <span className="block text-base font-bold text-foreground">{line.medicine_name}</span>
        {line.generic_name && (
          <span className="block text-base text-muted-foreground">{line.generic_name}</span>
        )}
      </div>

      <div className="w-[6.5rem]">
        <Field label={`Quantity of ${line.medicine_name}`} hint={line.unit} className="[&>label]:sr-only">
          <NumericInput integer value={line.qty} onChange={onQty} className="text-center" />
        </Field>
      </div>

      <div className="min-w-[14rem] flex-1">
        <VendorSelect line={line} vendors={vendors} vendorId={vendorId} onChange={onVendor} />
      </div>

      <div className="flex min-h-target items-center">
        {/* A line with no rate shows a dash, not ₹0.00 — a zero is a figure
            somebody scrolls past, a blank is one they cannot miss. */}
        {rate === null ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <Money value={qty * rate} />
        )}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label={`Remove ${line.medicine_name} from this request`}
      >
        <CloseIcon className="h-5 w-5" />
      </Button>
    </li>
  );
}

/**
 * Tick off several things that ran out at once, instead of searching for each.
 *
 * Reads /stock-requisitions/low-stock — a purpose-built, both-roles endpoint.
 * The obvious alternative, /medicines/alerts/low-stock, is authorize('owner'),
 * so the people who actually notice the shelf is empty cannot call it.
 *
 * Fetched on first open and kept: the list is a snapshot of a moment, and
 * re-reading it under a half-ticked set of checkboxes would move the rows
 * somebody is in the middle of choosing.
 */
function LowStockPicker({ open, onOpenChange, alreadyAdded, onAdd }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState(() => new Set());

  useEffect(() => {
    if (!open || rows !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/stock-requisitions/low-stock');
        if (!cancelled) setRows(res.data.medicines);
      } catch (err) {
        if (!cancelled) { setError(err.message); setRows([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [open, rows]);

  const selectable = useMemo(
    () => (rows || []).filter((m) => !alreadyAdded.has(m.id)),
    [rows, alreadyAdded]
  );

  const toggle = (id, on) => setPicked((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const addPicked = () => {
    onAdd((rows || []).filter((m) => picked.has(m.id)));
    setPicked(new Set());
    // Collapse once the job is done. Leaving a now-mostly-empty picker open
    // pushes the lines the user just added off the bottom of the dialog, which
    // reads as nothing having happened.
    onOpenChange(false);
  };

  return (
    <div className="rounded-card border border-border">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex min-h-target w-full items-center gap-s2 rounded-card px-s3 py-s2 text-left text-base font-bold text-foreground"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-pill bg-warning-wash text-warning-ink">
          <BoxIcon className="h-3.5 w-3.5" />
        </span>
        Add from what&rsquo;s running low
        <span className="ml-auto text-base font-normal text-muted-foreground">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>

      {open && (
        <div className="border-t border-border p-s3">
          {rows === null && (
            <div className="flex items-center gap-s2 text-base text-muted-foreground">
              <Spinner className="h-4 w-4" /> Checking the shelves…
            </div>
          )}

          {error && <p role="alert" className="text-base text-destructive">{error}</p>}

          {rows !== null && !error && selectable.length === 0 && (
            <p className="text-base text-muted-foreground">
              {rows.length === 0
                ? 'Nothing is below its reorder level right now.'
                : 'Everything that’s running low is already on this request.'}
            </p>
          )}

          {selectable.length > 0 && (
            <>
              <ul className="flex max-h-64 flex-col gap-s1 overflow-y-auto">
                {selectable.map((m) => (
                  <li key={m.id}>
                    <label className="flex min-h-target cursor-pointer items-center gap-s3 rounded-control px-s2 py-s1">
                      <input
                        type="checkbox"
                        checked={picked.has(m.id)}
                        onChange={(e) => toggle(m.id, e.target.checked)}
                        className="h-5 w-5 shrink-0 rounded-control border-input accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-bold text-foreground">{m.name}</span>
                        {m.generic_name && (
                          <span className="block text-base text-muted-foreground">{m.generic_name}</span>
                        )}
                      </span>
                      {/* Both numbers, because "8 left" only means something
                          next to the level it fell below. */}
                      <span className="shrink-0 text-right">
                        <Qty
                          value={m.total_stock}
                          unit={m.unit}
                          tone={Number(m.total_stock) === 0 ? 'critical' : 'low'}
                        />
                        <span className="block text-base text-muted-foreground">
                          of {count(m.low_stock_threshold)}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              <div className="mt-s3 flex flex-wrap items-center gap-s2 border-t border-border pt-s3">
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  onClick={() => setPicked(new Set(selectable.map((m) => m.id)))}
                >
                  Select all {selectable.length}
                </Button>
                {picked.size > 0 && (
                  <Button type="button" variant="ghost" size="compact" onClick={() => setPicked(new Set())}>
                    Clear
                  </Button>
                )}
                {/* Keep the action visible even before a selection exists. A user
                    should be able to see the clear next step and understand why
                    the request is still empty, instead of a floating callout that
                    only appears after the click. */}
                <div className="ml-auto">
                  <Button
                    type="button"
                    size="compact"
                    variant={picked.size > 0 ? 'primary' : 'secondary'}
                    onClick={picked.size > 0 ? addPicked : undefined}
                    blockedReason={picked.size === 0 ? 'Tick the medicines you want to add.' : null}
                  >
                    <PlusIcon className="h-4 w-4" />
                    {picked.size > 0 ? `Add ${plural(picked.size, 'medicine')}` : 'Add selected'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function CreateRequisitionModal({ open, onOpenChange, onCreated }) {
  const [lines, setLines] = useState([]);
  const [urgency, setUrgency] = useState('normal');
  const [note, setNote] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const { pricesFor, ensure } = useVendorPrices();

  useEffect(() => {
    if (open) { setLines([]); setUrgency('normal'); setNote(''); setPickerOpen(false); }
  }, [open]);

  const addedIds = useMemo(() => new Set(lines.map((l) => l.medicine_id)), [lines]);

  /**
   * Add one or many. The batch path is what makes the low-stock picker cheap:
   * twelve medicines cost ONE vendor-price request, not twelve.
   *
   * Vendors are attached lazily — a line renders with a spinner in its vendor
   * slot and picks up the cheapest option when the prices land, in the effect
   * below. Blocking the add on a network round trip would make ticking a box
   * feel broken.
   */
  const addMedicines = (medicines) => {
    const fresh = medicines.filter((m) => !addedIds.has(m.id));
    if (fresh.length === 0) return;

    setLines((current) => [
      ...current,
      ...fresh.map((m) => ({
        medicine_id: m.id,
        medicine_name: m.name,
        generic_name: m.generic_name || null,
        unit: m.unit,
        qty: '10',
        supplier_id: null,
        // Distinguishes "we have not defaulted this yet" from "the user
        // deliberately chose no distributor" — without it, clearing the vendor
        // would silently re-select the cheapest on the next price update.
        vendorTouched: false,
      })),
    ]);
    ensure(fresh.map((m) => m.id));
  };

  const updateLine = (index, patch) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  /** The chosen distributor and its rate for one line, as the screen shows it.
   *  One helper so the line total, the estimate, the gap count and the submit
   *  payload can never disagree about which vendor is selected. */
  const resolve = (line) => {
    const vendors = pricesFor(line.medicine_id);
    const vendorId = effectiveVendorId(line, vendors);
    const chosen = (vendors || []).find((v) => v.supplier_id === vendorId) || null;
    return { vendorId, rate: chosen?.last_unit_cost ?? null, loaded: Boolean(vendors) };
  };

  const estimatedTotal = lines.reduce((sum, line) => {
    const { rate } = resolve(line);
    if (rate === null) return sum;
    return sum + rate * (parseInt(line.qty, 10) || 0);
  }, 0);

  const unpricedCount = lines.filter((line) => {
    const { rate, loaded } = resolve(line);
    return loaded && rate === null;
  }).length;

  /* Every reason the button is blocked, in the order a person hits them — first
     one wins. A line with no distributor or no rate is deliberately NOT here:
     "we need this and I don't know who from" is exactly the request the owner
     most needs to see. */
  const blockingReason = (() => {
    if (lines.length === 0) return 'Add at least one medicine before sending this to the owner.';
    const short = lines.find((l) => !parseInt(l.qty, 10));
    if (short) return `${short.medicine_name} needs a quantity of at least 1.`;
    return null;
  })();

  const handleSubmit = async () => {
    await api.post('/stock-requisitions', {
      urgency,
      note: note.trim() || null,
      // The vendor sent is the one on screen — resolved through the same helper
      // the totals use, so a default the user accepted without touching is
      // submitted rather than silently dropped.
      items: lines.map((l) => ({
        medicine_id: l.medicine_id,
        qty: parseInt(l.qty, 10),
        supplier_id: resolve(l).vendorId || null,
      })),
    });
    onCreated();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title="Request stock"
      description="The owner is notified straight away, and can download the order to send to the distributor."
      submitLabel="Send to owner"
      submitBlockedReason={blockingReason}
      onSubmit={handleSubmit}
    >
      <LowStockPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        alreadyAdded={addedIds}
        onAdd={addMedicines}
      />

      <MedicineSearchInput
        label="Or search the catalogue"
        onSelect={(medicine) => addMedicines([medicine])}
        placeholder="Search by name or salt…"
      />

      {lines.length > 0 && (
        <ul className="flex flex-col gap-s3">
          {lines.map((line, index) => (
            <RequisitionLine
              key={line.medicine_id}
              line={line}
              vendors={pricesFor(line.medicine_id)}
              onQty={(v) => updateLine(index, { qty: v })}
              onVendor={(supplierId) =>
                updateLine(index, { supplier_id: supplierId, vendorTouched: true })}
              onRemove={() => setLines((c) => c.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}

      {lines.length > 0 && (
        <div className="flex flex-col gap-s2 border-t border-border pt-s3">
          <div className="flex items-baseline justify-between gap-s3">
            <span className="text-sm font-bold text-foreground">
              Estimated cost
              <span className="ml-s2 font-normal text-muted-foreground">
                at the rates we last paid
              </span>
            </span>
            <Money value={estimatedTotal} className="text-md" />
          </div>
          {unpricedCount > 0 && (
            <p className="flex items-start gap-s2 text-base text-muted-foreground">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning-ink" />
              {plural(unpricedCount, 'line')} {unpricedCount === 1 ? 'has' : 'have'} no rate on
              record, so {unpricedCount === 1 ? 'it is' : 'they are'} not in that figure.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="How urgent">
          <Select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="normal">Normal — add it to the next order</option>
            <option value="urgent">Urgent — customers are being turned away</option>
          </Select>
        </Field>
      </div>

      <Field label="Note for the owner" hint="(optional)">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Anything that explains the request — who asked for it, how often, when it ran out"
        />
      </Field>
    </FormDialog>
  );
}

export { splitVendors };
