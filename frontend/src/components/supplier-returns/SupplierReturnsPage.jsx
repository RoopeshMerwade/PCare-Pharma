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
import Select from '../../ui/Select';
import Spinner from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { PurchaseStatusBadge } from '../../domain/StatusBadge';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'acknowledged', label: 'Acknowledged' },
];

export function SupplierReturnsPage() {
  const toast = useToast();
  const send = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);

  const resource = useResource({
    endpoint: '/supplier-returns',
    initialFilters: { status: '' },
    select: (res) => ({ rows: res.data.returns, pagination: res.data.pagination }),
  });

  const handleSend = async () => {
    const ret = send.target;
    await api.patch(`/supplier-returns/${ret.id}/send`);
    toast.success(`${ret.return_number} sent. Stock removed and a debit note raised.`);
    resource.reload();
  };

  const handleAcknowledge = async (ret) => {
    try {
      await api.patch(`/supplier-returns/${ret.id}/acknowledge`);
      toast.success(`${ret.return_number} acknowledged. The return is complete.`);
      resource.reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const columns = [
    {
      key: 'return_number',
      label: 'Return',
      render: (r) => (
        <div className="flex flex-col gap-s1">
          <span className="font-mono font-bold text-foreground">{r.return_number}</span>
          <span className="text-muted-foreground">{r.supplier_name}</span>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (r) => <PurchaseStatusBadge status={r.status} variant="solid" /> },
    { key: 'item_count', label: 'Batches', numeric: true, render: (r) => plural(r.item_count, 'batch', 'batches') },
    { key: 'reason', label: 'Reason', render: (r) => <span className="line-clamp-2">{r.reason}</span> },
    { key: 'debit_total', label: 'Debit note', numeric: true, render: (r) => <Money value={r.debit_total} /> },
  ];

  return (
    <>
      <ResourcePage
        title="Supplier Returns"
        subtitle="Stock going back to the distributor"
        resource={resource}
        columns={columns}
        itemNoun="returns"
        caption="Supplier returns with their status and debit note value"
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
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="h-4 w-4" />
            New return
          </Button>
        }
        rowActions={(r) => (
          <>
            {r.status === 'draft' && (
              <Button variant="secondary" size="compact" onClick={() => send.ask(r)}>Confirm and send</Button>
            )}
            {r.status === 'sent' && (
              <Button variant="secondary" size="compact" onClick={() => handleAcknowledge(r)}>Mark acknowledged</Button>
            )}
          </>
        )}
        emptyTitle="No supplier returns on record"
        emptyBody="When stock arrives damaged, expired or wrong, raise a return here. Sending it removes the stock and raises a debit note against the supplier."
        filteredEmptyTitle="No returns with that status"
        filteredEmptyBody="Switch the status filter to All to see every return."
      />

      <CreateSupplierReturnModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { resource.reload(); toast.success('Supplier return drafted. Send it when the goods are collected.'); }}
      />

      <ConfirmDialog
        {...send.props}
        title={`Send ${send.target?.return_number} to ${send.target?.supplier_name}?`}
        body={`This removes ${plural(send.target?.item_count ?? 0, 'batch line', 'batch lines')} from stock immediately and raises a debit note against the supplier. The stock cannot be put back except by a fresh adjustment.`}
        confirmLabel="Send return"
        onConfirm={handleSend}
      />
    </>
  );
}

