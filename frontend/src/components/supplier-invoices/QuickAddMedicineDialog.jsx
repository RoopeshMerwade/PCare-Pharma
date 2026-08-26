import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import FormDialog from '../../patterns/FormDialog';
import Field from '../../ui/Field';
import Input, { NumericInput } from '../../ui/Input';
import Select from '../../ui/Select';
import { inferUnit } from '../../domain/invoice';

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

const BLANK = {
  name: '', generic_name: '', manufacturer: '',
  category_id: '', unit: 'strips', default_selling_price: '',
};

export default function QuickAddMedicineDialog({ open, onOpenChange, invoiceId, line, onCreated }) {
  const [form, setForm] = useState(BLANK);
  const [categories, setCategories] = useState([]);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
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
    if (!form.category_id) found.category_id = 'Pick a category so the medicine appears in the right lists.';
    const price = parseFloat(form.default_selling_price);
    if (!(price > 0)) found.default_selling_price = 'Set the standard selling price — it must be above zero.';
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
    });
    onCreated(res.data.invoice, res.data.medicine);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add this medicine to the catalogue"
      description={
        line?.raw_description
          ? `Creates a catalogue entry and links line ${line.line_no} to it. The name is prefilled from the invoice — tidy it up, because this is the name that will appear at the counter.`
          : 'Creates a catalogue entry and links this line to it.'
      }
      submitLabel="Add and link"
      onSubmit={handleSubmit}
      submitBlockedReason={categories.length === 0 ? 'No categories are set up yet — add one under Categories first.' : null}
    >
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
        <Field label="Unit" required hint="how it is dispensed">
          <Select value={form.unit} onChange={(e) => set('unit')(e.target.value)}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </Field>
      </div>

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
