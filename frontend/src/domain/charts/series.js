import { CHART_SERIES, CHART_ACCENT } from '../../ui/charts';

/* ═══════════════════════════════════════════════════════════════════════════
   Series semantics — where chart colour meets pharmacy meaning.

   COLOUR FOLLOWS THE ENTITY, NEVER ITS RANK. This map is the one place a
   payment mode is bound to a series slot, and it is fixed: cash is slot 1
   everywhere it appears — tile sparkline, today's mix bar, the over-time
   stack — so the colour a reader learns once stays true across the app.
   Filtering a mode out must never repaint the survivors.

   `swatchClass` carries the literal Tailwind class (bg-chart-N) so the
   HTML composition bars and legend swatches resolve through the same tokens
   the recharts props do — and so Tailwind's scanner sees the class names.
   ═══════════════════════════════════════════════════════════════════════════ */

export const PAYMENT_SERIES = [
  { mode: 'cash',   key: 'cash_total',   name: 'Cash',   color: CHART_SERIES[0], swatchClass: 'bg-chart-1' },
  { mode: 'upi',    key: 'upi_total',    name: 'UPI',    color: CHART_SERIES[1], swatchClass: 'bg-chart-2' },
  { mode: 'credit', key: 'credit_total', name: 'Credit', color: CHART_SERIES[2], swatchClass: 'bg-chart-3' },
  { mode: 'card',   key: 'card_total',   name: 'Card',   color: CHART_SERIES[3], swatchClass: 'bg-chart-4' },
];

/** Revenue is a single series and wears the accent, not a categorical slot. */
export const REVENUE_COLOR = CHART_ACCENT;

const TREND_KEYS = ['bill_count', 'total_revenue', 'cash_total', 'upi_total', 'credit_total', 'card_total'];

/** The API returns numerics as strings; NaN and null must read as 0, never leak into a chart. */
export function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fill the gaps in a day-keyed series: daily_sales_summary (and therefore
 * /reports/sales with groupBy=day) only emits rows for days that had bills,
 * and a chart that silently drops quiet days compresses the x-axis into a
 * lie — a no-sales day must plot as ₹0.
 *
 * Dates iterate in UTC to match the API's date strings. Anything unparseable
 * or a span past ~13 months falls back to normalising the rows as given.
 */
export function zeroFillDays(rows, dateFrom, dateTo, keys = TREND_KEYS) {
  const normalise = (r) => {
    const row = { sale_date: r.sale_date };
    keys.forEach((k) => { row[k] = num(r[k]); });
    return row;
  };

  const start = new Date(`${dateFrom}T00:00:00Z`).getTime();
  const end = new Date(`${dateTo}T00:00:00Z`).getTime();
  const DAY = 86_400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (end - start) / DAY > 400) {
    return (rows || []).map(normalise);
  }

  const byDate = {};
  (rows || []).forEach((r) => { byDate[r.sale_date] = r; });

  const out = [];
  for (let t = start; t <= end; t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push(normalise({ ...(byDate[date] || {}), sale_date: date }));
  }
  return out;
}

/**
 * Percent change against a base period, or null when there is no meaningful
 * base — a delta against ₹0 is noise, and the tile simply shows nothing.
 */
export function deltaVs(current, previous) {
  const p = num(previous);
  if (p <= 0) return null;
  return ((num(current) - p) / p) * 100;
}

/** Share of a whole as 0–100, or null when the whole is 0. */
export function shareOf(part, whole) {
  const w = num(whole);
  if (w <= 0) return null;
  return (num(part) / w) * 100;
}

/**
 * Bucket dated records by calendar month (the purchases chart): groups on
 * the YYYY-MM of `dateKey`, sums `sumKeys`, returns ascending by month.
 */
export function bucketByMonth(items, dateKey, sumKeys) {
  const buckets = {};
  (items || []).forEach((item) => {
    const month = String(item?.[dateKey] || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    if (!buckets[month]) {
      buckets[month] = { month };
      sumKeys.forEach((k) => { buckets[month][k] = 0; });
    }
    sumKeys.forEach((k) => { buckets[month][k] += num(item[k]); });
  });
  return Object.values(buckets).sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** "2026-08" → "Aug 2026" for month-bucketed axes. */
export function monthLabel(ym) {
  const d = new Date(`${ym}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ym == null ? '' : String(ym);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Axis-tick truncation for long category names; the tooltip and table keep the full name. */
export function truncate(text, max = 18) {
  const s = text == null ? '' : String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
