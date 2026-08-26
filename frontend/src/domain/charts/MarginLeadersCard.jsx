import ChartCard from '../../ui/charts/ChartCard';
import BarSeriesChart from '../../ui/charts/BarSeriesChart';
import { CHART_SERIES } from '../../ui/charts';
import { money, moneyCompact } from '../../lib/format';
import { Money } from '../Money';
import { num, truncate } from './series';

/* ═══════════════════════════════════════════════════════════════════════════
   MarginLeadersCard — top medicines by margin earned, horizontal bars.

   Medicine names are NOMINAL categories: every bar takes the same slot-1
   hue. Colouring bars darker-where-bigger would re-encode what bar length
   already shows and fails the categorical checks by design. One series ⇒ no
   legend; the value rides each bar tip (the direct label), and the table
   carries names in full.

   margin_analytics has no date column, so this is ALL TIME — the subtitle
   says so rather than letting the page's date filters imply a scope the
   view cannot honour. Owner-only by the /reports authorize guard (A9).
   ═══════════════════════════════════════════════════════════════════════════ */

const SERIES = [{ key: 'total_margin_earned', name: 'Margin earned', color: CHART_SERIES[0] }];

const formatWhole = (v) => money(v, { whole: true });
const formatTick = (name) => truncate(name, 16);

export default function MarginLeadersCard({
  medicines,
  limit = 10,
  title = 'Top medicines by margin',
  subtitle = 'All time — margins are computed live from cost and sale price',
  dimmed = false,
  className,
}) {
  const rows = (medicines || []).slice(0, limit).map((m) => ({
    id: m.medicine_id,
    name: m.medicine_name,
    total_margin_earned: num(m.total_margin_earned),
    avg_margin_pct: num(m.avg_margin_pct),
  }));

  // Row height keeps ≤24px bars breathing; the container includes the axis band.
  const height = rows.length * 40 + 40;

  const columns = [
    { key: 'name', label: 'Medicine' },
    { key: 'total_margin_earned', label: 'Margin earned', numeric: true, render: (r) => <Money value={r.total_margin_earned} tone="ok" /> },
    { key: 'avg_margin_pct', label: 'Margin %', numeric: true, render: (r) => <span className="tabular">{r.avg_margin_pct.toFixed(1)}%</span> },
  ];

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      height={height}
      empty={!rows.length}
      emptyTitle="No margin data yet"
      emptyBody="Margins are calculated from completed sales. Once bills are rung up, the leaders show here."
      table={{ columns, rows, caption: 'Margin earned per medicine — data table' }}
      className={className}
    >
      <BarSeriesChart
        data={rows}
        xKey="name"
        series={SERIES}
        horizontal
        valueLabels
        height={height}
        dimmed={dimmed}
        label={title}
        formatValue={formatWhole}
        formatAxisValue={moneyCompact}
        formatXLabel={formatTick}
        formatTooltipLabel={(name) => name}
      />
    </ChartCard>
  );
}
