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
import { StatTile, PaymentMixCard, RevenueTrendCard, PAYMENT_SERIES, deltaVs, shareOf } from '../../domain/charts';
import { AlertIcon, ClockIcon, PillIcon, ReturnIcon, UsersIcon } from '../../ui/icons';
import StaffAttendanceCard from './StaffAttendanceCard';
import StockRequisitionsCard from './StockRequisitionsCard';

/* The densest colour usage in the app sits in the alert stack below. It is the
   one screen where the danger and warning ramps added in the token work earn
   their place: before them, "3 patients overdue for a refill" and "Today's
   sales" were rendered in variations of the same accent. */

export default function OwnerDashboard() {
  const navigate = useNavigate();
  const [dash, setDash] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/dashboard/owner');
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
        <PageHeader title="Dashboard" subtitle={longDate()} />
        <ErrorState title="Couldn't load today's figures" message={error.message} onRetry={fetchDashboard} />
      </div>
    );
  }

  // First load only — a refetch (retry) keeps the previous render up.
  if (loading && !dash) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle={longDate()} />
        <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((n) => <Skeleton key={n} className="h-24 rounded-card" />)}
        </div>
        <SkeletonRows count={4} />
      </div>
    );
  }

  if (!dash) return null;

  const { today, week, month, alerts, top_medicines, attendance, requisitions } = dash;
  const trendRows = dash.trend?.rows || [];
  const yesterday = dash.yesterday;
  const hasAlerts =
    alerts.low_stock?.length > 0 ||
    alerts.near_expiry?.length > 0 ||
    alerts.pending_customer_returns > 0 ||
    alerts.overdue_refills?.length > 0;

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`${longDate()} · how the pharmacy is doing`} />

      <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
        <StatTile
          label="Sales today"
          sub={plural(today.bill_count, 'bill')}
          delta={deltaVs(today.total_sales, yesterday?.total_sales)}
          deltaLabel="vs yesterday"
          trend={trendRows}
          trendKey="total_revenue"
        >
          <Money value={today.total_sales} whole className="text-lg" />
        </StatTile>
        {/* Cash / UPI / Credit come off the fixed entity→slot map, so each
            tile's sparkline wears the same colour that mode has in the mix
            bar and the reports stack. Card is in the payload but not a
            headline tile — the mix bar below surfaces it. */}
        {PAYMENT_SERIES.filter((s) => s.mode !== 'card').map((s) => {
          const value = today.payment_breakdown?.[s.mode];
          const share = shareOf(value, today.total_sales);
          return (
            <StatTile
              key={s.mode}
              label={`${s.name} today`}
              sub={share == null ? undefined : `${Math.round(share)}% of sales`}
              trend={trendRows}
              trendKey={s.key}
              trendColor={s.color}
            >
              <Money value={value} whole className="text-lg" />
            </StatTile>
          );
        })}
      </div>

      <div className="mb-s4 grid grid-cols-2 gap-s3">
        {/* No sparklines here on purpose: no weekly series exists in the
            payload, and a trend a chart invents is worse than none. */}
        <StatTile label="This week" sub={plural(week.bill_count, 'bill')}>
          <Money value={week.total_sales} whole className="text-lg" />
        </StatTile>
        <StatTile label="This month" sub={plural(month.bill_count, 'bill')}>
          <Money value={month.total_sales} whole className="text-lg" />
        </StatTile>
      </div>

      <div className="mb-s5 grid gap-s4 lg:grid-cols-3">
        <RevenueTrendCard
          rows={trendRows}
          title="Revenue, last 14 days"
          subtitle="Quiet days plot as ₹0 — they never disappear"
          className="lg:col-span-2"
        />
        <PaymentMixCard breakdown={today.payment_breakdown} />
      </div>

      <div className="grid gap-s4 lg:grid-cols-3">
        <div className="flex flex-col gap-s4 lg:col-span-2">
          {hasAlerts ? (
            <section aria-labelledby="needs-attention">
              <h2 id="needs-attention" className="mb-s2 text-sm font-bold text-foreground">Needs attention</h2>
              <div className="flex flex-col gap-s3">
                {alerts.pending_customer_returns > 0 && (
                  <Card
                    onClick={() => navigate('/customer-returns')}
                    className="overflow-hidden border border-border bg-card shadow-1 transition-all hover:border-border-strong hover:shadow-2"
                  >
                    <div className="flex items-center justify-between gap-s3 px-s4 py-s3">
                      <div className="flex items-center gap-s3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-warning-wash text-warning-ink">
                          <ReturnIcon className="h-4 w-4" />
                        </span>
                        <div>
                          <div className="flex items-center gap-s2">
                            <span className="text-base font-bold text-foreground">
                              Customer returns awaiting review
                            </span>
                            <Badge tone="low">
                              {plural(alerts.pending_customer_returns, 'return')}
                            </Badge>
                          </div>
                          <span className="text-base text-muted-foreground">
                            Staff cannot complete refunds until you approve them.
                          </span>
                        </div>
                      </div>
                      <span className="text-base font-bold text-accent">Review →</span>
                    </div>
                  </Card>
                )}

                {alerts.overdue_refills?.length > 0 && (
                  <Card className="overflow-hidden border border-border bg-card shadow-1">
                      <div className="flex items-center justify-between gap-s2 border-b border-border px-s4 py-s3">
                        <div className="flex min-w-0 items-center gap-s2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-destructive-wash text-destructive">
                            <UsersIcon className="h-4 w-4" />
                          </span>
                          <span className="whitespace-nowrap text-base font-bold text-foreground">Patients overdue for refill</span>
                        </div>
                        <Badge tone="critical" className="shrink-0">
                          {plural(alerts.overdue_refills.length, 'patient')}
                        </Badge>
                      </div>
                    <ul className="divide-y divide-border">
                      {alerts.overdue_refills.slice(0, 4).map((r, i) => (
                        <li key={i} className="flex min-h-target items-center justify-between gap-s3 px-s4 py-s2 transition-colors hover:bg-muted/40">
                          <div className="min-w-0">
                            <span className="block truncate text-base font-bold text-foreground">{r.customer_name}</span>
                            <span className="block text-base text-muted-foreground">{r.medicine_name}</span>
                          </div>
                          <Badge tone="critical">
                            {plural(r.days_since_last_purchase, 'day')} late
                          </Badge>
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center justify-between gap-s2 border-t border-border bg-muted/20 px-s4 py-s2 text-base text-muted-foreground">
                      <span className="min-w-0 truncate">Worth a check-in call — treatment may be interrupted.</span>
                      <button
                        type="button"
                        onClick={() => navigate('/customers')}
                        className="shrink-0 whitespace-nowrap font-bold text-accent hover:underline"
                      >
                        View patients →
                      </button>
                    </div>
                  </Card>
                )}

                <div className="grid gap-s3 sm:grid-cols-2">
                  {alerts.low_stock?.length > 0 && (
                    <Card className="overflow-hidden border border-border bg-card shadow-1">
                      <div className="flex items-center justify-between gap-s2 border-b border-border px-s4 py-s3">
                        <div className="flex min-w-0 items-center gap-s2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-warning-wash text-warning-ink">
                            <AlertIcon className="h-4 w-4" />
                          </span>
                          <span className="whitespace-nowrap text-base font-bold text-foreground">Running low</span>
                        </div>
                        <Badge tone="low" className="shrink-0">
                          {plural(alerts.low_stock_count ?? alerts.low_stock.length, 'medicine')}
                        </Badge>
                      </div>
                      <ul className="divide-y divide-border">
                        {alerts.low_stock.slice(0, 4).map((m) => {
                          const isZero = Number(m.total_stock) === 0;
                          return (
                            <li
                              key={m.id}
                              onClick={() => navigate(`/inventory?search=${encodeURIComponent(m.name)}`)}
                              className="flex min-h-target items-center justify-between gap-s3 px-s4 py-s2 cursor-pointer transition-colors hover:bg-muted/40"
                            >
                              <div className="flex min-w-0 items-center gap-s2">
                                <span
                                  className={cn(
                                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-pill',
                                    isZero ? 'bg-destructive-wash text-destructive' : 'bg-warning-wash text-warning-ink'
                                  )}
                                >
                                  <PillIcon className="h-3.5 w-3.5" />
                                </span>
                                <span className="truncate text-base font-bold text-foreground">{m.name}</span>
                              </div>
                              <div className="shrink-0">
                                {isZero ? (
                                  <Badge tone="critical">
                                    0 {m.unit || 'units'}
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
                      <div className="flex items-center justify-between gap-s2 border-t border-border bg-muted/20 px-s4 py-s2 text-base text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => navigate('/inventory?stock=low')}
                          className="min-w-0 truncate font-bold text-accent hover:underline"
                        >
                          View all ({alerts.low_stock_count ?? alerts.low_stock.length}) →
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate('/purchases')}
                          className="shrink-0 whitespace-nowrap font-bold text-accent hover:underline"
                        >
                          New order →
                        </button>
                      </div>
                    </Card>
                  )}

                  {alerts.near_expiry?.length > 0 && (
                    <Card className="overflow-hidden border border-border bg-card shadow-1">
                      <div className="flex items-center justify-between gap-s2 border-b border-border px-s4 py-s3">
                        <div className="flex min-w-0 items-center gap-s2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-destructive-wash text-destructive">
                            <ClockIcon className="h-4 w-4" />
                          </span>
                          <span className="whitespace-nowrap text-base font-bold text-foreground">Expiring soon</span>
                        </div>
                        <Badge tone="critical" className="shrink-0">
                          {plural(alerts.near_expiry_count ?? alerts.near_expiry.length, 'batch', 'batches')}
                        </Badge>
                      </div>
                      <ul className="divide-y divide-border">
                        {alerts.near_expiry.slice(0, 4).map((b, i) => {
                          const isUrgent = b.days_to_expiry <= 7;
                          return (
                            <li
                              key={i}
                              onClick={() => navigate('/expiry')}
                              className="flex min-h-target items-center justify-between gap-s3 px-s4 py-s2 cursor-pointer transition-colors hover:bg-muted/40"
                            >
                              <div className="min-w-0">
                                <span className="block truncate text-base font-bold text-foreground">{b.medicine_name}</span>
                                {b.batch_no && (
                                  <span className="block font-mono text-base text-muted-foreground">Batch {b.batch_no}</span>
                                )}
                              </div>
                              <div className="shrink-0">
                                <Badge tone={isUrgent ? 'critical' : 'low'}>
                                  {plural(b.days_to_expiry, 'day')} left
                                </Badge>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="flex items-center justify-between gap-s2 border-t border-border bg-muted/20 px-s4 py-s2 text-base text-muted-foreground">
                        <span className="min-w-0 truncate">Sell nearest expiry first (FEFO)</span>
                        <button
                          type="button"
                          onClick={() => navigate('/expiry')}
                          className="shrink-0 whitespace-nowrap font-bold text-accent hover:underline"
                        >
                          Manage expiry →
                        </button>
                      </div>
                    </Card>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <Card>
              <CardBody>
                <p className="text-base font-bold text-foreground">Nothing needs attention</p>
                <p className="mt-s1 text-base text-muted-foreground">
                  Stock levels are healthy, no batches are near expiry, and there are no returns waiting on you.
                </p>
              </CardBody>
            </Card>
          )}

          {/* Who is on the counter, above what they sold — the roster is the
              question an owner opens this page with in the morning, and the
              two belong next to each other. `staff_sales` below is live data
              about the same people, not a placeholder, so it stays. */}
          <StaffAttendanceCard initialRows={attendance?.rows} />

          {/* Module 30. Renders nothing when the queue is empty, so it is not
              wired into `hasAlerts` above: that flag gates a section whose
              children are each independently conditional, and adding a fifth
              condition without a fifth child would put a "Needs attention"
              heading over nothing. This card IS the alert. */}
          <StockRequisitionsCard initialRows={requisitions?.rows} onChanged={fetchDashboard} />

          {today.staff_sales?.length > 0 && (
            <section aria-labelledby="staff-sales">
              <div className="mb-s2 flex items-center justify-between">
                <h2 id="staff-sales" className="text-sm font-bold text-foreground">Counter sales today</h2>
                <span className="text-base text-muted-foreground">
                  {plural(today.staff_sales.length, 'person', 'people')} billing
                </span>
              </div>
              <Card>
                <ul className="divide-y divide-border">
                  {today.staff_sales.map((s) => (
                    <li
                      key={s.staff_id}
                      className="flex min-h-target items-center justify-between gap-s3 px-s3 py-s2 transition-colors hover:bg-muted/40 cursor-pointer"
                      onClick={() => navigate('/billing')}
                    >
                      <div className="min-w-0">
                        <span className="block truncate text-base font-bold text-foreground">{s.staff_name}</span>
                        <span className="block text-base text-muted-foreground">
                          {plural(s.bill_count, 'bill')} · {count(s.item_count)} items
                        </span>
                      </div>
                      <Money value={s.total_sales} whole className="text-base font-bold" />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {top_medicines?.length > 0 && (
            <section aria-labelledby="top-medicines">
              <h2 id="top-medicines" className="mb-s2 text-sm font-bold text-foreground">Top medicines this month</h2>
              <Card>
                <ul className="divide-y divide-border">
                  {top_medicines.map((m, idx) => (
                    <li key={m.medicine_id} className="flex min-h-target items-center gap-s3 px-s3 py-s2">
                      <span className="tabular w-6 shrink-0 text-base text-muted-foreground">{idx + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-base text-foreground">{m.name}</span>
                      <Qty value={m.total_qty} unit={m.unit} />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>

        <aside aria-labelledby="quick-actions">
          <h2 id="quick-actions" className="mb-s2 text-sm font-bold text-foreground">Quick actions</h2>
          <div className="flex flex-col gap-s2">
            <Button variant="primary" size="block" onClick={() => navigate('/billing/new')}>New bill</Button>
            <Button variant="secondary" size="block" onClick={() => navigate('/inventory')}>View inventory</Button>
            <Button variant="secondary" size="block" onClick={() => navigate('/reports')}>Reports</Button>
            <Button variant="secondary" size="block" onClick={() => navigate('/customers')}>Customers</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
