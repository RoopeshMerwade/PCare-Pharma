/* Chart primitives — presentational only. Colours are "var(--chart-*)"
   strings resolved by CSS (see chartTheme.js); ₹ and pharmacy meaning are
   injected from domain/charts, never known here. */

export {
  CHART_SERIES,
  CHART_ACCENT,
  CHART_SURFACE,
  CHART_CURSOR_STROKE,
  CHART_CURSOR_FILL,
  BAR_MAX_SIZE,
  BAR_RADIUS,
  LINE_WIDTH,
  GAP_WIDTH,
} from './chartTheme';
export { default as ChartFrame } from './ChartFrame';
export { default as ChartCard } from './ChartCard';
export { default as Sparkline } from './Sparkline';
export { default as TrendChart } from './TrendChart';
export { default as BarSeriesChart } from './BarSeriesChart';
export { ChartTooltipContent } from './ChartTooltip';
export { ChartLegendContent } from './ChartLegend';
