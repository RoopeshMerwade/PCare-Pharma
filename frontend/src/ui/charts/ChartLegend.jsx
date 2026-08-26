/* ═══════════════════════════════════════════════════════════════════════════
   ChartLegendContent — custom `content` for recharts' <Legend>.

   A legend is always present for two or more series (the dependable identity
   channel); a single series never gets one — the card title already names
   it, so the chart components only mount <Legend> when series.length > 1.

   The key mirrors the mark: `shape="rect"` for bars/areas, `shape="line"`
   for lines. Legend text wears text tokens; identity comes from the coloured
   mark beside it. MODULE SCOPE — see ChartTooltip.
   ═══════════════════════════════════════════════════════════════════════════ */

export function ChartLegendContent({ payload, shape = 'rect' }) {
  if (!payload?.length) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-x-s4 gap-y-s1 p-0 pt-s2">
      {payload.map((entry) => (
        <li key={entry.value} className="flex items-center gap-s2">
          <span
            aria-hidden="true"
            className={shape === 'line' ? 'h-0.5 w-4 shrink-0 rounded-pill' : 'h-3 w-3 shrink-0'}
            style={{ background: entry.color }}
          />
          <span className="text-base text-muted-foreground">{entry.value}</span>
        </li>
      ))}
    </ul>
  );
}

export default ChartLegendContent;