function CreateSupplierReturnModal({ open, onOpenChange, onCreated }) {
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState('');
  const [search, setSearch] = useState('');
  const [batches, setBatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState([]);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setSupplierId(''); setSearch(''); setBatches([]); setItems([]);
    setReason(''); setNotes(''); setErrors({});
    // /options: id + name for the dropdown. The list endpoint paginates now.
    api.get('/suppliers/options').then((r) => setSuppliers(r.data.suppliers)).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!search.trim()) { setBatches([]); return undefined; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.get(`/medicines/search?q=${encodeURIComponent(search)}`);
        const perMedicine = await Promise.all(
          res.data.medicines.map((m) =>
            api.get(`/inventory/${m.id}/batches?includeExpired=true`)
              .then((b) => b.data.batches.map((batch) => ({ ...batch, medicine_name: m.name })))
              .catch(() => [])
          )
        );
        setBatches(perMedicine.flat().filter((b) => b.stock_qty > 0));
      } catch {
        setBatches([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const addBatch = (batch) => {
    setItems((current) => {
      if (current.some((i) => i.batch_id === batch.id)) return current;
      return [
        ...current,
        {
          batch_id: batch.id,
          medicine_name: batch.medicine_name,
          batch_no: batch.batch_no,
          stock_qty: batch.stock_qty,
          unit_cost: batch.unit_cost,
          qty_returned: '1',
        },
      ];
    });
    setErrors((e) => ({ ...e, items: '' }));
  };

  const debitTotal = items.reduce(
    (sum, i) => sum + (parseInt(i.qty_returned, 10) || 0) * (parseFloat(i.unit_cost) || 0),
    0
  );

  const validate = () => {
    const found = {};
    if (!supplierId) found.supplier = 'Pick the supplier the stock is going back to.';
    if (items.length === 0) found.items = 'Add at least one batch to return.';
    else {
      // Never silently clamp — name the batch and its real stock (§3.5).
      const bad = items.find((i) => {
        const q = parseInt(i.qty_returned, 10);
        return !q || q > i.stock_qty;
      });
      if (bad) {
        found.items = `Batch ${bad.batch_no} holds ${bad.stock_qty} units, so at most ${bad.stock_qty} can go back.`;
      }
    }
    if (!reason.trim()) found.reason = 'Say why the stock is going back — the supplier will ask.';
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    await api.post('/supplier-returns', {
      supplier_id: supplierId,
      reason,
      notes: notes.trim() || null,
      items: items.map((i) => ({ batch_id: i.batch_id, qty_returned: parseInt(i.qty_returned, 10) })),
    });
    onCreated();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title="New supplier return"
      description="Saved as a draft. Nothing leaves stock until you send it."
      submitLabel="Create return"
      onSubmit={handleSubmit}
    >
      <Field label="Supplier" required error={errors.supplier}>
        <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="Select a supplier…">
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>

      <Field label="Find a batch" hint="search by medicine name">
        <div className="relative">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. Metformin" />
          {searching && (
            <span className="pointer-events-none absolute right-s3 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Spinner />
            </span>
          )}
        </div>
      </Field>

      {batches.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-card border border-border">
          {batches.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => addBatch(b)}
                className="flex min-h-target w-full items-center justify-between gap-s3 border-b border-border px-s3 py-s2 text-left transition-colors duration-instant last:border-0 hover:bg-muted"
              >
                <span className="min-w-0 truncate text-base text-foreground">
                  {b.medicine_name} · <span className="font-mono">{b.batch_no}</span>
                </span>
                <span className="tabular shrink-0 text-base text-muted-foreground">{b.stock_qty} in stock</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {errors.items && <p role="alert" className="text-base text-destructive">{errors.items}</p>}

      {items.length > 0 && (
        <ul className="flex flex-col gap-s2">
          {items.map((item, index) => (
            <li key={item.batch_id} className="flex flex-wrap items-start gap-s3 rounded-card border border-border p-s3">
              <div className="min-w-[8rem] flex-1">
                <p className="text-base font-bold text-foreground">{item.medicine_name}</p>
                <p className="text-base text-muted-foreground">
                  Batch <span className="font-mono">{item.batch_no}</span> · {item.stock_qty} in stock
                </p>
              </div>

              <div className="w-[7rem]">
                <Field label={`Quantity of batch ${item.batch_no} to return`} className="[&>label]:sr-only">
                  <NumericInput
                    integer
                    value={item.qty_returned}
                    onChange={(v) =>
                      setItems((c) => c.map((i, x) => (x === index ? { ...i, qty_returned: v } : i)))
                    }
                    className="text-center"
                  />
                </Field>
              </div>

              <div className="flex min-h-target items-center">
                <Money value={(parseInt(item.qty_returned, 10) || 0) * (parseFloat(item.unit_cost) || 0)} />
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setItems((c) => c.filter((_, x) => x !== index))}
                aria-label={`Remove batch ${item.batch_no} from this return`}
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
          <span className="text-sm font-bold text-foreground">Debit note total</span>
          <Money value={debitTotal} className="text-md" />
        </div>
      )}

      <Field label="Reason" required error={errors.reason}>
        <Textarea
          value={reason}
          onChange={(e) => { setReason(e.target.value); setErrors((er) => ({ ...er, reason: '' })); }}
          rows={2}
          placeholder="e.g. Expired on arrival, damaged packaging, wrong items supplied"
        />
      </Field>

      <Field label="Notes" hint="(optional)">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Collection arrangements, reference numbers" />
      </Field>
    </FormDialog>
  );
}

export default SupplierReturnsPage;
