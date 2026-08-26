/* ═══════════════════════════════════════════════════════════════════════════
   ChartTooltipContent — custom `content` for recharts' <Tooltip>.

   Rules it encodes:
   - Values lead, labels follow: the number is the strong element, the series
     name secondary — the legend's hierarchy inverted, because here the
     reader has the series and wants the number.
   - One tooltip, every series: recharts hands the full payload at that x.
   - Line keys, not boxes: each row keys its series with a short stroke of
     the series colour; at tooltip density a filled box is data-weight ink.
   - Series names are untrusted API data — rendered as JSX text children
     (textContent), never markup.
   - Text wears text tokens; the coloured mark beside it carries identity.

   ui/ knows nothing about ₹ — `formatValue` is injected by domain/charts.
   MODULE SCOPE on purpose: an inline tooltip component defined inside a
   chart component is the nested-component remount bug lint exists to stop.
   ═══════════════════════════════════════════════════════════════════════════ */

export function ChartTooltipContent({ active, payload, label, formatValue, formatLabel }) {
  if (!active || !payload?.length) return null;
  const shown = payload.filter((entry) => entry.value !== undefined);
  if (!shown.length) return null;

  return (
    <div className="rounded-control border border-border bg-card px-s3 py-s2 shadow-2">
      {label != null && label !== '' && (
        <div className="mb-s1 text-base text-muted-foreground">
          {formatLabel ? formatLabel(label) : String(label)}
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-s1 p-0">
        {shown.map((entry) => (
          <li key={entry.dataKey} className="flex items-center gap-s2">
            <span
              aria-hidden="true"
              className="h-0.5 w-3 shrink-0 rounded-pill"
              style={{ background: entry.color }}
            />
            <span className="tabular text-base font-bold text-foreground">
              {formatValue ? formatValue(entry.value) : String(entry.value)}
            </span>
            {entry.name != null && (
              <span className="text-base text-muted-foreground">{entry.name}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ChartTooltipContent;
