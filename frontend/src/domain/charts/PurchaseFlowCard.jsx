import ChartCard from '../../ui/charts/ChartCard';
import BarSeriesChart from '../../ui/charts/BarSeriesChart';
import { CHART_SERIES } from '../../ui/charts';
import { money, moneyCompact } from '../../lib/format';
import { Money } from '../Money';
import { bucketByMonth, monthLabel } from './series';

/* ═══════════════════════════════════════════════════════════════════════════
   PurchaseFlowCard — value ordered vs value received, grouped columns by
   month. Both series are ₹ on ONE axis (never a dual-axis chart). Two
   entities ⇒ slots 1 and 2, with a legend, and the gap between what was
   ordered and what actually arrived is the story the pairing tells.
   ═══════════════════════════════════════════════════════════════════════════ */

const SERIES = [
  { key: 'ordered_total',  name: 'Ordered',  color: CHART_SERIES[0] },
  { key: 'received_total', name: 'Received', color: CHART_SERIES[1] },
];

const formatWhole = (v) => money(v, { whole: true });

export default function PurchaseFlowCard({
  purchases,
  title = 'Ordered vs received',
  subtitle = 'By month raised, within the dates above',
  height = 260,
  dimmed = false,
  className,
}) {
  const rows = bucketByMonth(purchases, 'created_at', ['ordered_total', 'received_total']);

  const columns = [
    { key: 'month', label: 'Month', render: (r) => monthLabel(r.month) },
    { key: 'ordered_total', label: 'Ordered', numeric: true, render: (r) => <Money value={r.ordered_total} whole /> },
    { key: 'received_total', label: 'Received', numeric: true, render: (r) => <Money value={r.received_total} whole /> },
  ];

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      height={height}
      empty={!rows.length}
      emptyTitle="No purchase orders in this date range"
      emptyBody="Widen the dates, or raise an order from the Purchase orders page."
      table={{
        columns,
        rows: rows.map((r) => ({ ...r, id: r.month })),
        caption: 'Ordered vs received by month — data table',
      }}
      className={className}
    >
      <BarSeriesChart
        data={rows}
        xKey="month"
        series={SERIES}
        height={height}
        dimmed={dimmed}
        label={title}
        formatValue={formatWhole}
        formatAxisValue={moneyCompact}
        formatXLabel={monthLabel}
      />
    </ChartCard>
  );
}
