import ChartCard from '../../ui/charts/ChartCard';
import { CheckIcon, AlertIcon } from '../../ui/icons';
import { cn } from '../../lib/cn';
import { count } from '../../lib/format';
import { num, shareOf } from './series';

/* ═══════════════════════════════════════════════════════════════════════════
   StockHealthCard — healthy / low / out-of-stock as one composition bar.

   These segments MEAN good/bad, so they wear the STATUS tokens (success /
   warning / destructive), never categorical chart slots — and status never
   ships colour-alone: every row below carries its icon + label.

   `near_expiry` is deliberately NOT a fourth segment: a healthy-stock item
   can also be near expiry, so adding it would double-count and the bar
   would no longer sum to the catalogue. It stays a separate figure.
   ═══════════════════════════════════════════════════════════════════════════ */

const SEGMENTS = [
  { key: 'healthy',      name: 'Healthy',      barClass: 'bg-success',     ink: 'text-success',     Icon: CheckIcon },
  { key: 'low_stock',    name: 'Low stock',    barClass: 'bg-warning',     ink: 'text-warning',     Icon: AlertIcon },
  { key: 'out_of_stock', name: 'Out of stock', barClass: 'bg-destructive', ink: 'text-destructive', Icon: AlertIcon },
];

export default function StockHealthCard({
  summary,                 // { total_medicines, healthy, low_stock, out_of_stock }
  title = 'Stock health',
  subtitle,
  className,
}) {
  const segs = SEGMENTS.map((s) => ({ ...s, value: num(summary?.[s.key]) }));
  const total = segs.reduce((sum, s) => sum + s.value, 0);

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      empty={total <= 0}
      emptyTitle="No stock to summarise"
      emptyBody="Add medicines and receive stock, and the health split appears here."
      className={className}
    >
      <div aria-hidden="true" className="flex h-4 w-full gap-0.5 overflow-hidden rounded-pill">
        {segs
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.key}
              className={cn('h-full', s.barClass)}
              style={{ width: `${(s.value / total) * 100}%` }}
            />
          ))}
      </div>

      <ul className="m-0 mt-s3 flex list-none flex-col gap-s2 p-0">
        {segs.map(({ key, name, ink, Icon, value }) => (
          <li key={key} className="flex min-h-6 items-center gap-s2">
            <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', ink)} />
            <span className="flex-1 text-base text-muted-foreground">{name}</span>
            <span className="tabular text-sm font-bold text-foreground">{count(value)}</span>
            <span className="w-10 text-right tabular text-base text-muted-foreground">
              {Math.round(shareOf(value, total) ?? 0)}%
            </span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
