/* ═══════════════════════════════════════════════════════════════════════════
   Chart theme — the ONLY place chart JS names a colour, and every value is a
   CSS custom-property reference, never a raw colour.

   Recharts takes colours as JS props, and lint (§6) bans raw values — even
   the substring "rgb(" — in component code. "var(--chart-N)" contains
   neither, and because it resolves in CSS at paint time, a theme toggle
   recolours every mounted chart with no re-render and no JS subscription:
   tokens.css redeclares the channel tokens for dark mode and the var()
   simply re-resolves.

   The slot ORDER is the CVD-safety mechanism (validated in both modes — see
   tokens.css). Assign slots in sequence, never cycled, and let colour follow
   the ENTITY, never its rank: the entity→slot map lives in
   domain/charts/series.js. More than 8 series is a design error — fold the
   tail into "Other", never generate a 9th hue.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Categorical series slots, in validated order. */
export const CHART_SERIES = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];

/** Single-series colour (revenue trends, sparklines) — accent, not a slot. */
export const CHART_ACCENT = 'var(--chart-accent)';

/** Surface colour: the 2px gap between touching fills and the marker ring. */
export const CHART_SURFACE = 'var(--chart-surface)';

/** Crosshair line on line/area charts. */
export const CHART_CURSOR_STROKE = 'var(--chart-axis)';

/** Hover wash behind the hovered category on bar charts. */
export const CHART_CURSOR_FILL = 'var(--chart-cursor-fill)';

/* Mark specs — fixed across every chart, per the dataviz method. */
export const BAR_MAX_SIZE = 24;   // bars never thicker than 24px
export const BAR_RADIUS = 4;      // 4px rounded data-end, square baseline
export const LINE_WIDTH = 2;      // 2px lines, round cap/join
export const GAP_WIDTH = 2;       // 2px surface gap / marker ring
