// ═══════════════════════════════════════════════════════════════════════════
// Formatting — one implementation of every number a pharmacist reads.
//
// This replaces 45 hand-written `₹` literals and 35 loose `.toFixed()` calls,
// which had drifted apart on grouping and precision. §5 makes these content
// rules, not style preferences: currency always carries the ₹ prefix, and a
// quantity always carries its unit, because a bare number next to a medicine
// name is a dispensing hazard.
// ═══════════════════════════════════════════════════════════════════════════

const INR = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
});

/** Coerce whatever the API returned — string, number, null — into a number. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Money, always with the ₹ prefix and en-IN grouping (₹1,23,456.00).
 *
 * `whole: true` drops the paise for dashboard headline figures, where two
 * decimals add noise without adding information. Line items, totals and
 * anything a customer could dispute keep both decimals.
 */
export function money(value, { whole = false } = {}) {
  const n = toNumber(value);
  const formatted = whole ? INR_WHOLE.format(n) : INR.format(n);
  // A negative reads better as −₹40.00 than ₹-40.00.
  return n < 0 ? `−₹${formatted.slice(1)}` : `₹${formatted}`;
}

/**
 * Compact money for chart axis ticks, in the Indian units a pharmacist
 * actually says out loud: ₹950 → ₹12.4K → ₹1.2L → ₹3.4Cr. One decimal at
 * most, never a trailing ".0". Full precision stays in tooltips and tables —
 * an axis tick only has to be readable at a glance.
 */
export function moneyCompact(value) {
  const n = toNumber(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const unit = (div, suffix) => {
    const scaled = abs / div;
    const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
    return `${sign}₹${rounded}${suffix}`;
  };
  if (abs >= 1e7) return unit(1e7, 'Cr');
  if (abs >= 1e5) return unit(1e5, 'L');
  if (abs >= 1e3) return unit(1e3, 'K');
  return `${sign}₹${INR_WHOLE.format(abs)}`;
}

/**
 * Quantity with its unit. §5: "always state the unit (strip/bottle/tube)
 * alongside quantity". Falls back to a neutral noun rather than emitting a
 * bare number when the unit is missing from the payload.
 */
export function qty(value, unit) {
  const n = toNumber(value);
  const count = Number.isInteger(n) ? n : Number(n.toFixed(2));
  const noun = unit || 'units';
  return `${INR_WHOLE.format(count)} ${noun}`;
}

/** Plain integer with grouping, for counts that have no unit (bills, patients). */
export function count(value) {
  return INR_WHOLE.format(toNumber(value));
}

/** "12 Aug 2026" — unambiguous, and never the ambiguous 08/12 form. */
export function date(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "12 Aug" — chart axis ticks, where the date filter already carries the year. */
export function shortDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** "12 Aug 2026, 4:35 pm" — for audit logs and bill timestamps. */
export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${date(value)}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * "9:15 am" — a clock time on its own, for the attendance board where the date
 * is already the column header and repeating it in every cell is noise.
 *
 * Returns the em dash for a missing value on purpose. A blank cell reads as a
 * rendering bug; "—" reads as "hasn't happened yet", which is exactly what an
 * empty check_out_time means.
 */
export function time(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

/**
 * A span of minutes as "6h 20m" / "45m" / "3h".
 *
 * Whole hours drop the "0m" — "3h 0m" is how a clock display looks, not how a
 * person says how long they were on the counter.
 */
export function duration(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '—';
  const total = Math.round(toNumber(minutes));
  if (!Number.isFinite(total) || total < 0) return '—';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Minutes elapsed since a timestamp — the running shift length on the staff
 * widget, where there is no check-out time to subtract from yet.
 *
 * `now` is a parameter rather than a hidden `Date.now()` read so a component
 * can pass a value it holds in state and ticks on an interval. Reading the
 * clock during render would make the render impure, and the figure would then
 * only be as fresh as the last unrelated re-render.
 */
export function minutesSince(value, now = Date.now()) {
  if (!value) return null;
  const started = new Date(value);
  if (Number.isNaN(started.getTime())) return null;
  const mins = Math.floor((now - started.getTime()) / 60_000);
  return mins >= 0 ? mins : null;
}

/** "Saturday, 15 August" — the dashboard's dateline. */
export function longDate(value = new Date()) {
  return new Date(value).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

/**
 * Days until a date, negative when already past. Expiry tracking reads this
 * constantly, and every page was computing it slightly differently.
 */
export function daysUntil(value) {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((startOfDay(target) - startOfDay(new Date())) / 86_400_000);
}

/**
 * Whole years since a date of birth, or null.
 *
 * Counts the birthday properly rather than subtracting calendar years, which
 * overstates the age of anyone whose birthday hasn't come round yet. Reads the
 * clock, so call it when data loads rather than during render.
 */
export function ageFrom(dob) {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) years -= 1;
  return years >= 0 ? years : null;
}

/** "1 bill" / "2 bills" — avoids the `${n !== 1 ? 's' : ''}` litter. */
export function plural(n, singular, pluralForm) {
  const value = toNumber(n);
  return `${INR_WHOLE.format(value)} ${value === 1 ? singular : (pluralForm || `${singular}s`)}`;
}

/** Initials for avatars. Two letters, uppercase, never blows up on null. */
export function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}
