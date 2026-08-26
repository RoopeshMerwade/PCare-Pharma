import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import FormDialog from '../../patterns/FormDialog';
import Field from '../../ui/Field';
import Input, { NumericInput } from '../../ui/Input';

const BLANK = {
  name: '',
  contact_person: '',
  phone: '',
  email: '',
  gst_no: '',
  drug_license_no: '',
  credit_terms_days: '30',
  notes: '',
};

export default function QuickAddSupplierDialog({
  open,
  onOpenChange,
  defaultName = '',
  defaultGstNo = '',
  defaultDrugLicenseNo = '',
  defaultPhone = '',
  onCreated,
}) {
  const [form, setForm] = useState(BLANK);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm({
      ...BLANK,
      name: defaultName || '',
      gst_no: defaultGstNo || '',
      drug_license_no: defaultDrugLicenseNo || '',
      phone: defaultPhone || '',
    });
  }, [open, defaultName, defaultGstNo, defaultDrugLicenseNo, defaultPhone]);

  const set = (key) => (value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const validate = () => {
    const found = {};
    const name = form.name.trim();
    if (name.length < 2) found.name = 'Give the supplier a name of at least two characters.';
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');

    const res = await api.post('/suppliers', {
      name: form.name.trim(),
      contact_person: form.contact_person.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      gst_no: form.gst_no.trim() || null,
      drug_license_no: form.drug_license_no.trim() || null,
      credit_terms_days: form.credit_terms_days ? Number(form.credit_terms_days) : 30,
      notes: form.notes.trim() || null,
    });
    onCreated(res.data.supplier);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add new supplier"
      description={
        defaultName
          ? `Create a supplier record for “${defaultName}” and link this invoice to it.`
          : 'Create a supplier record and link this invoice to it.'
      }
      submitLabel="Add and link"
      onSubmit={handleSubmit}
    >
      <Field label="Supplier name" required error={errors.name} hint="as registered on the invoice">
        <Input
          value={form.name}
          onChange={(e) => set('name')(e.target.value)}
          autoComplete="off"
        />
      </Field>

      <div className="grid gap-s3 sm:grid-cols-2">
        <Field label="Contact person" hint="(optional)">
          <Input
            value={form.contact_person}
            onChange={(e) => set('contact_person')(e.target.value)}
            placeholder="Sales representative"
            autoComplete="off"
          />
        </Field>
        <Field label="Phone" hint="(optional)">
          <Input
            value={form.phone}
            onChange={(e) => set('phone')(e.target.value)}
            placeholder="Phone or mobile"
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="grid gap-s3 sm:grid-cols-2">
        <Field label="GST number" hint="(optional)">
          <Input
            value={form.gst_no}
            onChange={(e) => set('gst_no')(e.target.value)}
            placeholder="22AAAAA0000A1Z5"
            className="font-mono uppercase"
            autoComplete="off"
          />
        </Field>
        <Field label="Drug license no." hint="(optional)">
          <Input
            value={form.drug_license_no}
            onChange={(e) => set('drug_license_no')(e.target.value)}
            placeholder="DL-20B/21B"
            className="font-mono uppercase"
            autoComplete="off"
          />
        </Field>
      </div>

      <Field label="Credit terms" hint="days to settle invoices">
        <NumericInput
          value={form.credit_terms_days}
          onChange={set('credit_terms_days')}
          placeholder="30"
        />
      </Field>
    </FormDialog>
  );
}
