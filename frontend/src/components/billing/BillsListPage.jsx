import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { count, dateTime } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import FormDialog from '../../patterns/FormDialog';
import Button from '../../ui/Button';
import Card, { CardBody } from '../../ui/Card';
import ErrorState from '../../ui/ErrorState';
import Input from '../../ui/Input';
import Field from '../../ui/Field';
import { Dialog, DialogContent, DialogHeader, DialogBody } from '../../ui/Dialog';
import { SkeletonDetail, SkeletonRegion, SkeletonTile } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { Money } from '../../domain/Money';
import { PaymentBadge } from '../../domain/StatusBadge';
import {
  deletionBlockedReason, reasonBlockedReason, rangeConfirmationMatches, unitsLeftDeducted,
} from '../../domain/billDeletion';

const PAYMENT_MODES = [
  { value: '', label: 'All payment modes' },
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'credit', label: 'Credit' },
  { value: 'card', label: 'Card' },
];

export default function BillsListPage() {
  const { isOwner } = useAuth();
  const toast = useToast();
  const [selected, setSelected] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  // Bumped on every open so the range dialog remounts with empty fields,
  // rather than resetting them from an effect.
  const [rangeSession, setRangeSession] = useState(0);
  const [summary, setSummary] = useState(null);

  const resource = useResource({
    endpoint: '/billing',
    initialFilters: { search: '', paymentMode: '', dateFrom: '', dateTo: '' },
    select: (res) => ({ rows: res.data.bills, pagination: res.data.pagination }),
  });

  const loadTotals = useCallback(() => {
    if (!isOwner) return;
    const today = new Date().toISOString().slice(0, 10);
    api.get(`/billing/totals?dateFrom=${today}&dateTo=${today}`)
      .then((r) => setSummary(r.data.summary))
      .catch(() => {});
  }, [isOwner]);

  useEffect(() => { loadTotals(); }, [loadTotals]);

  // A deleted bill leaves this list and today's totals, so both are read
  // again. Everything else that shows sales reads live data on its own page.
  const handleDeleted = (message) => {
    setSelected(null);
    setDeleting(null);
    setRangeOpen(false);
    toast.success(message);
    resource.reload();
    loadTotals();
  };

  const openRangeDelete = () => {
    setRangeSession((n) => n + 1);
    setRangeOpen(true);
  };

  const columns = [
    {
      key: 'bill_number',
      label: 'Bill number',
      render: (b) => <span className="font-mono font-bold text-foreground">{b.bill_number}</span>,
    },
    {
      key: 'customer_name',
      label: 'Customer',
      render: (b) => (
        <div className="flex flex-col">
          <span className="font-bold text-foreground">{b.customer_name}</span>
          {b.customer_phone && <span className="text-muted-foreground">{b.customer_phone}</span>}
        </div>
      ),
    },
    { key: 'created_at', label: 'Rung up', render: (b) => dateTime(b.created_at) },
    { key: 'item_count', label: 'Items', numeric: true, render: (b) => count(b.item_count) },
    { key: 'created_by_name', label: 'Staff', render: (b) => b.created_by_name || '—' },
    { key: 'payment_mode', label: 'Paid by', render: (b) => <PaymentBadge mode={b.payment_mode} variant="solid" /> },
    { key: 'total', label: 'Total', numeric: true, render: (b) => <Money value={b.total} /> },
  ];

  return (
    <>
      <ResourcePage
        title="Bills"
        subtitle={`${count(resource.pagination.total ?? resource.rows.length)} recorded`}
        // Absent for staff rather than disabled (§3.6): a greyed-out control
        // leaks that bills can be deleted at all.
        actions={isOwner ? (
          <Button variant="secondary" onClick={openRangeDelete}>Delete bills by date</Button>
        ) : null}
        resource={resource}
        columns={columns}
        itemNoun="bills"
        caption="Every bill rung up, newest first"
        onRowClick={setSelected}
        // §3.7 permits horizontal scroll as an opt-in on the sales history
        // table specifically, where the column count is high and comparing
        // across rows is the point.
        allowHorizontalScroll
        search={{ value: resource.filters.search, onChange: (v) => resource.setFilter('search', v), label: 'Search bills' }}
        searchPlaceholder="Bill number, customer or phone…"
        filters={[
          {
            key: 'paymentMode',
            label: 'Payment mode',
            value: resource.filters.paymentMode,
            onChange: (v) => resource.setFilter('paymentMode', v),
            options: PAYMENT_MODES,
          },
        ]}
        emptyTitle="No bills yet"
        emptyBody="Bills appear here as they're rung up at the counter. Start one from New bill."
        filteredEmptyTitle="No bills match those filters"
        filteredEmptyBody="Try a wider date range, a different payment mode, or clear the search."
      >
        {isOwner && (
          summary ? (
            <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
              <TotalCard label="Total today" value={summary.total} />
              <TotalCard label="Cash today" value={summary.cash} />
              <TotalCard label="UPI today" value={summary.upi} />
              <TotalCard label="Credit today" value={summary.credit} />
            </div>
          ) : (
            // Four tiles, not one bar in the first cell of a four-column grid:
            // the totals row is what the owner's eye goes to first, and it has
            // to be the same shape before and after the figures land.
            <SkeletonRegion label="Loading today’s totals…" className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
              {[0, 1, 2, 3].map((n) => <SkeletonTile key={n} trend={false} sub={false} />)}
            </SkeletonRegion>
          )
        )}

        <div className="mb-s4 grid gap-s3 sm:grid-cols-2 sm:max-w-[28rem]">
          <Field label="From date">
            <Input type="date" value={resource.filters.dateFrom} onChange={(e) => resource.setFilter('dateFrom', e.target.value)} />
          </Field>
          <Field label="To date">
            <Input type="date" value={resource.filters.dateTo} onChange={(e) => resource.setFilter('dateTo', e.target.value)} />
          </Field>
        </div>
      </ResourcePage>

      <BillDetailDialog
        bill={selected}
        open={Boolean(selected)}
        onOpenChange={(next) => { if (!next) setSelected(null); }}
        onDelete={isOwner ? (bill) => { setSelected(null); setDeleting(bill); } : null}
      />

      {isOwner && (
        <>
          {/* Keyed by bill, so each bill's dialog starts with no preview and an
              empty reason instead of carrying the last one's over. */}
          <DeleteBillDialog
            key={deleting?.id ?? 'none'}
            bill={deleting}
            open={Boolean(deleting)}
            onOpenChange={(next) => { if (!next) setDeleting(null); }}
            onDeleted={handleDeleted}
          />
          <DeleteBillsRangeDialog
            key={rangeSession}
            open={rangeOpen}
            onOpenChange={setRangeOpen}
            onDeleted={handleDeleted}
          />
        </>
      )}
    </>
  );
}

