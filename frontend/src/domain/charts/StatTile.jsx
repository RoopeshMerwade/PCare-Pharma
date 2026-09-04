import Card, { CardBody } from '../../ui/Card';
import Sparkline from '../../ui/charts/Sparkline';
import { cn } from '../../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   StatTile — the one KPI tile. Replaces OwnerDashboard's local `Kpi` and
   ReportsPage's local `Stat`, which had already drifted apart.

   Contract: `label` · value (children — usually <Money> or a tabular span) ·
   optional `icon` beside the label · optional `delta` (signed %, vs a named
   period) · optional `sub` line · optional `trend` sparkline.

   The icon is decoration, never information: it sits in front of a label that
   already says the whole thing in words, so it is wrapped aria-hidden and a
   tile without one loses nothing but a picture (§3.6, A4).

   Delta colour = direction × whether up is good: up wears success; down is
   MUTED with a ↓ glyph, not destructive — a quiet Tuesday is not an error,
   and painting it red at the counter is alarmist. The glyph (plus sr-only
   text) carries direction, so it is never colour-alone.

   The sparkline is aria-hidden and value-free by design — the number beside
   it is the value; the full series lives in the trend chart's data table.
   ═══════════════════════════════════════════════════════════════════════════ */

function Delta({ value, label }) {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  const up = rounded > 0;
  const flat = rounded === 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-s1 whitespace-nowrap tabular font-bold',
        up ? 'text-success' : 'text-muted-foreground'
      )}
    >
      {!flat && <span aria-hidden="true">{up ? '↑' : '↓'}</span>}
      <span className="sr-only">{flat ? 'unchanged' : up ? 'up' : 'down'}</span>
      {Math.abs(rounded)}%
      {label && <span className="font-normal text-muted-foreground">{label}</span>}
    </span>
  );
}

export default function StatTile({
  label,
  icon,           // decorative node rendered before the label; see the header
  sub,
  delta,          // signed percent, or null/undefined to show nothing
  deltaLabel,     // "vs yesterday" — deltas always name their base period
  trend,          // [{ ...point }] — needs ≥ 2 points to draw
  trendKey = 'value',
  trendColor,     // "var(--chart-N)" from the series map; accent by default
  className,
  children,
}) {
  return (
    <Card className={className}>
      <CardBody className="flex flex-col gap-s1">
        <span className="flex items-center gap-s2 text-base text-muted-foreground">
          {icon && <span className="flex shrink-0 items-center" aria-hidden="true">{icon}</span>}
          <span className="min-w-0 truncate">{label}</span>
        </span>
        <div className="flex items-end justify-between gap-s3">
          <div className="min-w-0">{children}</div>
          <Sparkline data={trend} dataKey={trendKey} color={trendColor} className="mb-1" />
        </div>
        {(delta != null || sub) && (
          <div className="flex flex-wrap items-center gap-s2 text-base text-muted-foreground">
            <Delta value={delta} label={deltaLabel} />
            {sub && <span>{sub}</span>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
