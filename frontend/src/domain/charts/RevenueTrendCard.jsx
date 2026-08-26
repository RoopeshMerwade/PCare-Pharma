import ChartCard from '../../ui/charts/ChartCard';
import TrendChart from '../../ui/charts/TrendChart';
import { money, moneyCompact, shortDate, count, date } from '../../lib/format';
import { Money } from '../Money';
import { REVENUE_COLOR } from './series';

/* ═══════════════════════════════════════════════════════════════════════════
   RevenueTrendCard — total revenue over time. One series, so: area with a
   10% wash, the accent colour (not a categorical slot), and no legend box —
   the title names it. Rows must arrive zero-filled (the dashboard trend is
   filled server-side; the reports page fills via zeroFillDays) so quiet days
   plot as ₹0. The data table is the accessible twin of the chart.
   ═══════════════════════════════════════════════════════════════════════════ */

const formatMoney = (v) => money(v);

export default function RevenueTrendCard({
  rows,
  title,
  subtitle,
  xKey = 'sale_date',
  formatX = shortDate,     // axis ticks; the table shows the full date
  height = 260,
  dimmed = false,
  emptyTitle = 'No sales in this window',
  emptyBody = 'Widen the dates, or check a period when the shop was open.',
  className,
}) {
  const data = rows || [];
  const isDay = xKey === 'sale_date';

  const columns = [
    {
      key: xKey,
      label: isDay ? 'Day' : 'Period',
      render: (r) => (isDay ? date(r[xKey]) : r[xKey]),
    },
    { key: 'bill_count', label: 'Bills', numeric: true, render: (r) => count(r.bill_count) },
    { key: 'total_revenue', label: 'Revenue', numeric: true, render: (r) => <Money value={r.total_revenue} whole /> },
  ];

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      height={height}
      empty={!data.length}
      emptyTitle={emptyTitle}
      emptyBody={emptyBody}
      table={{
        columns,
        rows: data.map((r) => ({ ...r, id: r[xKey] })),
        caption: `${title} — data table`,
      }}
      className={className}
    >
      <TrendChart
        data={data}
        xKey={xKey}
        series={[{ key: 'total_revenue', name: 'Revenue', color: REVENUE_COLOR }]}
        area
        height={height}
        dimmed={dimmed}
        label={title}
        formatValue={formatMoney}
        formatAxisValue={moneyCompact}
        formatXLabel={formatX}
      />
    </ChartCard>
  );
}