function TotalCard({ label, value }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-s1">
        <span className="text-base text-muted-foreground">{label}</span>
        <Money value={value} whole className="text-md" />
      </CardBody>
    </Card>
  );
}

function BillDetailDialog({ bill, open, onOpenChange, onDelete }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    if (!bill || !open) { setDetail(null); return; }
    api.get(`/billing/${bill.id}`).then((r) => setDetail(r.data.bill)).catch(() => {});
  }, [bill, open]);

  if (!bill) return null;
  const b = detail || bill;
  const discount = parseFloat(b.discount_amount || 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={b.bill_number} description={`${b.customer_name} · ${dateTime(b.created_at)}`} />
        <DialogBody>
          <dl className="flex flex-col gap-s1 border-b border-border pb-s3">
            <Row label="Customer" value={[b.customer_name, b.customer_phone].filter(Boolean).join(' · ')} />
            <Row label="Rung up by" value={b.created_by_name || '—'} />
            <Row label="Paid by" value={<PaymentBadge mode={b.payment_mode} variant="solid" />} />
          </dl>

          {/* The row already carries the header and the totals, so the dialog
              opens with those in place; only the lines are still in flight.
              Standing them in keeps the totals below from jumping up the
              dialog and back down as the items arrive. */}
          {!detail ? (
            <SkeletonRegion label="Loading the bill lines…" className="py-s3">
              <SkeletonDetail rows={3} />
            </SkeletonRegion>
          ) : (
          <ul className="flex flex-col gap-s2 py-s3">
            {(b.items || []).map((item, idx) => (
              <li key={idx} className="flex items-start justify-between gap-s3">
                <div className="min-w-0">
                  <p className="text-base font-bold text-foreground">{item.medicines?.name}</p>
                  <p className="text-base text-muted-foreground">
                    Batch {item.inventory_batches?.batch_no} · {item.qty} × ₹{Number(item.unit_price).toFixed(2)}
                  </p>
                </div>
                <Money value={item.qty * item.unit_price} />
              </li>
            ))}
          </ul>
          )}

          <dl className="flex flex-col gap-s1 border-t border-border pt-s3">
            <Row label="Subtotal" value={<Money value={b.subtotal} />} />
            {discount > 0 && <Row label="Discount" value={<Money value={-discount} tone="ok" />} />}
            <div className="flex items-baseline justify-between gap-s3 pt-s1">
              <dt className="text-sm font-bold text-foreground">Total</dt>
              <dd><Money value={b.total} className="text-md" /></dd>
            </div>
          </dl>

          <p className="mt-s3 text-base text-muted-foreground">
            {onDelete
              ? 'Bills can’t be edited. To correct one, raise a customer return, or delete it permanently. Deleting never puts the stock back.'
              : 'Bills can’t be edited. If something needs correcting, raise a customer return instead.'}
          </p>

          {onDelete && (
            <div className="mt-s3 flex justify-end">
              <Button variant="ghost" size="compact" className="text-destructive" onClick={() => onDelete(b)}>
                Delete bill
              </Button>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/* What a deletion removes, and — in bold, because it is the part an owner
   would not assume — that the stock stays deducted. */
function DeletionSummary({ preview, error }) {
  if (error) return <ErrorState message={error} />;
  if (!preview) {
    return (
      <SkeletonRegion label="Checking what this would delete…">
        <SkeletonDetail rows={2} />
      </SkeletonRegion>
    );
  }

  const blocked = preview.bill_count > 0 ? deletionBlockedReason(preview) : null;
  const bills = Number(preview.bill_count) || 0;
  const lines = Number(preview.item_count) || 0;

  return (
    <div className="flex flex-col gap-s2 rounded-card border border-border bg-muted p-s3">
      {bills === 0 ? (
        <p className="text-base text-foreground">There are no bills on those days.</p>
      ) : (
        <>
          <p className="text-base text-foreground">
            <Money value={preview.total_amount} /> across {count(bills)} {bills === 1 ? 'bill' : 'bills'} and{' '}
            {count(lines)} {lines === 1 ? 'line' : 'lines'} will disappear from sales, reports and customer history.
          </p>
          <p className="text-base font-bold text-foreground">
            Stock is not returned: {unitsLeftDeducted(preview.sealed_units_not_restocked, preview.loose_units_not_restocked)} stay deducted.
          </p>
          <p className="text-base text-muted-foreground">This can’t be undone.</p>
        </>
      )}
      {blocked && <p className="text-base font-bold text-destructive">{blocked}</p>}
    </div>
  );
}

function DeleteBillDialog({ bill, open, onOpenChange, onDeleted }) {
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open || !bill) return undefined;
    let cancelled = false;
    api.get(`/billing/${bill.id}/delete-preview`)
      .then((r) => { if (!cancelled) setPreview(r.data.preview); })
      .catch((err) => { if (!cancelled) setPreviewError(err.message || 'Could not check this bill.'); });
    return () => { cancelled = true; };
  }, [bill, open]);

  if (!bill) return null;

  const handleSubmit = async () => {
    const res = await api.post(`/billing/${bill.id}/delete`, { reason: reason.trim() });
    onDeleted(res.message || `Deleted ${bill.bill_number}. Stock was not returned.`);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title={`Delete ${bill.bill_number} permanently?`}
      description={`${bill.customer_name} · ${dateTime(bill.created_at)}`}
      submitLabel="Delete bill"
      onSubmit={handleSubmit}
      submitBlockedReason={previewError || deletionBlockedReason(preview) || reasonBlockedReason(reason)}
    >
      <DeletionSummary preview={preview} error={previewError} />
      <Field label="Reason" required hint="(kept in the audit log)">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Test bill rung up during training"
          maxLength={500}
        />
      </Field>
    </FormDialog>
  );
}

