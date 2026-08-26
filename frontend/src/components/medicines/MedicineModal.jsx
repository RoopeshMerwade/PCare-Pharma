import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import FormDialog from '../../patterns/FormDialog';
import Field from '../../ui/Field';
import Input, { NumericInput, Textarea } from '../../ui/Input';
import Select from '../../ui/Select';

const UNITS = ['strips', 'vials', 'bottles', 'tubes', 'packs', 'pcs'];

/* What is INSIDE one of the units above. Split into two groups because the
   distinction is the whole feature: a strip of 10 tablets holds ten things a
   customer can buy one of, while a 100ML bottle holds a measured volume and is
   ONE saleable thing. Only the countable group enables single-unit sales, and
   the labels say so rather than leaving it to be discovered at the counter.

   Values mirror CONTENT_UNITS in medicines.service.js, which mirrors
   parsePack() in Module 23 — one vocabulary, three places. */
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

const EMPTY = {
  name: '', generic_name: '', manufacturer: '',
  category_id: '', unit: 'strips',
  default_selling_price: '', low_stock_threshold: '20',
  hsn_code: '', description: '',
  pack_content_quantity: '', pack_content_unit: '',
};

/* The field wrapper this form uses lives in ui/Field.jsx, at module scope.
   The bug it prevents is documented there and in CLAUDE.md — this file is one
   of the three where it was originally found and fixed. */

