import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { ageFrom, count, initials } from '../../lib/format';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import FormDialog from '../../patterns/FormDialog';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input, { Textarea } from '../../ui/Input';
import Badge from '../../ui/Badge';
import { Money } from '../../domain/Money';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';

const EMPTY = { name: '', phone: '', email: '', date_of_birth: '', address: '', notes: '' };

export default function CustomersPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const resource = useResource({
    endpoint: '/customers',
    initialFilters: { search: '' },
    select: (res) => ({ rows: res.data.customers, pagination: res.data.pagination }),
  });

  const columns = [
    {
      key: 'name',
      label: 'Customer',
      render: (c) => (
        <div className="flex items-center gap-s2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-primary text-base font-bold text-primary-foreground">
            {initials(c.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-bold text-foreground">{c.name}</span>
            {!c.is_active && <Badge tone="neutral">Inactive</Badge>}
          </span>
        </div>
      ),
    },
    {
      key: 'phone',
      label: 'Contact',
      render: (c) => {
        const age = ageFrom(c.date_of_birth);
        return [c.phone, age !== null ? `${age} yrs` : null].filter(Boolean).join(' · ') || '—';
      },
    },
    { key: 'total_bills', label: 'Bills', numeric: true, render: (c) => count(c.total_bills || 0) },
    { key: 'total_spent', label: 'Total spent', numeric: true, render: (c) => <Money value={c.total_spent} whole /> },
  ];

  return (
    <>
      <ResourcePage
        title="Customers"
        subtitle={`${count(resource.pagination.total ?? resource.rows.length)} registered`}
        resource={resource}
        columns={columns}
        itemNoun="customers"
        caption="Registered customers with their bill count and lifetime spend"
        isRowMuted={(c) => !c.is_active}
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        search={{ value: resource.filters.search, onChange: (v) => resource.setFilter('search', v), label: 'Search customers' }}
        searchPlaceholder="Search by name or phone…"
        actions={
          <Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>
            <PlusIcon className="h-4 w-4" />
            Register customer
          </Button>
        }
        rowActions={(c) => (
          <Button variant="ghost" size="compact" onClick={() => { setEditing(c); setModalOpen(true); }}>
            Edit
          </Button>
        )}
        emptyTitle="No customers registered yet"
        emptyBody="Registering a customer links their purchases together, which is what makes refill reminders and chronic-care tracking work. Walk-in sales don't need one."
        emptyAction={<Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>Register the first customer</Button>}
        filteredEmptyTitle="No customers match that search"
        filteredEmptyBody="Try a partial name, or the last few digits of their phone number."
      />

      <CustomerModal
        customer={editing}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={(wasEdit) => {
          setEditing(null);
          resource.reload();
          toast.success(wasEdit ? 'Customer updated.' : 'Customer registered.');
        }}
      />
    </>
  );
}

function CustomerModal({ customer, open, onOpenChange, onSaved }) {
  const isEdit = Boolean(customer);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (customer) {
      setForm({
        name: customer.name || '',
        phone: customer.phone || '',
        email: customer.email || '',
        date_of_birth: customer.date_of_birth || '',
        address: customer.address || '',
        notes: customer.notes || '',
      });
    } else {
      setForm(EMPTY);
    }
    setErrors({});
  }, [customer, open]);

  const set = (key) => (event) => {
    setForm((f) => ({ ...f, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const found = {};
    if (!form.name.trim()) found.name = "Enter the customer's name.";
    if (!isEdit && !form.phone.trim()) found.phone = 'A phone number is needed to link their future purchases.';
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
    const payload = {
      ...form,
      phone: form.phone || null,
      email: form.email || null,
      date_of_birth: form.date_of_birth || null,
    };
    if (isEdit) await api.patch(`/customers/${customer.id}`, payload);
    else await api.post('/customers', payload);
    onSaved(isEdit);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? 'Edit customer' : 'Register customer'}
      description={isEdit ? 'The phone number is fixed after registration — it links their purchase history.' : undefined}
      submitLabel={isEdit ? 'Save changes' : 'Register customer'}
      onSubmit={handleSubmit}
    >
      <Field label="Name" required error={errors.name}>
        <Input value={form.name} onChange={set('name')} placeholder="e.g. Radha Sharma" autoComplete="name" />
      </Field>

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Phone" required={!isEdit} error={errors.phone}>
          <Input
            type="tel"
            inputMode="numeric"
            value={form.phone}
            onChange={set('phone')}
            placeholder="98xxxxxxx0"
            disabled={isEdit}
          />
        </Field>
        <Field label="Date of birth" hint="(optional)">
          <Input type="date" value={form.date_of_birth} onChange={set('date_of_birth')} />
        </Field>
      </div>

      <Field label="Email" hint="(optional)" error={errors.email}>
        <Input type="email" value={form.email} onChange={set('email')} placeholder="customer@email.com" />
      </Field>

      <Field label="Address" hint="(optional)">
        <Input value={form.address} onChange={set('address')} placeholder="e.g. Ward 4, Gadag" />
      </Field>

      <Field label="Notes" hint="(optional)">
        <Textarea value={form.notes} onChange={set('notes')} rows={2} placeholder="Allergies, preferred timings, anything worth remembering" />
      </Field>
    </FormDialog>
  );
}