function DeleteBillsRangeDialog({ open, onOpenChange, onDeleted }) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [reason, setReason] = useState('');
  // Bumped after RANGE_CHANGED so the same dates are previewed again.
  const [attempt, setAttempt] = useState(0);
  // Each preview and each typed confirmation is stored against the range and
  // attempt it belongs to, and only read back while that is still the current
  // one. Changing the dates therefore empties both at once, with nothing to
  // reset — and the owner always confirms the number they are looking at.
  const [previewState, setPreviewState] = useState({ key: null, preview: null, error: null });
  const [confirmation, setConfirmation] = useState({ key: null, typed: '' });

  const datesReady = Boolean(dateFrom && dateTo) && dateFrom <= dateTo;
  const currentKey = datesReady ? `${dateFrom}|${dateTo}|${attempt}` : null;

  useEffect(() => {
    if (!open || !currentKey) return undefined;
    let cancelled = false;
    api.get(`/billing/delete-preview?dateFrom=${dateFrom}&dateTo=${dateTo}`)
      .then((r) => { if (!cancelled) setPreviewState({ key: currentKey, preview: r.data.preview, error: null }); })
      .catch((err) => {
        if (!cancelled) setPreviewState({ key: currentKey, preview: null, error: err.message || 'Could not preview those dates.' });
      });
    return () => { cancelled = true; };
  }, [open, currentKey, dateFrom, dateTo]);

  const isCurrent = previewState.key === currentKey;
  const preview = isCurrent ? previewState.preview : null;
  const previewError = isCurrent ? previewState.error : null;
  const typed = confirmation.key === currentKey ? confirmation.typed : '';

  let blockedReason = null;
  if (!dateFrom || !dateTo) blockedReason = 'Choose both dates.';
  else if (dateFrom > dateTo) blockedReason = 'The start date must be on or before the end date.';
  else {
    blockedReason = previewError || deletionBlockedReason(preview) || reasonBlockedReason(reason);
    if (!blockedReason && !rangeConfirmationMatches(typed, preview.bill_count)) {
      blockedReason = `Type ${preview.bill_count} to confirm.`;
    }
  }

  const handleSubmit = async () => {
    try {
      const res = await api.post('/billing/delete-range', {
        dateFrom,
        dateTo,
        reason: reason.trim(),
        expected_count: preview.bill_count,
        expected_total: Number(preview.total_amount),
      });
      onDeleted(res.message || `Deleted ${preview.bill_count} bills. Stock was not returned.`);
    } catch (err) {
      // A bill was rung up, returned or deleted in this range since the
      // preview. Preview again, so the owner confirms what the range holds now.
      if (err.code === 'RANGE_CHANGED') setAttempt((n) => n + 1);
      throw err;
    }
  };

  const canConfirm = datesReady && preview && preview.bill_count > 0 && !deletionBlockedReason(preview);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title="Delete bills by date"
      description="Permanently deletes every bill rung up on these days. Stock is not returned."
      submitLabel="Delete bills"
      onSubmit={handleSubmit}
      submitBlockedReason={blockedReason}
    >
      <div className="grid gap-s3 sm:grid-cols-2">
        <Field label="From date" required>
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Field>
        <Field label="To date" required>
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Field>
      </div>

      {datesReady && <DeletionSummary preview={preview} error={previewError} />}

      <Field label="Reason" required hint="(kept in the audit log)">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Test bills from the setup week"
          maxLength={500}
        />
      </Field>

      {canConfirm && (
        <Field label={`Type ${preview.bill_count} to confirm`} required>
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={typed}
            onChange={(e) => setConfirmation({ key: currentKey, typed: e.target.value })}
          />
        </Field>
      )}
    </FormDialog>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-s3">
      <dt className="text-base text-muted-foreground">{label}</dt>
      <dd className="text-base text-foreground">{value}</dd>
    </div>
  );
}
