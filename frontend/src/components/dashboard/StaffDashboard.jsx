import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { count, longDate, plural } from '../../lib/format';
import PageHeader from '../../patterns/PageHeader';
import Card, { CardBody } from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import ErrorState from '../../ui/ErrorState';
import Skeleton, { SkeletonRows } from '../../ui/Skeleton';
import { Money, Qty } from '../../domain/Money';
import { PlusIcon, AlertIcon, PillIcon, ClipboardIcon } from '../../ui/icons';
import { RequisitionStatusBadge, RequisitionUrgencyBadge } from '../../domain/StatusBadge';
import StaffAttendanceWidget from './StaffAttendanceWidget';

export function StaffDashboard() {
  const navigate = useNavigate();
  const [dash, setDash] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/dashboard/staff');
      setDash(res.data.dashboard);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  if (error) {
    return (
      <div>
        <PageHeader title="Today's counter" subtitle={longDate()} />
        <ErrorState title="Couldn't load today's figures" message={error.message} onRetry={fetchDashboard} />
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Today's counter" subtitle={longDate()} />
        <div className="mb-s4 grid grid-cols-2 gap-s3">
          <Skeleton className="h-24 rounded-card" />
          <Skeleton className="h-24 rounded-card" />
        </div>
        <SkeletonRows count={3} />
      </div>
    );
  }

  if (!dash) return null;

  const { today, low_stock_alerts, pending_returns, pending_requisitions } = dash;

  return (
    <div className="flex flex-col gap-s5">
      <PageHeader title="Today's counter" subtitle={longDate()} />

      {/* First thing on the shift, above the day's figures. It owns its own
          fetch rather than riding the staff dashboard payload: checking in has
          to keep working even if something in the figures below fails. */}
      <StaffAttendanceWidget />

      <div className="grid grid-cols-2 gap-s3">
        <Card>
          <CardBody className="flex flex-col gap-s1">
            <span className="tabular text-lg font-bold text-foreground">{count(today.bill_count)}</span>
            <span className="text-base text-muted-foreground">Bills rung up today</span>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-s1">
            <span className="tabular text-lg font-bold text-foreground">{count(today.item_count)}</span>
            <span className="text-base text-muted-foreground">Items dispensed</span>
          </CardBody>
        </Card>
      </div>

      {/* The single most consequential action on this screen, and the only
          primary button on it (§3.1). */}
      <Button variant="primary" size="block" onClick={() => navigate('/billing/new')}>
        <PlusIcon className="h-5 w-5" />
        Start a new bill
      </Button>

      {low_stock_alerts?.length > 0 && (
        <section aria-labelledby="low-stock" className="flex flex-col gap-s2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-s2">
              <span className="flex h-6 w-6 items-center justify-center rounded-pill bg-warning-wash text-warning-ink">
                <AlertIcon className="h-3.5 w-3.5" />
              </span>
              <h2 id="low-stock" className="text-sm font-bold text-foreground">Running low</h2>
            </div>
            <Badge tone="low">
              {plural(dash.low_stock_count ?? low_stock_alerts.length, 'medicine')}
            </Badge>
          </div>

          <Card className="overflow-hidden border border-border">
            <ul className="divide-y divide-border">
              {low_stock_alerts.map((m, i) => {
                const isOutOfStock = Number(m.total_stock) === 0;
                return (
                  <li
                    key={i}
                    onClick={() => navigate(`/inventory?search=${encodeURIComponent(m.name)}`)}
                    className="flex min-h-target cursor-pointer items-center justify-between gap-s3 px-s3 py-s2 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex min-w-0 items-center gap-s2">
                      <span
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-pill',
                          isOutOfStock ? 'bg-destructive-wash text-destructive' : 'bg-warning-wash text-warning-ink'
                        )}
                      >
                        <PillIcon className="h-4 w-4" />
                      </span>
                      <span className="truncate text-base font-bold text-foreground">{m.name}</span>
                    </div>

                    <div className="shrink-0">
                      {isOutOfStock ? (
                        <Badge tone="critical">
                          Out of stock (0 {m.unit || 'units'})
                        </Badge>
                      ) : (
                        <Badge tone="low">
                          <Qty value={m.total_stock} unit={m.unit} />
                        </Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-s2 border-t border-border bg-warning-wash/50 px-s3 py-s2 text-base text-warning-ink">
              <div className="flex items-center gap-s2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-warning" />
                <span>Let the owner know if a customer asks for one of these medicines.</span>
              </div>
              <button
                type="button"
                onClick={() => navigate('/inventory?stock=low')}
                className="font-bold text-accent hover:underline"
              >
                View all ({dash.low_stock_count ?? low_stock_alerts.length}) →
              </button>
            </div>
          </Card>
        </section>
      )}

      <section aria-labelledby="my-bills">
        <h2 id="my-bills" className="mb-s2 text-sm font-bold text-foreground">My bills today</h2>
        {today.recent_bills?.length > 0 ? (
          <Card>
            <ul className="divide-y divide-border">
              {today.recent_bills.map((b) => (
                <li key={b.id} className="flex min-h-target items-center justify-between gap-s3 px-s3 py-s2">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-base font-bold text-foreground">{b.bill_number}</span>
                    <span className="block truncate text-base text-muted-foreground">{b.customer_name}</span>
                  </span>
                  <Money value={b.total} />
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card>
            <CardBody>
              <p className="text-base font-bold text-foreground">No sales yet today</p>
              <p className="mt-s1 text-base text-muted-foreground">
                They&rsquo;ll show up here as they&rsquo;re rung up.
              </p>
            </CardBody>
          </Card>
        )}
      </section>

      {/* Module 30. Sits below the bills because it is a status check, not a
          task — the action that creates one of these lives on the Stock
          requests page, and the button below is the way back to it. */}
      <section aria-labelledby="my-requisitions">
        <div className="mb-s2 flex items-center justify-between gap-s3">
          <h2 id="my-requisitions" className="text-sm font-bold text-foreground">My stock requests</h2>
          <Button variant="ghost" size="compact" onClick={() => navigate('/stock-requisitions')}>
            <ClipboardIcon className="h-4 w-4" />
            Request stock
          </Button>
        </div>
        {pending_requisitions?.length > 0 ? (
          <Card>
            <ul className="divide-y divide-border">
              {pending_requisitions.map((r) => (
                <li key={r.id} className="flex min-h-target flex-wrap items-center justify-between gap-s2 px-s3 py-s2">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-base font-bold text-foreground">
                      {r.requisition_number}
                    </span>
                    <span className="block truncate text-base text-muted-foreground">
                      {plural(r.item_count, 'medicine')}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-s1">
                    <RequisitionUrgencyBadge urgency={r.urgency} />
                    <RequisitionStatusBadge status={r.status} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card>
            <CardBody>
              <p className="text-base font-bold text-foreground">Nothing waiting on the owner</p>
              <p className="mt-s1 text-base text-muted-foreground">
                Noticed an empty shelf? Raise a request and the owner is told straight away.
              </p>
            </CardBody>
          </Card>
        )}
      </section>

      {pending_returns?.length > 0 && (
        <section aria-labelledby="pending-returns">
          <h2 id="pending-returns" className="mb-s2 text-sm font-bold text-foreground">Waiting on the owner</h2>
          <div className="rounded-card border border-warning/30 bg-warning-wash p-s3">
            <p className="text-base font-bold text-warning-ink">
              {plural(pending_returns.length, 'return')} pending approval
            </p>
            <ul className="mt-s2 flex flex-col gap-s1">
              {pending_returns.map((r) => (
                <li key={r.id} className="text-base text-warning-ink">
                  <span className="font-mono">{r.return_number}</span> · {r.customer_name}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

export default StaffDashboard;
