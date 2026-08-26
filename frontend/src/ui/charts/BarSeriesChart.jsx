import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList } from 'recharts';
import ChartFrame from './ChartFrame';
import { ChartTooltipContent } from './ChartTooltip';
import { ChartLegendContent } from './ChartLegend';
import { CHART_SURFACE, CHART_CURSOR_FILL, BAR_MAX_SIZE, BAR_RADIUS, GAP_WIDTH } from './chartTheme';

/* ═══════════════════════════════════════════════════════════════════════════
   BarSeriesChart — magnitude by category: stacked or grouped columns, or
   horizontal bars (`horizontal` for many / long-named categories).

   Mark specs, fixed: bars ≤ 24px thick; 4px rounded DATA-end, square at the
   baseline (stacked: only the outermost segment is rounded); a 2px stroke in
   the surface colour separates touching fills — the gap does the separating,
   never a drawn border. On bars the mark is the hit target: no crosshair,
   the hover wash lifts the whole category band.

   `valueLabels` puts the value at the bar tip — for single-series horizontal
   bars where the tip has room. Interior stacked segments never get inline
   labels (no free end); the legend + tooltip + table carry them.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function BarSeriesChart({
  data,
  xKey,
  series,            // [{ key, name, color }]
  stacked = false,
  horizontal = false,
  height = 260,
  width,             // numeric width bypasses ResponsiveContainer (tests)
  label,
  dimmed = false,
  formatValue,
  formatAxisValue,
  formatXLabel,
  formatTooltipLabel,   // defaults to formatXLabel; pass identity to keep full names in the tooltip
  valueLabels = false,
  yWidth,
  className,
}) {
  const multi = series.length > 1;

  // 4px rounded data-end, square baseline. Stacked: outermost segment only.
  const radiusFor = (index) => {
    const isEnd = !stacked || index === series.length - 1;
    if (!isEnd) return 0;
    return horizontal
      ? [0, BAR_RADIUS, BAR_RADIUS, 0]
      : [BAR_RADIUS, BAR_RADIUS, 0, 0];
  };

  return (
    <ChartFrame label={label} height={height} width={width} dimmed={dimmed} className={className}>
      <BarChart
        data={data}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: valueLabels && horizontal ? 64 : 12, bottom: 0, left: 0 }}
      >
        <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickFormatter={formatAxisValue} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey={xKey}
              width={yWidth ?? 140}
              tickFormatter={formatXLabel}
              tickLine={false}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey={xKey}
              tickFormatter={formatXLabel}
              tickLine={false}
              tickMargin={8}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis tickFormatter={formatAxisValue} width={yWidth ?? 56} axisLine={false} tickLine={false} />
          </>
        )}
        <Tooltip
          cursor={{ fill: CHART_CURSOR_FILL }}
          content={<ChartTooltipContent formatValue={formatValue} formatLabel={formatTooltipLabel ?? formatXLabel} />}
          isAnimationActive={false}
        />
        {multi && <Legend content={<ChartLegendContent shape="rect" />} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            fill={s.color}
            stackId={stacked ? 'stack' : undefined}
            maxBarSize={BAR_MAX_SIZE}
            stroke={CHART_SURFACE}
            strokeWidth={GAP_WIDTH}
            radius={radiusFor(i)}
            isAnimationActive={false}
          >
            {valueLabels && (
              <LabelList
                dataKey={s.key}
                position={horizontal ? 'right' : 'top'}
                formatter={formatValue}
              />
            )}
          </Bar>
        ))}
      </BarChart>
    </ChartFrame>
  );
}
