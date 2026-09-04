import ChartCard from '../../ui/charts/ChartCard';
import { Qty } from '../Money';
import { cn } from '../../lib/cn';
import { num, shareOf } from './series';

/* ═══════════════════════════════════════════════════════════════════════════
   TopMedicinesCard — top medicines by quantity sold, as ranked proportion bars.

   Deliberately plain HTML, not recharts, for the same reason PaymentMixCard
   is: this card lives in the 1/3 rail. A recharts horizontal bar spends ~140px
   on the category gutter and ~64px on the value labels before a single bar is
   drawn, which at rail width leaves the bars a sliver and truncates every
   medicine name to "Test Concurrenc…". Turned vertical, each name gets the
   FULL card width on its own line and the bar below it is pure magnitude —
   the one arrangement that gets wider, not narrower, as names get longer.

   Medicine names are NOMINAL categories, so every bar takes the same slot-1
   hue (MarginLeadersCard's rule): length already encodes magnitude, and
   shading by rank would re-encode it. Bars are aria-hidden decoration over
   the figure printed beside each name — every value is readable without
   hovering, which is also what discharges the light-mode contrast relief.

   Scaling is share-of-LEADER, not share-of-total: the question this card
   answers is "what outsells what", so the top seller fills the track and the
   rest read against it.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function TopMedicinesCard({
  medicines,
  limit = 5,
  title = 'Top selling medicines this month',
  subtitle = 'By quantity sold across all completed bills',
  className,
}) {
  const rows = (medicines || []).slice(0, limit).map((m) => ({
    id: m.medicine_id,
    name: m.name,
    unit: m.unit,
    total_qty: num(m.total_qty),
  }));

  // Share of the leader, so the top bar always fills the track.
  const max = rows.reduce((m, r) => Math.max(m, r.total_qty), 0);

  const columns = [
    { key: 'name', label: 'Medicine' },
    { key: 'total_qty', label: 'Qty sold', numeric: true, render: (r) => <Qty value={r.total_qty} unit={r.unit} /> },
  ];

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      height={rows.length * 44 + 24}
      empty={!rows.length}
      emptyTitle="No sales yet this month"
      emptyBody="Top-selling medicines will appear here automatically as sales are completed at the counter."
      table={{ columns, rows, caption: 'Quantity sold per medicine this month — data table' }}
      className={className}
    >
      <ol className="m-0 flex list-none flex-col gap-s3 p-0">
        {rows.map((r, idx) => (
          <li key={r.id || idx} className="flex flex-col gap-s1">
            <div className="flex items-baseline justify-between gap-s2">
              <span className="min-w-0 truncate text-base font-bold text-foreground" title={r.name}>
                {r.name}
              </span>
              <Qty value={r.total_qty} unit={r.unit} className="shrink-0" />
            </div>
            <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-pill bg-muted">
              <div
                className={cn('h-full rounded-pill bg-chart-1')}
                style={{ width: `${Math.max(shareOf(r.total_qty, max) ?? 0, 2)}%` }}
              />
            </div>
          </li>
        ))}
      </ol>
    </ChartCard>
  );
}
