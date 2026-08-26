import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { count, date, plural, shortDate } from '../../lib/format';
import PageHeader from '../../patterns/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';
import Field from '../../ui/Field';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Table from '../../ui/Table';
import ErrorState from '../../ui/ErrorState';
import { SkeletonRows } from '../../ui/Skeleton';
import { Money, Qty } from '../../domain/Money';
import { StockBadge, PurchaseStatusBadge } from '../../domain/StatusBadge';
import {
  StatTile,
  RevenueTrendCard,
  PaymentTrendCard,
  MarginLeadersCard,
  StockHealthCard,
  PurchaseFlowCard,
  PAYMENT_SERIES,
  zeroFillDays,
} from '../../domain/charts';

const TABS = [
  { value: 'sales', label: 'Sales', dated: true },
  { value: 'margins', label: 'Margins', dated: false },
  { value: 'inventory', label: 'Inventory', dated: false },
  { value: 'purchases', label: 'Purchases', dated: true },
];

const firstOfMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
};

export default function ReportsPage() {
  const [tab, setTab] = useState('sales');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState('day');

  // Which tab the current `data` belongs to. A date change refetches while
  // the previous render holds at reduced opacity (no skeleton flash); a TAB
  // change must drop the data — the shapes differ and stale rows from
  // another report would render garbage.
  const dataTabRef = useRef(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (dataTabRef.current !== tab) setData(null);
    const params = new URLSearchParams({ dateFrom, dateTo, groupBy });
    const endpoints = {
      sales: `/reports/sales?${params}`,
      margins: '/reports/margins',
      inventory: '/reports/inventory',
      purchases: `/reports/purchases?${params}`,
    };
    try {
      const res = await api.get(endpoints[tab]);
      dataTabRef.current = tab;
      setData(res.data.report || res.data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [tab, dateFrom, dateTo, groupBy]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const activeTab = TABS.find((t) => t.value === tab);
  const refreshing = loading && !!data;

  return (
    <div>
      <PageHeader title="Reports" subtitle="Sales, margins, stock and purchasing" />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
          ))}
        </TabsList>

        {activeTab?.dated && (
          <div className="mt-s4 grid gap-s3 sm:grid-cols-3 sm:max-w-[36rem]">
            <Field label="From date">
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </Field>
            <Field label="To date">
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </Field>
            {tab === 'sales' && (
              <Field label="Group by">
                <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                </Select>
              </Field>
            )}
          </div>
        )}

        <TabsContent value={tab}>
          {error ? (
            <ErrorState title="Couldn't load this report" message={error.message} onRetry={fetchReport} />
          ) : loading && !data ? (
            <SkeletonRows count={6} />
          ) : !data ? null : (
            <>
              {tab === 'sales' && <SalesReport data={data} dimmed={refreshing} />}
              {tab === 'margins' && <MarginsReport data={data} dimmed={refreshing} />}
              {tab === 'inventory' && <InventoryReport data={data} />}
              {tab === 'purchases' && <PurchasesReport data={data} dimmed={refreshing} />}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatGrid({ children }) {
  return <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-3">{children}</div>;
}

function SalesReport({ data, dimmed }) {
  const totals = data.totals || {};
  const isDay = (data.groupBy || 'day') === 'day';
  const xKey = isDay ? 'sale_date' : 'period';
  const formatX = isDay ? shortDate : (v) => v;
  // Zero-fill quiet days so the axis never lies — but only when there is
  // anything at all: a fully empty range keeps its honest empty state.
  const hasRows = (data.rows || []).length > 0;
  const rows = hasRows && isDay
    ? zeroFillDays(data.rows, data.dateFrom, data.dateTo)
    : (data.rows || []);

  return (
    <>
      <StatGrid>
        <StatTile label="Total revenue" trend={rows} trendKey="total_revenue">
          <Money value={totals.total_revenue} whole className="text-md" />
        </StatTile>
        <StatTile label="Bills" trend={rows} trendKey="bill_count">
          <span className="tabular text-md font-bold text-foreground">{count(totals.bill_count)}</span>
        </StatTile>
        {PAYMENT_SERIES.map((s) => (
          <StatTile key={s.mode} label={s.name} trend={rows} trendKey={s.key} trendColor={s.color}>
            <Money value={totals[s.key]} whole className="text-md" />
          </StatTile>
        ))}
      </StatGrid>

      <div className="mb-s4 grid gap-s4 xl:grid-cols-2">
        <RevenueTrendCard
          rows={rows}
          xKey={xKey}
          formatX={formatX}
          title="Revenue over time"
          dimmed={dimmed}
        />
        <PaymentTrendCard rows={rows} xKey={xKey} formatX={formatX} dimmed={dimmed} />
      </div>

      <Table
        columns={[
          { key: 'period', label: 'Period', render: (r) => r.sale_date ? date(r.sale_date) : r.period },
          { key: 'bill_count', label: 'Bills', numeric: true, render: (r) => count(r.bill_count) },
          { key: 'total_revenue', label: 'Revenue', numeric: true, render: (r) => <Money value={r.total_revenue} whole /> },
          ...PAYMENT_SERIES.map((s) => ({
            key: s.key,
            label: s.name,
            numeric: true,
            render: (r) => <Money value={r[s.key]} whole />,
          })),
        ]}
        rows={rows.map((r, i) => ({ ...r, id: r.sale_date || r.period || i }))}
        caption="Revenue and payment split by period"
        emptyTitle="No sales in this date range"
        emptyBody="Widen the dates, or check a period when the shop was open."
      />
    </>
  );
}

function MarginsReport({ data, dimmed }) {
  const summary = data.summary || {};
  return (
    <>
      <StatGrid>
        {/* No sparklines: margin_analytics has no date column, so there is no
            series to draw — the card below says "all time" for the same reason. */}
        <StatTile label="Total margin earned">
          <Money value={summary.total_margin} whole className="text-md" />
        </StatTile>
        <StatTile label="Average margin">
          <span className="tabular text-md font-bold text-foreground">
            {parseFloat(summary.avg_margin_pct || 0).toFixed(1)}%
          </span>
        </StatTile>
        <StatTile label="Units sold">
          <span className="tabular text-md font-bold text-foreground">{count(summary.total_qty_sold)}</span>
        </StatTile>
      </StatGrid>

      <MarginLeadersCard medicines={data.medicines} dimmed={dimmed} className="mb-s4" />

      <Table
        columns={[
          {
            key: 'medicine_name',
            label: 'Medicine',
            render: (m) => (
              <div className="flex flex-col">
                <span className="font-bold text-foreground">{m.medicine_name}</span>
                <span className="text-muted-foreground">
                  {plural(m.times_sold, 'bill')} · {count(m.total_qty_sold)} units
                </span>
              </div>
            ),
          },
          { key: 'total_margin_earned', label: 'Margin earned', numeric: true, render: (m) => <Money value={m.total_margin_earned} tone="ok" /> },
          {
            key: 'avg_margin_pct',
            label: 'Margin %',
            numeric: true,
            render: (m) => <span className="tabular">{parseFloat(m.avg_margin_pct || 0).toFixed(1)}%</span>,
          },
        ]}
        rows={(data.medicines || []).map((m, i) => ({ ...m, id: m.medicine_id || i }))}
        caption="Margin earned per medicine"
        emptyTitle="No margin data yet"
        emptyBody="Margins are calculated from completed sales. Once bills are rung up, they'll show here."
      />
    </>
  );
}

function InventoryReport({ data }) {
  const summary = data.summary || {};
  const needsAttention = (data.medicines || []).filter((m) => m.is_low_stock || m.total_stock <= 0);

  return (
    <>
      <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
        <StatTile label="Medicines stocked">
          <span className="tabular text-md font-bold text-foreground">{count(summary.total_medicines)}</span>
        </StatTile>
        <StatTile label="Healthy">
          <span className="tabular text-md font-bold text-success">{count(summary.healthy)}</span>
        </StatTile>
        <StatTile label="Low stock">
          <span className="tabular text-md font-bold text-warning">{count(summary.low_stock)}</span>
        </StatTile>
        <StatTile label="Out of stock">
          <span className="tabular text-md font-bold text-destructive">{count(summary.out_of_stock)}</span>
        </StatTile>
      </div>

      <StockHealthCard
        summary={summary}
        subtitle="Whole catalogue right now — near-expiry is tracked separately on the Expiry page"
        className="mb-s4"
      />

      <h2 className="mb-s2 text-sm font-bold text-foreground">Needs reordering</h2>
      <Table
        columns={[
          {
            key: 'name',
            label: 'Medicine',
            render: (m) => (
              <div className="flex flex-col">
                <span className="font-bold text-foreground">{m.name}</span>
                <span className="text-muted-foreground">{m.category_name}</span>
              </div>
            ),
          },
          { key: 'total_stock', label: 'On hand', numeric: true, render: (m) => <Qty value={m.total_stock} unit={m.unit} /> },
          { key: 'status', label: 'Status', render: (m) => <StockBadge medicine={m} /> },
        ]}
        rows={needsAttention.map((m, i) => ({ ...m, id: m.id || i }))}
        caption="Medicines at or below their reorder threshold"
        emptyTitle="All stock levels healthy"
        emptyBody="Nothing is at or below its reorder threshold right now."
      />
    </>
  );
}

function PurchasesReport({ data, dimmed }) {
  const summary = data.summary || {};
  return (
    <>
      <StatGrid>
        <StatTile label="Orders raised">
          <span className="tabular text-md font-bold text-foreground">{count(summary.total_orders)}</span>
        </StatTile>
        <StatTile label="Value ordered">
          <Money value={summary.total_ordered} whole className="text-md" />
        </StatTile>
        <StatTile label="Value received">
          <Money value={summary.total_received} whole className="text-md" />
        </StatTile>
      </StatGrid>

      <PurchaseFlowCard purchases={data.purchases} dimmed={dimmed} className="mb-s4" />

      <Table
        columns={[
          {
            key: 'purchase_number',
            label: 'Order',
            render: (p) => (
              <div className="flex flex-col">
                <span className="font-mono font-bold text-foreground">{p.purchase_number}</span>
                <span className="text-muted-foreground">{p.supplier_name}</span>
              </div>
            ),
          },
          { key: 'status', label: 'Status', render: (p) => <PurchaseStatusBadge status={p.status} variant="solid" /> },
          {
            key: 'total',
            label: 'Value',
            numeric: true,
            render: (p) => <Money value={p.received_total || p.ordered_total} whole />,
          },
        ]}
        rows={(data.purchases || []).map((p, i) => ({ ...p, id: p.id || i }))}
        caption="Purchase orders in this date range"
        emptyTitle="No purchase orders in this date range"
        emptyBody="Widen the dates, or raise an order from the Purchase orders page."
      />
    </>
  );
}
