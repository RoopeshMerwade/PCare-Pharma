import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import ChartFrame from './ChartFrame';
import { ChartTooltipContent } from './ChartTooltip';
import { ChartLegendContent } from './ChartLegend';
import { CHART_SURFACE, CHART_CURSOR_STROKE, LINE_WIDTH, GAP_WIDTH } from './chartTheme';

/* ═══════════════════════════════════════════════════════════════════════════
   TrendChart — change over time. Line by default; `area` for the single-
   series case where a wash under the line helps (fill at ~10%, never a
   saturated block).

   - Crosshair finds the x: the tooltip cursor is a vertical hairline, and
     the readout lists every series at that x.
   - Legend only for ≥ 2 series; one series is named by the card title.
   - No dots on the line; the active dot is ≥8px with a 2px surface ring.
   - Grid horizontal-only, solid hairline (charts.css kills any dash).
   - No animation: the app's motion budget is one 150ms token.

   Colours arrive as "var(--chart-*)" strings on each series — ui/ never
   resolves them. `formatValue` / `formatAxisValue` are injected by
   domain/charts (₹ never appears in ui/).
   ═══════════════════════════════════════════════════════════════════════════ */

export default function TrendChart({
  data,
  xKey,
  series,           // [{ key, name, color }] — slot order fixed by the caller
  area = false,
  height = 260,
  width,            // numeric width bypasses ResponsiveContainer (tests)
  label,
  dimmed = false,
  formatValue,
  formatAxisValue,
  formatXLabel,
  formatTooltipLabel,   // defaults to formatXLabel
  yWidth = 56,
  className,
}) {
  const multi = series.length > 1;
  return (
    <ChartFrame label={label} height={height} width={width} dimmed={dimmed} className={className}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey={xKey}
          tickFormatter={formatXLabel}
          tickLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis
          tickFormatter={formatAxisValue}
          width={yWidth}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          cursor={{ stroke: CHART_CURSOR_STROKE, strokeWidth: 1 }}
          content={<ChartTooltipContent formatValue={formatValue} formatLabel={formatTooltipLabel ?? formatXLabel} />}
          isAnimationActive={false}
        />
        {multi && <Legend content={<ChartLegendContent shape="line" />} />}
        {series.map((s) =>
          area ? (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              fill={s.color}
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, stroke: CHART_SURFACE, strokeWidth: GAP_WIDTH }}
              isAnimationActive={false}
            />
          ) : (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              dot={false}
              activeDot={{ r: 4, stroke: CHART_SURFACE, strokeWidth: GAP_WIDTH }}
              isAnimationActive={false}
            />
          )
        )}
      </ComposedChart>
    </ChartFrame>
  );
}
