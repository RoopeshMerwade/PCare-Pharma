import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import FormDialog from '../../patterns/FormDialog';
import Field from '../../ui/Field';
import Input, { NumericInput } from '../../ui/Input';
import Select from '../../ui/Select';
import Badge from '../../ui/Badge';
import { count as formatCount, qty as formatQty } from '../../lib/format';
import {
  formatPackContent,
  inferPackContents,
  inferUnit,
  resolveDispensingUnit,
  totalContent,
  totalUnits,
} from '../../domain/invoice';

/* ═══════════════════════════════════════════════════════════════════════════
   QuickAddMedicineDialog — "this medicine isn't on file yet", resolved without
   leaving the review.

   The alternative it replaces is: abandon the half-corrected invoice, go to
   Medicines, create the entry, come back, find the line again. That round trip
   is where a 30-line invoice review gets abandoned, and an abandoned review is
   stock that never gets taken in.

   One endpoint does both halves — POST /supplier-invoices/:id/items/:itemId/
   medicine creates the medicine AND links the line — so a reviewer can never
   end up with a new catalogue entry and a line still pointing at nothing.

   Owner-only, and the caller gates the entry point on that. Catalogue writes
   are owner-only everywhere else in this app; the convenience of being mid-task
   is not a reason to widen who can add a medicine.
   ═══════════════════════════════════════════════════════════════════════════ */

const UNITS = ['strips', 'vials', 'bottles', 'tubes', 'packs', 'pcs'];

const COUNTABLE_CONTENT_UNITS = [
  { value: 'TABLET', label: 'tablets' },
  { value: 'CAPSULE', label: 'capsules' },
  { value: 'PIECE', label: 'pieces' },
];

const MEASURED_CONTENT_UNITS = [
  { value: 'ML', label: 'ml' },
  { value: 'L', label: 'litres' },
  { value: 'GM', label: 'grams' },
  { value: 'KG', label: 'kilograms' },
  { value: 'MG', label: 'mg' },
  { value: 'MCG', label: 'mcg' },
  { value: 'DOSE', label: 'doses' },
  { value: 'IU', label: 'IU' },
];

const COUNTABLE_VALUES = COUNTABLE_CONTENT_UNITS.map((u) => u.value);

const BLANK = {
  name: '', generic_name: '', manufacturer: '',
  category_id: '', unit: 'strips', default_selling_price: '',
  pack_content_quantity: '', pack_content_unit: '',
};

