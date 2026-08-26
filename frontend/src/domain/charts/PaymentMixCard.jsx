import ChartCard from '../../ui/charts/ChartCard';
import { Money } from '../Money';
import { cn } from '../../lib/cn';
import { PAYMENT_SERIES, num, shareOf } from './series';

/* ═══════════════════════════════════════════════════════════════════════════
   PaymentMixCard — today's cash / UPI / credit / card split as a single
   part-to-whole composition bar.

   Deliberately plain HTML, not recharts: one bar with no axis is a meter-
   like composition, and flex widths + the token classes (bg-chart-N) draw it
   exactly. The 2px flex gap is the surface doing the separating. The value
   list below IS the direct labels — every figure is readable without
   hovering, which also discharges the light-mode contrast relief for the
   sub-3:1 slots. The bar itself is decoration over that list (aria-hidden).

   Colour follows the entity: the map in series.js, fixed, so the mint-…er,
   the blue a reader learns for Cash here is Cash everywhere.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function PaymentMixCard({
  breakdown,               // { cash, upi, credit, card } — today's ₹ by mode
  title = "Today's payment mix",
  subtitle,
  className,
}) {
  const values = PAYMENT_SERIES.map((s) => ({ ...s, value: num(breakdown?.[s.mode]) }));
  const total = values.reduce((sum, s) => sum + s.value, 0);

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      empty={total <= 0}
      emptyTitle="No sales yet today"
      emptyBody="The cash / UPI / credit split appears with the first bill of the day."
      className={className}
    >
      <div aria-hidden="true" className="flex h-4 w-full gap-0.5 overflow-hidden rounded-pill">
        {values
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.mode}
              className={cn('h-full', s.swatchClass)}
              style={{ width: `${(s.value / total) * 100}%` }}
            />
          ))}
      </div>

      <ul className="m-0 mt-s3 flex list-none flex-col gap-s2 p-0">
        {values.map((s) => (
          <li key={s.mode} className="flex min-h-6 items-center gap-s2">
            <span aria-hidden="true" className={cn('h-3 w-3 shrink-0', s.swatchClass)} />
            <span className="flex-1 text-base text-muted-foreground">{s.name}</span>
            <Money value={s.value} whole />
            <span className="w-10 text-right tabular text-base text-muted-foreground">
              {Math.round(shareOf(s.value, total) ?? 0)}%
            </span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
