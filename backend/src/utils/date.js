// ── Date and timezone utilities for Indian Standard Time (IST — UTC+05:30 / Asia/Kolkata).
// Pharmacy operations run in Karnataka, India; date-slicing (today, monthStart,
// weekStart, reports, dashboard) must reflect Indian Standard Time rather than raw UTC.

const IST_TZ = 'Asia/Kolkata';

/**
 * Formats a Date (or ISO string) into 'YYYY-MM-DD' in Asia/Kolkata timezone.
 */
function getISTDateString(date = new Date()) {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Returns 'YYYY-MM-01' representing the first day of the current month in IST.
 */
function getISTMonthStart(date = new Date()) {
  return `${getISTDateString(date).slice(0, 7)}-01`;
}

/**
 * Returns 'YYYY-MM-DD' representing the start of the week (Sunday) in IST.
 */
function getISTWeekStart(date = new Date()) {
  const baseStr = getISTDateString(date);
  const [y, m, d] = baseStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = utcDate.getUTCDay(); // 0 = Sunday
  utcDate.setUTCDate(utcDate.getUTCDate() - dayOfWeek);
  return utcDate.toISOString().slice(0, 10);
}

/**
 * Returns 'YYYY-MM-DD' representing n calendar days before `date` in IST.
 */
function getISTDaysAgo(n, date = new Date()) {
  const baseStr = getISTDateString(date);
  const [y, m, d] = baseStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  utcDate.setUTCDate(utcDate.getUTCDate() - n);
  return utcDate.toISOString().slice(0, 10);
}

/**
 * Appends IST timezone offset (+05:30) for start of day timestamp queries.
 */
function getISTStartOfDay(dateStr = getISTDateString()) {
  return `${dateStr}T00:00:00+05:30`;
}

/**
 * Appends IST timezone offset (+05:30) for end of day timestamp queries.
 */
function getISTEndOfDay(dateStr = getISTDateString()) {
  return `${dateStr}T23:59:59.999+05:30`;
}

/**
 * Computes standard ISO 8601 week string ('YYYY-Www') for a 'YYYY-MM-DD' date.
 */
function getISOWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, d));
  const dayNr = (target.getUTCDay() + 6) % 7; // Monday = 0, Sunday = 6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // Thursday of same week
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  const weekNumber = 1 + Math.ceil((firstThursday - target) / (7 * 24 * 3600 * 1000));
  const year = new Date(firstThursday).getUTCFullYear();
  return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

module.exports = {
  IST_TZ,
  getISTDateString,
  getISTMonthStart,
  getISTWeekStart,
  getISTDaysAgo,
  getISTStartOfDay,
  getISTEndOfDay,
  getISOWeekKey,
};
