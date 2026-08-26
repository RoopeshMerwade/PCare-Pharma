import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { count, dateTime } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import Card, { CardBody } from '../../ui/Card';
import Input from '../../ui/Input';
import Field from '../../ui/Field';
import { Dialog, DialogContent, DialogHeader, DialogBody } from '../../ui/Dialog';
import { SkeletonRows } from '../../ui/Skeleton';
import { Money } from '../../domain/Money';
import { PaymentBadge } from '../../domain/StatusBadge';

const PAYMENT_MODES = [
  { value: '', label: 'All payment modes' },
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'credit', label: 'Credit' },
  { value: 'card', label: 'Card' },
];

export default function BillsListPage() {
  const { isOwner } = useAuth();
  const [selected, setSelected] = useState(null);
  const [summary, setSummary] = useState(null);

  const resource = useResource({
    endpoint: '/billing',
    initialFilters: { search: '', paymentMode: '', dateFrom: '', dateTo: '' },
    select: (res) => ({ rows: res.data.bills, pagination: res.data.pagination }),
  });

  useEffect(() => {
    if (!isOwner) return;
    const today = new Date().toISOString().slice(0, 10);
    api.get(`/billing/totals?dateFrom=${today}&dateTo=${today}`)
      .then((r) => setSummary(r.data.summary))
      .catch(() => {});
  }, [isOwner]);

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
            <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
              <SkeletonRows count={1} />
            </div>
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

      <BillDetailDialog bill={selected} open={Boolean(selected)} onOpenChange={(next) => { if (!next) setSelected(null); }} />
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

function BillDetailDialog({ bill, open, onOpenChange }) {
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

          <dl className="flex flex-col gap-s1 border-t border-border pt-s3">
            <Row label="Subtotal" value={<Money value={b.subtotal} />} />
            {discount > 0 && <Row label="Discount" value={<Money value={-discount} tone="ok" />} />}
            <div className="flex items-baseline justify-between gap-s3 pt-s1">
              <dt className="text-sm font-bold text-foreground">Total</dt>
              <dd><Money value={b.total} className="text-md" /></dd>
            </div>
          </dl>

          <p className="mt-s3 text-base text-muted-foreground">
            Bills are permanent once created. If something needs correcting, raise a customer return instead.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
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
