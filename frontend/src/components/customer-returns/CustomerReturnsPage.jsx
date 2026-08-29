import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { date, money, plural } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import FormDialog from '../../patterns/FormDialog';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input, { NumericInput, Textarea } from '../../ui/Input';
import Select from '../../ui/Select';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogClose } from '../../ui/Dialog';
import { SkeletonDetail, SkeletonRegion, SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { ReturnStatusBadge } from '../../domain/StatusBadge';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Awaiting approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const REFUND_MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'credit_note', label: 'Credit note' },
];

export default function CustomerReturnsPage() {
  const { isOwner } = useAuth();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const resource = useResource({
    endpoint: '/customer-returns',
    initialFilters: { status: '' },
    select: (res) => ({ rows: res.data.returns, pagination: res.data.pagination }),
  });

  const pendingCount = resource.rows.filter((r) => r.status === 'pending').length;

  const columns = [
    {
      key: 'return_number',
      label: 'Return',
      render: (r) => (
        <div className="flex flex-col gap-s1">
          <span className="font-mono font-bold text-foreground">{r.return_number}</span>
          <span className="text-muted-foreground">{r.customer_name}</span>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (r) => <ReturnStatusBadge status={r.status} variant="solid" /> },
    { key: 'created_at', label: 'Raised', render: (r) => date(r.created_at) },
    { key: 'item_count', label: 'Items', numeric: true, render: (r) => plural(r.item_count, 'item') },
    {
      key: 'reason',
      label: 'Reason',
      render: (r) => <span className="line-clamp-2">{r.reason}</span>,
    },
    { key: 'item_total', label: 'Refund', numeric: true, render: (r) => <Money value={r.item_total} /> },
  ];

  return (
    <>
      <ResourcePage
        title="Customer Returns"
        subtitle={
          isOwner && pendingCount > 0
            ? `${plural(pendingCount, 'return')} waiting on your approval`
            : 'Corrections to bills already rung up'
        }
        resource={resource}
        columns={columns}
        itemNoun="returns"
        caption="Customer returns with their status and refund value"
        onRowClick={(r) => setSelectedId(r.id)}
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
          <Button variant="ghost" size="compact" onClick={() => setSelectedId(r.id)}>
            {isOwner && r.status === 'pending' ? 'Review' : 'View'}
          </Button>
        )}
        emptyTitle="No returns on record"
        emptyBody="Bills can't be edited once created, so a correction goes through a return. Raise one here when a customer brings something back."
        filteredEmptyTitle="No returns with that status"
        filteredEmptyBody="Switch the status filter to All to see every return."
      />

      <ReturnDetailDialog
        returnId={selectedId}
        isOwner={isOwner}
        onClose={() => setSelectedId(null)}
        onResolved={(message) => { setSelectedId(null); resource.reload(); toast.success(message); }}
        onError={(message) => toast.error(message)}
      />

      <CreateReturnModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { resource.reload(); toast.success('Return submitted. It needs the owner’s approval before stock goes back.'); }}
      />
    </>
  );
}

