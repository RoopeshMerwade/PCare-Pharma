import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { plural } from '../../lib/format';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import FormDialog from '../../patterns/FormDialog';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input, { NumericInput, Textarea } from '../../ui/Input';
import { ActiveBadge } from '../../domain/StatusBadge';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';

const EMPTY = {
  name: '', contact_person: '', phone: '', email: '',
  gst_no: '', drug_license_no: '', credit_terms_days: '30', notes: '',
};

export default function SuppliersPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const resource = useResource({
    endpoint: '/suppliers',
    initialFilters: { includeInactive: 'true', search: '' },
    select: (res) => ({ rows: res.data.suppliers, pagination: res.data.pagination }),
  });

  const columns = [
    {
      key: 'name',
      label: 'Supplier',
      render: (s) => (
        <div className="flex flex-col gap-s1">
          <span className="font-bold text-foreground">{s.name}</span>
          {s.contact_person && <span className="text-muted-foreground">{s.contact_person}</span>}
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: (s) => s.phone || '—' },
    { key: 'gst_no', label: 'GST number', render: (s) => s.gst_no || '—' },
    {
      key: 'credit_terms_days',
      label: 'Credit terms',
      render: (s) => plural(s.credit_terms_days ?? 0, 'day'),
    },
    { key: 'status', label: 'Status', render: (s) => <ActiveBadge isActive={s.is_active} variant="solid" /> },
  ];

  const handleToggle = async () => {
    const supplier = confirm.target;
    await api.patch(`/suppliers/${supplier.id}/${supplier.is_active ? 'deactivate' : 'reactivate'}`);
    toast.success(`${supplier.name} ${supplier.is_active ? 'deactivated' : 'reactivated'}.`);
    resource.reload();
  };

  const reactivate = async (supplier) => {
    try {
      await api.patch(`/suppliers/${supplier.id}/reactivate`);
      toast.success(`${supplier.name} reactivated.`);
      resource.reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <ResourcePage
        title="Suppliers"
        subtitle={`${resource.pagination.total ?? resource.rows.length} on the books`}
        resource={resource}
        columns={columns}
        itemNoun="suppliers"
        caption="Suppliers, their contact details and credit terms"
        isRowMuted={(s) => !s.is_active}
        search={{ value: resource.filters.search, onChange: (v) => resource.setFilter('search', v), label: 'Search suppliers' }}
        searchPlaceholder="Search by name, contact or GST…"
        actions={
          <Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>
            <PlusIcon className="h-4 w-4" />
            Add supplier
          </Button>
        }
        rowActions={(s) => (
          <>
            <Button variant="ghost" size="compact" onClick={() => { setEditing(s); setModalOpen(true); }}>Edit</Button>
            {s.is_active ? (
              <Button variant="ghost" size="compact" className="text-destructive" onClick={() => confirm.ask(s)}>
                Deactivate
              </Button>
            ) : (
              <Button variant="ghost" size="compact" className="text-accent" onClick={() => reactivate(s)}>
                Reactivate
              </Button>
            )}
          </>
        )}
        emptyTitle="No suppliers yet"
        emptyBody="Add the distributors you buy from. You'll need at least one before you can raise a purchase order."
        emptyAction={<Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>Add the first supplier</Button>}
        filteredEmptyTitle="No suppliers match that search"
        filteredEmptyBody="Try part of the company name, the contact person, or the GST number."
      />

      <SupplierModal
        supplier={editing}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={(wasEdit) => {
          setEditing(null);
          resource.reload();
          toast.success(wasEdit ? 'Supplier updated.' : 'Supplier added.');
        }}
      />

      <ConfirmDialog
        {...confirm.props}
        destructive
        title={`Deactivate ${confirm.target?.name}?`}
        body="Existing purchase orders and payment history stay exactly as they are. You just won't be able to raise new orders against this supplier until you reactivate it."
        confirmLabel="Deactivate supplier"
        onConfirm={handleToggle}
      />
    </>
  );
}

function SupplierModal({ supplier, open, onOpenChange, onSaved }) {
  const isEdit = Boolean(supplier);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (supplier) {
      setForm({
        name: supplier.name || '',
        contact_person: supplier.contact_person || '',
        phone: supplier.phone || '',
        email: supplier.email || '',
        gst_no: supplier.gst_no || '',
        drug_license_no: supplier.drug_license_no || '',
        credit_terms_days: String(supplier.credit_terms_days ?? 30),
        notes: supplier.notes || '',
      });
    } else {
      setForm(EMPTY);
    }
    setErrors({});
  }, [supplier, open]);

  const set = (key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const found = {};
    if (!form.name.trim()) found.name = 'Enter the company name as it appears on their invoices.';
    if (form.phone && !/^[6-9]\d{9}$/.test(form.phone.replace(/\s/g, ''))) {
      found.phone = 'Enter a 10-digit Indian mobile number starting 6–9.';
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      found.email = 'Enter a valid email address, or leave it blank.';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    const payload = { ...form, credit_terms_days: parseInt(form.credit_terms_days, 10) || 30 };
    if (isEdit) await api.patch(`/suppliers/${supplier.id}`, payload);
    else await api.post('/suppliers', payload);
    onSaved(isEdit);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? 'Edit supplier' : 'Add supplier'}
      submitLabel={isEdit ? 'Save changes' : 'Add supplier'}
      onSubmit={handleSubmit}
    >
      <Field label="Company name" required error={errors.name}>
        <Input value={form.name} onChange={set('name')} placeholder="e.g. Laxmi Pharma Distributors" />
      </Field>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Contact person" hint="(optional)">
          <Input value={form.contact_person} onChange={set('contact_person')} placeholder="e.g. Rajesh K." />
        </Field>
        <Field label="Phone" hint="(optional)" error={errors.phone}>
          <Input type="tel" inputMode="numeric" value={form.phone} onChange={set('phone')} placeholder="98xxxxxxx0" />
        </Field>
      </div>

      <Field label="Email" hint="(optional)" error={errors.email}>
        <Input type="email" value={form.email} onChange={set('email')} placeholder="orders@supplier.in" />
      </Field>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="GST number" hint="(optional)">
          <Input value={form.gst_no} onChange={set('gst_no')} placeholder="29XXXXXXXXXXXZX" className="font-mono" />
        </Field>
        <Field label="Drug licence number" hint="(optional)">
          <Input value={form.drug_license_no} onChange={set('drug_license_no')} placeholder="KA/GD1/…" className="font-mono" />
        </Field>
      </div>

      <Field label="Credit terms" hint="days to pay" error={errors.credit_terms_days}>
        <NumericInput integer value={form.credit_terms_days} onChange={set('credit_terms_days')} />
      </Field>

      <Field label="Notes" hint="(optional)">
        <Textarea value={form.notes} onChange={set('notes')} rows={2} placeholder="Delivery days, minimum order, anything worth remembering" />
      </Field>
    </FormDialog>
  );
}
