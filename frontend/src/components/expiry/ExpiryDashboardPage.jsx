import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { count, date, plural } from '../../lib/format';
import PageHeader from '../../patterns/PageHeader';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import Button from '../../ui/Button';
import Card, { CardBody } from '../../ui/Card';
import EmptyState from '../../ui/EmptyState';
import ErrorState from '../../ui/ErrorState';
import { SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { Money, Qty } from '../../domain/Money';

/* The four buckets the backend groups batches into. Tone is carried by the
   badge and by the word in the label — the tab itself is never distinguished
   by colour alone (A4). */
const BUCKETS = [
  { key: 'expired',  label: 'Expired',            tone: 'critical', blurb: 'Past their expiry date and still on the shelf.' },
  { key: 'critical', label: 'Expiring in 30 days', tone: 'critical', blurb: 'Sell, discount or return these first.' },
  { key: 'warning',  label: 'Expiring in 60 days', tone: 'low',      blurb: 'Worth planning around on the next order.' },
  { key: 'watch',    label: 'Expiring in 90 days', tone: 'low',      blurb: 'Nothing urgent — keep an eye on movement.' },
];

export default function ExpiryDashboardPage() {
  const toast = useToast();
  const writeOff = useConfirm();
  const bulkWriteOff = useConfirm();

  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bucket, setBucket] = useState('expired');

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/expiry/dashboard');
      setDashboard(res.data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  const summary = dashboard?.summary || {};
  const totals = dashboard?.totals || {};
  const batches = summary[bucket] || [];
  const expiredCount = summary.expired?.length || 0;
  const activeBucket = BUCKETS.find((b) => b.key === bucket);

  const handleWriteOff = async () => {
    const batch = writeOff.target;
    await api.patch(`/expiry/batch/${batch.id}/writeoff`);
    toast.success(`Batch ${batch.batch_no} written off.`);
    fetchDashboard();
  };

  const handleBulkWriteOff = async () => {
    const res = await api.post('/expiry/bulk-writeoff');
    toast.success(res.data?.message || `${plural(expiredCount, 'batch', 'batches')} written off.`);
    fetchDashboard();
  };

  return (
    <div>
      <PageHeader
        title="Expiry Tracker"
        subtitle="Batches approaching or past their expiry date"
        actions={
          <Button
            variant="destructive"
            onClick={() => bulkWriteOff.ask(true)}
            blockedReason={
              expiredCount === 0
                ? 'Nothing to write off — no expired batches are still holding stock.'
                : null
            }
          >
            Write off all expired
          </Button>
        }
      />

      {error ? (
        <ErrorState title="Couldn't load expiry data" message={error.message} onRetry={fetchDashboard} />
      ) : loading ? (
        <SkeletonRows count={5} />
      ) : (
        <>
          <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
            {BUCKETS.map((b) => {
              const n = (summary[b.key] || []).length;
              const active = bucket === b.key;
              return (
                <Card key={b.key} onClick={() => setBucket(b.key)} aria-pressed={active} className={cn(active && 'ring-2 ring-ring')}>
                  <CardBody className="flex flex-col gap-s1">
                    <span className="tabular text-lg font-bold text-foreground">{count(n)}</span>
                    <span className={cn('text-base font-bold', active ? 'text-accent' : 'text-muted-foreground')}>
                      {b.label}
                    </span>
                  </CardBody>
                </Card>
              );
            })}
          </div>

          {totals.potential_loss > 0 && (
            <div className="mb-s4 rounded-card border border-destructive/30 bg-destructive-wash p-s4">
              <p className="text-base font-bold text-destructive-ink">
                Value at risk: <Money value={totals.potential_loss} />
              </p>
              <p className="mt-s1 text-base text-destructive-ink">
                Cost of stock that will expire within 90 days unless it is sold or returned to the supplier.
              </p>
            </div>
          )}

          <h2 className="mb-s2 text-sm font-bold text-foreground">
            {activeBucket.label} — {plural(batches.length, 'batch', 'batches')}
          </h2>
          <p className="mb-s3 text-base text-muted-foreground">{activeBucket.blurb}</p>

          {batches.length === 0 ? (
            <EmptyState
              title={
                bucket === 'expired'
                  ? 'Nothing expired on the shelf'
                  : `Nothing ${activeBucket.label.toLowerCase()}`
              }
              body={
                bucket === 'expired'
                  ? 'Every batch currently in stock is still in date. This is where expired stock would appear so it can be written off.'
                  : 'No batches fall into this window right now. Check the other windows for anything that needs moving.'
              }
            />
          ) : (
            <ul className="flex flex-col gap-s2">
              {batches.map((batch) => (
                <li
                  key={batch.id}
                  className="flex flex-wrap items-start justify-between gap-s3 rounded-card border border-border bg-card p-s3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-bold text-foreground">{batch.medicine_name}</p>
                    <p className="mt-s1 font-mono text-base text-muted-foreground">{batch.batch_no}</p>
                    <p className="text-base text-muted-foreground">
                      {batch.days_to_expiry < 0
                        ? `Expired ${plural(Math.abs(batch.days_to_expiry), 'day')} ago`
                        : `Expires in ${plural(batch.days_to_expiry, 'day')}`}
                      {' · '}{date(batch.exp_date)}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-s1">
                    <Qty value={batch.stock_qty} unit={batch.unit} />
                    <span className="text-base text-muted-foreground">
                      <Money value={batch.potential_loss_value} tone="critical" /> at risk
                    </span>
                    {bucket === 'expired' && batch.stock_qty > 0 && (
                      <Button variant="destructive" size="compact" onClick={() => writeOff.ask(batch)}>
                        Write off
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        {...writeOff.props}
        destructive
        title={`Write off batch ${writeOff.target?.batch_no}?`}
        body={`This removes the ${writeOff.target?.stock_qty} ${writeOff.target?.unit} remaining in this batch of ${writeOff.target?.medicine_name} from sellable stock and records the loss. The ledger keeps the history, but the stock can't be restored except by a fresh adjustment.`}
        confirmLabel="Write off batch"
        onConfirm={handleWriteOff}
      />

      <ConfirmDialog
        {...bulkWriteOff.props}
        destructive
        title={`Write off all ${expiredCount} expired ${expiredCount === 1 ? 'batch' : 'batches'}?`}
        body="Every expired batch still holding stock is written off in one go, and each write-off is recorded separately on the ledger. This cannot be undone."
        confirmLabel={`Write off ${expiredCount} ${expiredCount === 1 ? 'batch' : 'batches'}`}
        onConfirm={handleBulkWriteOff}
      />
    </div>
  );
}