function ReturnDetailDialog({ returnId, isOwner, onClose, onResolved, onError }) {
  const [detail, setDetail] = useState(null);
  const [working, setWorking] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionNote, setRejectionNote] = useState('');

  useEffect(() => {
    if (!returnId) { setDetail(null); setRejecting(false); setRejectionNote(''); return; }
    api.get(`/customer-returns/${returnId}`).then((r) => setDetail(r.data.return)).catch((e) => onError(e.message));
  }, [returnId, onError]);

  const approve = async () => {
    setWorking(true);
    try {
      await api.patch(`/customer-returns/${returnId}/approve`);
      onResolved(`${detail.return_number} approved. Stock is back on the shelf.`);
    } catch (err) {
      onError(err.message);
    } finally {
      setWorking(false);
    }
  };

  const reject = async () => {
    setWorking(true);
    try {
      await api.patch(`/customer-returns/${returnId}/reject`, { rejection_note: rejectionNote.trim() || null });
      onResolved(`${detail.return_number} rejected.`);
    } catch (err) {
      onError(err.message);
    } finally {
      setWorking(false);
    }
  };

  const open = Boolean(returnId);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !working) onClose(); }}>
      <DialogContent>
        {!detail ? (
          <>
            <DialogHeader title="Loading return…" />
            <DialogBody>
              {/* Reason and refund mode sit over the returned lines, which is
                  the order the detail arrives in. */}
              <SkeletonRegion label="Loading this return…">
                <SkeletonDetail rows={2} className="border-b border-border pb-s3" />
                <SkeletonRows count={2} className="py-s3" />
              </SkeletonRegion>
            </DialogBody>
          </>
        ) : (
          <>
            <DialogHeader
              title={detail.return_number}
              description={`${detail.customer_name} · raised by ${detail.created_by_name}`}
            />
            <DialogBody>
              {/* Solid to match the list column — §5: the same status must not
                  look like two different states across a flow. */}
              <div className="mb-s3"><ReturnStatusBadge status={detail.status} variant="solid" /></div>

              <dl className="flex flex-col gap-s1 border-b border-border pb-s3">
                <Row label="Reason" value={detail.reason} />
                <Row label="Refund via" value={REFUND_MODES.find((m) => m.value === detail.refund_mode)?.label || detail.refund_mode} />
              </dl>

              <ul className="flex flex-col gap-s2 py-s3">
                {(detail.items || []).map((item, idx) => (
                  <li key={idx} className="flex items-start justify-between gap-s3">
                    <div className="min-w-0">
                      <p className="text-base font-bold text-foreground">{item.medicines?.name}</p>
                      <p className="text-base text-muted-foreground">
                        Batch {item.inventory_batches?.batch_no} · {plural(item.qty_returned, 'unit')} returned
                      </p>
                    </div>
                    <Money value={item.qty_returned * parseFloat(item.unit_price)} />
                  </li>
                ))}
              </ul>

              <div className="flex items-baseline justify-between gap-s3 border-t border-border pt-s2">
                <span className="text-sm font-bold text-foreground">Refund total</span>
                <Money value={detail.item_total} className="text-md" />
              </div>

              {detail.rejection_note && (
                <div className="mt-s3 rounded-card border border-destructive/30 bg-destructive-wash p-s3">
                  <p className="text-base font-bold text-destructive-ink">Rejected</p>
                  <p className="mt-s1 text-base text-destructive-ink">{detail.rejection_note}</p>
                </div>
              )}

              {rejecting && (
                <div className="mt-s4">
                  <Field label="Why is this being rejected?" hint="(optional — the customer may ask)">
                    <Textarea
                      value={rejectionNote}
                      onChange={(e) => setRejectionNote(e.target.value)}
                      rows={2}
                      placeholder="e.g. Pack opened and part-used, outside the return window"
                    />
                  </Field>
                </div>
              )}
            </DialogBody>

            {isOwner && detail.status === 'pending' && (
              <DialogFooter>
                {rejecting ? (
                  <>
                    <Button variant="secondary" disabled={working} onClick={() => setRejecting(false)}>
                      Go back
                    </Button>
                    <Button variant="destructive" loading={working} onClick={reject}>
                      Confirm rejection
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="secondary" disabled={working} onClick={() => setRejecting(true)}>
                      Reject
                    </Button>
                    <Button variant="primary" loading={working} onClick={approve}>
                      Approve and restore stock
                    </Button>
                  </>
                )}
              </DialogFooter>
            )}

            {!(isOwner && detail.status === 'pending') && (
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Close</Button>
                </DialogClose>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-s3">
      <dt className="shrink-0 text-base text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-base text-foreground">{value}</dd>
    </div>
  );
}

function CreateReturnModal({ open, onOpenChange, onCreated }) {
  const [billNumber, setBillNumber] = useState('');
  const [bill, setBill] = useState(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [items, setItems] = useState([]);
  const [reason, setReason] = useState('');
  const [refundMode, setRefundMode] = useState('cash');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) {
      setBillNumber(''); setBill(null); setItems([]);
      setReason(''); setRefundMode('cash'); setErrors({});
    }
  }, [open]);

  const lookupBill = async () => {
    if (!billNumber.trim()) {
      setErrors({ bill: 'Enter the bill number from the customer’s receipt.' });
      return;
    }
    setLookingUp(true);
    setErrors({});
    try {
      const r = await api.get(`/billing?search=${encodeURIComponent(billNumber)}&limit=1`);
      const found = r.data.bills?.[0];
      if (!found) {
        setErrors({ bill: `No bill matches “${billNumber}”. Check the number on the receipt.` });
        return;
      }
      const d = await api.get(`/billing/${found.id}`);
      setBill(d.data.bill);
      setItems(d.data.bill.items.map((i) => ({ ...i, qty_returned: '', selected: false })));
    } catch (err) {
      setErrors({ bill: err.message });
    } finally {
      setLookingUp(false);
    }
  };

  const toggleItem = (index, selected) =>
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, selected, qty_returned: selected ? String(item.qty) : '' } : item))
    );

  const setQty = (index, value) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, qty_returned: value } : item)));

  const selected = items.filter((i) => i.selected);
  const refundTotal = selected.reduce(
    (sum, i) => sum + (parseInt(i.qty_returned, 10) || 0) * parseFloat(i.unit_price),
    0
  );

  const validate = () => {
    const found = {};
    if (selected.length === 0) found.items = 'Tick at least one item the customer is bringing back.';
    else {
      const bad = selected.find((i) => {
        const q = parseInt(i.qty_returned, 10);
        return !q || q > i.qty;
      });
      if (bad) {
        found.items = `${bad.medicines?.name}: only ${bad.qty} were sold on this bill, so at most ${bad.qty} can come back.`;
      }
    }
    if (!reason.trim()) found.reason = 'Say why the item is being returned — this goes on the record.';
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    await api.post('/customer-returns', {
      bill_id: bill.id,
      reason,
      refund_mode: refundMode,
      items: selected.map((i) => ({ bill_item_id: i.id, qty_returned: parseInt(i.qty_returned, 10) })),
    });
    onCreated();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New customer return"
      description="Find the original bill, pick what's coming back, and the owner approves it before stock is restored."
      submitLabel="Submit return"
      submitBlockedReason={!bill ? 'Find the original bill first — a return has to be tied to a sale.' : null}
      onSubmit={handleSubmit}
    >
      {!bill ? (
        <Field label="Bill number" required error={errors.bill}>
          <div className="flex gap-s2">
            <Input
              value={billNumber}
              onChange={(e) => setBillNumber(e.target.value)}
              placeholder="BILL-2026-0001"
              className="font-mono"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupBill(); } }}
            />
            <Button type="button" variant="secondary" loading={lookingUp} onClick={lookupBill}>
              Find bill
            </Button>
          </div>
        </Field>
      ) : (
        <>
          <div className="flex items-center justify-between gap-s3 rounded-card border border-border bg-muted p-s3">
            <div className="min-w-0">
              <p className="font-mono text-base font-bold text-foreground">{bill.bill_number}</p>
              <p className="text-base text-muted-foreground">{bill.customer_name} · {date(bill.created_at)}</p>
            </div>
            <Button type="button" variant="ghost" size="compact" onClick={() => { setBill(null); setItems([]); }}>
              Change
            </Button>
          </div>

          <fieldset>
            <legend className="mb-s2 text-base font-bold text-foreground">What is coming back?</legend>
            {errors.items && <p role="alert" className="mb-s2 text-base text-destructive">{errors.items}</p>}
            <ul className="flex flex-col gap-s2">
              {items.map((item, index) => (
                <li
                  key={item.id}
                  className={cn(
                    'rounded-card border p-s3 transition-colors duration-instant',
                    item.selected ? 'border-accent bg-card' : 'border-border bg-card'
                  )}
                >
                  <label className="flex min-h-target items-center gap-s3">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={(e) => toggleItem(index, e.target.checked)}
                      className="h-5 w-5 shrink-0 rounded-control border-input accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-bold text-foreground">{item.medicines?.name}</span>
                      <span className="block text-base text-muted-foreground">
                        {plural(item.qty, 'unit')} sold at {money(item.unit_price)} each
                      </span>
                    </span>
                  </label>

                  {item.selected && (
                    <div className="mt-s2 w-[9rem]">
                      <Field
                        label={`How many ${item.medicines?.name} are coming back?`}
                        hint={`of ${item.qty}`}
                        className="[&>label]:sr-only"
                      >
                        <NumericInput
                          integer
                          value={item.qty_returned}
                          onChange={(v) => setQty(index, v)}
                          className="text-center"
                        />
                      </Field>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>

          {selected.length > 0 && (
            <div className="flex items-baseline justify-between gap-s3 border-t border-border pt-s3">
              <span className="text-sm font-bold text-foreground">Refund total</span>
              <Money value={refundTotal} className="text-md" />
            </div>
          )}

          <Field label="Reason" required error={errors.reason}>
            <Textarea
              value={reason}
              onChange={(e) => { setReason(e.target.value); setErrors((er) => ({ ...er, reason: '' })); }}
              rows={2}
              placeholder="e.g. Wrong strength dispensed, customer reacted to an ingredient"
            />
          </Field>

          <Field label="Refund via">
            <Select value={refundMode} onChange={(e) => setRefundMode(e.target.value)}>
              {REFUND_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          </Field>
        </>
      )}
    </FormDialog>
  );
}
