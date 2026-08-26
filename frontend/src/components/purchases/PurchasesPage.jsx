import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { date, plural } from '../../lib/format';
import useResource from '../../hooks/useResource';
import { MedicineSearchInput } from '../../hooks/useMedicineSearch';
import ResourcePage from '../../patterns/ResourcePage';
import FormDialog from '../../patterns/FormDialog';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input, { NumericInput, Textarea } from '../../ui/Input';
import Select from '../../ui/Select';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { PurchaseStatusBadge } from '../../domain/StatusBadge';
import ReceivePurchaseModal from './ReceivePurchaseModal';
import PurchaseReceiptDrawer from './PurchaseReceiptDrawer';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_received', label: 'Partly received' },
  { value: 'received', label: 'Received' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function PurchasesPage() {
  const toast = useToast();
  const cancel = useConfirm();
  const [suppliers, setSuppliers] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  // The PO being received / inspected. Held rather than a boolean so the
  // dialog keeps its title and lines through the closing animation.
  const [receiving, setReceiving] = useState(null);
  const [viewingReceipt, setViewingReceipt] = useState(null);

  const resource = useResource({
    endpoint: '/purchases',
    initialFilters: { status: '' },
    select: (res) => ({ rows: res.data.purchases, pagination: res.data.pagination }),
  });

  useEffect(() => {
    api.get('/suppliers').then((r) => setSuppliers(r.data.suppliers)).catch(() => {});
  }, []);

  const handleSend = async (po) => {
    try {
      await api.patch(`/purchases/${po.id}/send`);
      toast.success(`${po.purchase_number} sent to ${po.supplier_name}.`);
      resource.reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleCancel = async () => {
    const po = cancel.target;
    await api.patch(`/purchases/${po.id}/cancel`);
    toast.success(`${po.purchase_number} cancelled.`);
    resource.reload();
  };

  const columns = [
    {
      key: 'purchase_number',
      label: 'Order',
      render: (po) => (
        <div className="flex flex-col gap-s1">
          <span className="font-mono font-bold text-foreground">{po.purchase_number}</span>
          <span className="text-muted-foreground">
            {po.supplier_name}
            {po.invoice_no && <span className="ml-s2 font-mono text-xs">Inv: {po.invoice_no}</span>}
          </span>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (po) => <PurchaseStatusBadge status={po.status} variant="solid" /> },
    { key: 'item_count', label: 'Items', numeric: true, render: (po) => plural(po.item_count, 'item') },
    { key: 'created_at', label: 'Raised', render: (po) => date(po.created_at) },
    {
      key: 'ordered_total',
      label: 'Ordered',
      numeric: true,
      render: (po) => <Money value={po.ordered_total} whole />,
    },
    {
      key: 'received_total',
      label: 'Received',
      numeric: true,
      render: (po) =>
        po.status === 'received' || po.status === 'partially_received'
          ? <Money value={po.received_total} whole tone="ok" />
          : <span className="text-muted-foreground">—</span>,
    },
  ];

  return (
    <>
      <ResourcePage
        title="Purchase Orders"
        subtitle="Orders raised with your suppliers"
        resource={resource}
        columns={columns}
        itemNoun="orders"
        caption="Purchase orders with their status and value"
        isRowMuted={(po) => po.status === 'cancelled'}
        filters={[
          {
            key: 'status',
            label: 'Status',
            value: resource.filters.status,
            onChange: (v) => resource.setFilter('status', v),
            options: STATUS_FILTERS,
          },
        ]}
        actions={
          <Button
            variant="primary"
            onClick={() => setCreateOpen(true)}
            blockedReason={
              suppliers.length === 0
                ? 'Add a supplier first — an order has to be raised against someone.'
                : null
            }
          >
            <PlusIcon className="h-4 w-4" />
            New order
          </Button>
        }
        rowActions={(po) => (
          <>
            {po.status === 'draft' && (
              <>
                <Button variant="secondary" size="compact" onClick={() => handleSend(po)}>Send to supplier</Button>
                <Button variant="ghost" size="compact" className="text-destructive" onClick={() => cancel.ask(po)}>
                  Cancel
                </Button>
              </>
            )}
            {/* Only `sent` offers receiving: receive_purchase_atomic raises
                INVALID_STATUS for anything else, and the status CHECK on
                purchases has no partially_received value to reach. */}
            {po.status === 'sent' && (
              <Button variant="secondary" size="compact" onClick={() => setReceiving(po)}>
                Receive goods
              </Button>
            )}
            {po.status === 'received' && (
              <Button variant="ghost" size="compact" onClick={() => setViewingReceipt(po)}>
                View receipt
              </Button>
            )}
          </>
        )}
        emptyTitle="No purchase orders yet"
        emptyBody="Raising an order records what you asked for, so that receiving it can check the delivery against it."
        emptyAction={
          suppliers.length > 0
            ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Raise the first order</Button>
            : undefined
        }
        filteredEmptyTitle="No orders with that status"
        filteredEmptyBody="Switch the status filter to All to see every order."
      />

      <CreatePurchaseModal
        suppliers={suppliers}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { resource.reload(); toast.success('Purchase order created as a draft.'); }}
      />

      <ReceivePurchaseModal
        purchase={receiving}
        open={Boolean(receiving)}
        onOpenChange={(next) => { if (!next) setReceiving(null); }}
        onReceived={() => {
          toast.success('Purchase received and inventory stock updated.');
          resource.reload();
        }}
      />

      <PurchaseReceiptDrawer
        purchase={viewingReceipt}
        open={Boolean(viewingReceipt)}
        onOpenChange={(next) => { if (!next) setViewingReceipt(null); }}
      />

      <ConfirmDialog
        {...cancel.props}
        destructive
        title={`Cancel ${cancel.target?.purchase_number}?`}
        body={`The order to ${cancel.target?.supplier_name} is marked cancelled and can't be sent or received. It stays on record for the audit trail.`}
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        onConfirm={handleCancel}
      />
    </>
  );
}

function CreatePurchaseModal({ suppliers, open, onOpenChange, onCreated }) {
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([]);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) { setSupplierId(''); setExpectedDate(''); setNotes(''); setItems([]); setErrors({}); }
  }, [open]);

  const addMedicine = (medicine) => {
    setItems((current) => {
      if (current.some((i) => i.medicine_id === medicine.id)) return current;
      return [
        ...current,
        {
          medicine_id: medicine.id,
          name: medicine.name,
          unit: medicine.unit,
          qty_ordered: '10',
          unit_cost: String(medicine.default_selling_price ?? ''),
        },
      ];
    });
    setErrors((e) => ({ ...e, items: '' }));
  };

  const updateItem = (index, key, value) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, [key]: value } : item)));

  const orderedTotal = items.reduce(
    (sum, i) => sum + (parseInt(i.qty_ordered, 10) || 0) * (parseFloat(i.unit_cost) || 0),
    0
  );

  const validate = () => {
    const found = {};
    if (!supplierId) found.supplier = 'Pick the supplier this order goes to.';
    if (items.length === 0) found.items = 'Add at least one medicine to the order.';
    else if (items.some((i) => !parseInt(i.qty_ordered, 10))) {
      found.items = 'Every line needs a quantity of at least 1.';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    await api.post('/purchases', {
      supplier_id: supplierId,
      expected_delivery_date: expectedDate || null,
      notes: notes.trim() || null,
      items: items.map((i) => ({
        medicine_id: i.medicine_id,
        qty_ordered: parseInt(i.qty_ordered, 10),
        unit_cost: parseFloat(i.unit_cost) || 0,
      })),
    });
    onCreated();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title="New purchase order"
      description="The order is saved as a draft. Send it to the supplier when you're ready."
      submitLabel="Create order"
      onSubmit={handleSubmit}
    >
      <Field label="Supplier" required error={errors.supplier}>
        <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="Select a supplier…">
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>

      <div>
        <MedicineSearchInput label="Add medicines" onSelect={addMedicine} placeholder="Search the catalogue…" />
        {errors.items && <p role="alert" className="mt-s1 text-base text-destructive">{errors.items}</p>}
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-s3">
          {items.map((item, index) => (
            <li key={item.medicine_id} className="flex flex-wrap items-start gap-s3 rounded-card border border-border p-s3">
              <span className="min-w-[8rem] flex-1 text-base font-bold text-foreground">{item.name}</span>

              <div className="w-[6.5rem]">
                <Field label={`Quantity of ${item.name}`} hint={item.unit} className="[&>label]:sr-only">
                  <NumericInput
                    integer
                    value={item.qty_ordered}
                    onChange={(v) => updateItem(index, 'qty_ordered', v)}
                    className="text-center"
                  />
                </Field>
              </div>

              <div className="w-[7.5rem]">
                <Field label={`Unit cost for ${item.name}`} className="[&>label]:sr-only">
                  <NumericInput
                    value={item.unit_cost}
                    onChange={(v) => updateItem(index, 'unit_cost', v)}
                    placeholder="₹ cost"
                  />
                </Field>
              </div>

              <div className="flex min-h-target items-center">
                <Money value={(parseInt(item.qty_ordered, 10) || 0) * (parseFloat(item.unit_cost) || 0)} />
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setItems((c) => c.filter((_, i) => i !== index))}
                aria-label={`Remove ${item.name} from this order`}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <div className="flex items-baseline justify-between gap-s3 border-t border-border pt-s3">
          <span className="text-sm font-bold text-foreground">Order total</span>
          <Money value={orderedTotal} className="text-md" />
        </div>
      )}

      <div className="grid gap-s4 sm:grid-cols-2">
        <Field label="Expected delivery" hint="(optional)">
          <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </Field>
      </div>

      <Field label="Notes" hint="(optional)">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Delivery instructions, agreed discounts, anything the supplier should know" />
      </Field>
    </FormDialog>
  );
}
