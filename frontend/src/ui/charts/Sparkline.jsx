import { LineChart, Line } from 'recharts';
import { cn } from '../../lib/cn';
import { CHART_ACCENT, LINE_WIDTH } from './chartTheme';

/* ═══════════════════════════════════════════════════════════════════════════
   Sparkline — the trend glyph inside a stat tile.

   Deliberately mute: no axes, no grid, no dots, no tooltip, and aria-hidden.
   A sparkline is an indicator, not a value carrier — the number sits beside
   it in the tile and the full series lives in the trend chart's data table,
   so nothing is gated on this glyph. Fixed dimensions keep it out of
   ResponsiveContainer entirely (stable in tiles, renderable in jsdom).
   ═══════════════════════════════════════════════════════════════════════════ */

export default function Sparkline({
  data,
  dataKey = 'value',
  color = CHART_ACCENT,
  width = 96,
  height = 32,
  className,
}) {
  if (!data || data.length < 2) return null;
  return (
    <div aria-hidden="true" className={cn('pointer-events-none shrink-0', className)}>
      <LineChart
        width={width}
        height={height}
        data={data}
        margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
      >
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={LINE_WIDTH}
          strokeLinecap="round"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </div>
  );
}
