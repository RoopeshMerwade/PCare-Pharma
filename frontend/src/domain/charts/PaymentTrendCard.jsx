import ChartCard from '../../ui/charts/ChartCard';
import BarSeriesChart from '../../ui/charts/BarSeriesChart';
import { money, moneyCompact, shortDate, date } from '../../lib/format';
import { Money } from '../Money';
import { PAYMENT_SERIES } from './series';

/* ═══════════════════════════════════════════════════════════════════════════
   PaymentTrendCard — how the cash / UPI / credit / card mix moves over time:
   stacked columns, one column per period, segments in the fixed entity
   slots from series.js (the same colours the dashboard mix bar teaches).

   Four adjacent series is legend-mandatory and inline-label-free — interior
   stacked segments have no free end, so the legend, the one-tooltip-every-
   series readout and the data table carry the values. That table is also
   the obligatory contrast relief for the light-mode slots 3–4.
   ═══════════════════════════════════════════════════════════════════════════ */

const formatMoney = (v) => money(v);

export default function PaymentTrendCard({
  rows,
  title = 'Payment mix over time',
  subtitle,
  xKey = 'sale_date',
  formatX = shortDate,
  height = 260,
  dimmed = false,
  className,
}) {
  const data = rows || [];
  const isDay = xKey === 'sale_date';

  const columns = [
    { key: xKey, label: isDay ? 'Day' : 'Period', render: (r) => (isDay ? date(r[xKey]) : r[xKey]) },
    ...PAYMENT_SERIES.map((s) => ({
      key: s.key,
      label: s.name,
      numeric: true,
      render: (r) => <Money value={r[s.key]} whole />,
    })),
  ];

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      height={height}
      empty={!data.length}
      emptyTitle="No sales in this window"
      emptyBody="Widen the dates, or check a period when the shop was open."
      table={{
        columns,
        rows: data.map((r) => ({ ...r, id: r[xKey] })),
        caption: `${title} — data table`,
      }}
      className={className}
    >
      <BarSeriesChart
        data={data}
        xKey={xKey}
        series={PAYMENT_SERIES}
        stacked
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