export default function QuickAddMedicineDialog({ open, onOpenChange, invoiceId, line, onCreated }) {
  const [form, setForm] = useState(BLANK);
  const [categories, setCategories] = useState([]);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    const prefilledPack = inferPackContents(line);
    setForm({
      ...BLANK,
      // Prefilled from the printed line and from what was already read off the
      // invoice: the reviewer is confirming a name, not transcribing one twice.
      name: line?.raw_description || '',
      // The unit is inferred automatically from the product description and pack size
      unit: inferUnit(line),
      // The selling price the batch will carry is already on the line, and it
      // is a better default for the catalogue than nothing.
      default_selling_price:
        line?.selling_price != null ? String(line.selling_price)
          : line?.mrp != null ? String(line.mrp) : '',
      pack_content_quantity: prefilledPack.quantity || '',
      pack_content_unit: prefilledPack.unit || '',
    });
  }, [open, line]);

  useEffect(() => {
    if (!open) return;
    api.get('/categories').then((res) => setCategories(res.data.categories || [])).catch(() => setCategories([]));
  }, [open]);

  const set = (key) => (value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const validate = () => {
    const found = {};
    const name = form.name.trim();
    if (name.length < 2) found.name = 'Give the medicine a name of at least two characters.';
    else if (name.length > 150) found.name = 'Keep the name to 150 characters or fewer.';
    if (!form.category_id) found.category_id = 'Pick a category so the medicine appears in the right lists.';
    if (!UNITS.includes(form.unit)) found.unit = 'Pick how this medicine is sold.';
    const price = parseFloat(form.default_selling_price);
    if (!(price > 0)) found.default_selling_price = 'Set the standard selling price — it must be above zero.';

    const packQty = form.pack_content_quantity.trim();
    const packUnit = form.pack_content_unit;
    if (packQty && !packUnit) {
      found.pack_content_unit = `Say what the pack holds — ${packQty} what?`;
    }
    if (packUnit && !packQty) {
      found.pack_content_quantity = 'Say how many are in one pack.';
    }
    if (packQty) {
      const contents = parseInt(packQty, 10);
      if (!Number.isFinite(contents) || contents < 1 || contents > 1000) {
        found.pack_content_quantity = 'Enter a whole number between 1 and 1000.';
      } else if (contents === 1 && COUNTABLE_VALUES.includes(packUnit)) {
        found.pack_content_quantity = 'A pack of 1 is already a single unit — leave this blank instead.';
      }
    }

    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');

    const res = await api.post(`/supplier-invoices/${invoiceId}/items/${line.id}/medicine`, {
      name: form.name.trim(),
      generic_name: form.generic_name.trim() || null,
      manufacturer: form.manufacturer.trim() || null,
      category_id: form.category_id,
      unit: form.unit,
      default_selling_price: parseFloat(form.default_selling_price),
      pack_content_quantity: form.pack_content_quantity.trim()
        ? parseInt(form.pack_content_quantity, 10)
        : null,
      pack_content_unit: form.pack_content_unit || null,
    });
    onCreated(res.data.invoice, res.data.medicine);
  };

  const dispensing = resolveDispensingUnit(line);
  const packContentDesc = formatPackContent(line);
  const unitsCount = totalUnits(line);
  const contents = totalContent(line);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add this medicine to the catalogue"
      description={
        line?.raw_description
          ? `Creates a catalogue entry and links line ${line.line_no} to it. Review the extracted details below, tidy up the name, and confirm how it will be dispensed at the counter.`
          : 'Creates a catalogue entry and links this line to it.'
      }
      submitLabel="Add and link"
      onSubmit={handleSubmit}
      submitBlockedReason={categories.length === 0 ? 'No categories are set up yet — add one under Categories first.' : null}
    >
      {/* ── Document extraction summary ───────────────────────────────── */}
      {line && (
        <div className="mb-s4 rounded-card border border-border bg-muted/40 p-s3 text-base">
          <div className="mb-s2 flex items-center justify-between border-b border-border pb-s2">
            <span className="font-bold text-foreground">Extracted from invoice</span>
            {line.line_no && (
              <Badge tone="neutral">Line {line.line_no}</Badge>
            )}
          </div>

          <dl className="grid grid-cols-1 gap-x-s3 gap-y-s2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Printed description</dt>
              <dd className="font-mono font-medium text-foreground break-words">
                {line.raw_description || '—'}
              </dd>
            </div>

            <div>
              <dt className="text-muted-foreground">Pack on invoice</dt>
              <dd className="font-mono font-medium text-foreground">
                {line.pack_raw || 'Not printed'}
              </dd>
            </div>

            <div>
              <dt className="text-muted-foreground">Dispensing unit</dt>
              <dd className="font-medium text-foreground flex items-center gap-s1">
                <span>{dispensing.label}</span>
                {dispensing.isExplicit ? (
                  <Badge tone="neutral">Extracted</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">(Inferred from invoice/product)</span>
                )}
              </dd>
            </div>

            <div>
              <dt className="text-muted-foreground">Pack contents</dt>
              <dd className="font-medium text-foreground">
                {packContentDesc || 'Not detected'}
              </dd>
            </div>

            <div className="sm:col-span-2 border-t border-border/60 pt-s2 mt-s1 flex flex-wrap items-baseline justify-between gap-s2">
              <span className="text-muted-foreground">Quantity received:</span>
              <span className="font-bold text-foreground">
                {formatQty(unitsCount, form.unit)}
                {Number(line.qty_free) > 0 && ` (${line.qty_billed} billed + ${line.qty_free} free)`}
                {contents && (
                  <span className="font-normal text-muted-foreground">
                    {' · '}Equivalent individual units: {formatCount(contents.quantity)} {contents.unit.toLowerCase()}
                  </span>
                )}
              </span>
            </div>
          </dl>
        </div>
      )}

      <Field label="Medicine name" required error={errors.name} hint="as it should read at the counter">
        <Input value={form.name} onChange={(e) => set('name')(e.target.value)} autoComplete="off" />
      </Field>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Generic name" hint="(optional)">
          <Input
            value={form.generic_name}
            onChange={(e) => set('generic_name')(e.target.value)}
            placeholder="Paracetamol"
            autoComplete="off"
          />
        </Field>
        <Field label="Manufacturer" hint="(optional)">
          <Input
            value={form.manufacturer}
            onChange={(e) => set('manufacturer')(e.target.value)}
            placeholder="Cipla"
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Category" required error={errors.category_id}>
          <Select
            value={form.category_id}
            onChange={(e) => set('category_id')(e.target.value)}
            placeholder="Select a category…"
          >
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field
          label="Unit"
          required
          hint={
            dispensing.isExplicit
              ? `Extracted from invoice: ${dispensing.label}`
              : `Inferred: ${form.unit}`
          }
        >
          <Select value={form.unit} onChange={(e) => set('unit')(e.target.value)}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </Field>
      </div>

      {/* ── Pack contents (optional) ─────────────────────────────────── */}
      <fieldset className="rounded-card border border-border p-s3">
        <legend className="px-s2 text-base font-bold text-foreground">
          Pack contents <span className="font-normal text-muted-foreground">(optional)</span>
        </legend>

        <p className="mb-s3 text-base text-muted-foreground">
          What one {form.unit.replace(/s$/, '')} holds. Recording <strong>tablets</strong>,{' '}
          <strong>capsules</strong> or <strong>pieces</strong> lets staff sell single units from an
          opened pack at billing.
        </p>

        <div className="grid gap-s4 sm:grid-cols-2">
          <Field label="Quantity per pack" error={errors.pack_content_quantity}>
            <NumericInput
              integer
              value={form.pack_content_quantity}
              onChange={set('pack_content_quantity')}
              placeholder="e.g. 10"
            />
          </Field>
          <Field label="Measured in" error={errors.pack_content_unit}>
            <Select value={form.pack_content_unit} onChange={(e) => set('pack_content_unit')(e.target.value)} placeholder="Select…">
              <optgroup label="Countable — can be sold singly">
                {COUNTABLE_CONTENT_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </optgroup>
              <optgroup label="Measured — sold whole only">
                {MEASURED_CONTENT_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </optgroup>
            </Select>
          </Field>
        </div>

        {form.pack_content_quantity && form.pack_content_unit && !errors.pack_content_quantity && (
          <p className="mt-s2 text-base text-success">
            {COUNTABLE_VALUES.includes(form.pack_content_unit)
              ? `Staff can sell single units — one ${form.unit.replace(/s$/, '')} opens into ${form.pack_content_quantity}.`
              : 'Sold whole only — this is a measured content, so no single-unit option appears at billing.'}
          </p>
        )}
      </fieldset>

      <Field
        label="Standard selling price"
        required
        hint="per unit"
        error={errors.default_selling_price}
      >
        <NumericInput
          value={form.default_selling_price}
          onChange={set('default_selling_price')}
          placeholder="0.00"
        />
      </Field>
    </FormDialog>
  );
}