export default function MedicineModal({ medicine, categories, open, onOpenChange, onSaved }) {
  const isEdit = Boolean(medicine);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (medicine) {
      setForm({
        name: medicine.name || '',
        generic_name: medicine.generic_name || '',
        manufacturer: medicine.manufacturer || '',
        category_id: medicine.category_id || '',
        unit: medicine.unit || 'strips',
        default_selling_price: String(medicine.default_selling_price ?? ''),
        low_stock_threshold: String(medicine.low_stock_threshold ?? 20),
        hsn_code: medicine.hsn_code || '',
        description: medicine.description || '',
        pack_content_quantity: medicine.pack_content_quantity == null ? '' : String(medicine.pack_content_quantity),
        pack_content_unit: medicine.pack_content_unit || '',
      });
    } else {
      setForm({ ...EMPTY, category_id: categories[0]?.id || '' });
    }
    setErrors({});
  }, [medicine, categories, open]);

  const set = (key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const found = {};
    const name = form.name.trim();
    if (name.length < 2) found.name = 'Give the medicine a name of at least 2 characters.';
    else if (name.length > 150) found.name = 'Keep the name to 150 characters or fewer.';
    if (!form.category_id) found.category_id = 'Pick the shelf this medicine belongs on.';
    if (!UNITS.includes(form.unit)) found.unit = 'Pick how this medicine is sold.';

    const price = parseFloat(form.default_selling_price);
    if (!Number.isFinite(price) || price <= 0) {
      found.default_selling_price = 'Enter the selling price per unit — it must be more than ₹0.00.';
    }
    const threshold = parseInt(form.low_stock_threshold, 10);
    if (!Number.isFinite(threshold) || threshold < 0) {
      found.low_stock_threshold = 'Enter 0 or more. This is the level that triggers a reorder alert.';
    }
    /* Pack contents are optional, but only as a PAIR. "10" with no unit is a
       countable pack of unknown things, which is exactly what would let a
       strip be split into an invented number of tablets — the server stores
       neither half in that case, so the form refuses it rather than silently
       dropping what was typed. */
    const packQty = form.pack_content_quantity.trim();
    const packUnit = form.pack_content_unit;
    if (packQty && !packUnit) {
      found.pack_content_unit = 'Say what the pack holds — 10 what?';
    }
    if (packUnit && !packQty) {
      found.pack_content_quantity = 'Say how many are in one pack.';
    }
    if (packQty) {
      const contents = parseInt(packQty, 10);
      if (!Number.isFinite(contents) || contents < 1 || contents > 1000) {
        found.pack_content_quantity = 'Enter a whole number between 1 and 1000.';
      } else if (contents === 1 && COUNTABLE_VALUES.includes(packUnit)) {
        // A pack of one is already its own smallest unit; splitting it would
        // create a second denomination for one physical object.
        found.pack_content_quantity = 'A pack of 1 is already a single unit — leave this blank instead.';
      }
    }

    if (form.generic_name.length > 150) found.generic_name = 'Keep the generic name to 150 characters or fewer.';
    if (form.manufacturer.length > 100) found.manufacturer = 'Keep the manufacturer to 100 characters or fewer.';
    if (form.description.length > 500) found.description = 'Keep the notes to 500 characters or fewer.';

    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    const payload = {
      ...form,
      default_selling_price: parseFloat(form.default_selling_price),
      low_stock_threshold: parseInt(form.low_stock_threshold, 10),
      generic_name: form.generic_name.trim() || null,
      manufacturer: form.manufacturer.trim() || null,
      hsn_code: form.hsn_code.trim() || null,
      description: form.description.trim() || null,
      // Sent as an explicit null pair so clearing the fields actually clears
      // them, rather than leaving the previous pack silently in place.
      pack_content_quantity: form.pack_content_quantity.trim()
        ? parseInt(form.pack_content_quantity, 10)
        : null,
      pack_content_unit: form.pack_content_unit || null,
    };
    if (isEdit) await api.patch(`/medicines/${medicine.id}`, payload);
    else await api.post('/medicines', payload);
    onSaved(isEdit);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? 'Edit medicine' : 'Add medicine to catalogue'}
      description="Stock isn't set here — the first stock arrives when you receive a purchase order, which keeps the ledger honest."
      submitLabel={isEdit ? 'Save changes' : 'Add to catalogue'}
      onSubmit={handleSubmit}
    >
      <Field label="Brand / trade name" required error={errors.name}>
        <Input value={form.name} onChange={set('name')} placeholder="e.g. Metformin 500mg Tablet" />
      </Field>

      <Field label="Generic / INN name" hint="(optional)" error={errors.generic_name}>
        <Input value={form.generic_name} onChange={set('generic_name')} placeholder="e.g. Metformin Hydrochloride" />
      </Field>

      <Field label="Manufacturer" hint="(optional)" error={errors.manufacturer}>
        <Input value={form.manufacturer} onChange={set('manufacturer')} placeholder="e.g. Sun Pharma" />
      </Field>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Category" required error={errors.category_id}>
          <Select value={form.category_id} onChange={set('category_id')} placeholder="Select…">
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Sold as" required error={errors.unit}>
          <Select value={form.unit} onChange={set('unit')}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </Field>
      </div>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Selling price" required hint="₹ per unit" error={errors.default_selling_price}>
          <NumericInput value={form.default_selling_price} onChange={set('default_selling_price')} placeholder="0.00" />
        </Field>
        <Field label="Low stock alert at" hint="units" error={errors.low_stock_threshold}>
          <NumericInput integer value={form.low_stock_threshold} onChange={set('low_stock_threshold')} />
        </Field>
      </div>

      {/* The two boxes read as one sentence: "one strip holds [10] [tablets]".
          Splitting them into separate labelled fields tested worse — people
          filled the number and left the unit, which is the one combination
          that means nothing. */}
      <fieldset className="rounded-card border border-border p-s3">
        <legend className="px-s2 text-base font-bold text-foreground">
          Pack contents <span className="font-normal text-muted-foreground">(optional)</span>
        </legend>

        <p className="mb-s3 text-base text-muted-foreground">
          What one {form.unit.replace(/s$/, '')} holds. Recording <strong>tablets</strong>,{' '}
          <strong>capsules</strong> or <strong>pieces</strong> lets staff sell single units from an
          opened pack. Volumes and weights are the contents of one sealed container and are never
          split.
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
            <Select value={form.pack_content_unit} onChange={set('pack_content_unit')} placeholder="Select…">
              <optgroup label="Countable — can be sold singly">
                {COUNTABLE_CONTENT_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </optgroup>
              <optgroup label="Measured — sold whole only">
                {MEASURED_CONTENT_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </optgroup>
            </Select>
          </Field>
        </div>

        {/* Confirms the consequence in the same words the billing screen will
            use, so the outcome is visible here and not discovered at the till. */}
        {form.pack_content_quantity && form.pack_content_unit && !errors.pack_content_quantity && (
          <p className="mt-s2 text-base text-success">
            {COUNTABLE_VALUES.includes(form.pack_content_unit)
              ? `Staff can sell single units — one ${form.unit.replace(/s$/, '')} opens into ${form.pack_content_quantity}.`
              : 'Sold whole only — this is a measured content, so no single-unit option appears at billing.'}
          </p>
        )}
      </fieldset>

      <Field label="HSN code" hint="(optional — for GST)" error={errors.hsn_code}>
        <Input value={form.hsn_code} onChange={set('hsn_code')} placeholder="e.g. 30049099" className="font-mono" />
      </Field>

      <Field label="Notes" hint="(optional)" error={errors.description}>
        <Textarea value={form.description} onChange={set('description')} rows={2} placeholder="Storage requirements, common substitutes, anything staff should know" />
      </Field>
    </FormDialog>
  );
}
