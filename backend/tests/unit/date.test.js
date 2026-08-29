const {
  getISTDateString,
  getISTMonthStart,
  getISTWeekStart,
  getISTDaysAgo,
  getISTStartOfDay,
  getISTEndOfDay,
  getISOWeekKey,
} = require('../../src/utils/date');

describe('IST Date Utilities', () => {
  test('getISTDateString formats UTC timestamps into IST date', () => {
    // 2026-08-29 02:00:00 UTC = 2026-08-29 07:30:00 IST
    const morning = new Date('2026-08-29T02:00:00Z');
    expect(getISTDateString(morning)).toBe('2026-08-29');

    // 2026-08-28 20:00:00 UTC = 2026-08-29 01:30:00 IST (crossed midnight in India)
    const lateNight = new Date('2026-08-28T20:00:00Z');
    expect(getISTDateString(lateNight)).toBe('2026-08-29');
  });

  test('getISTMonthStart returns first day of month', () => {
    const d = new Date('2026-08-15T10:00:00Z');
    expect(getISTMonthStart(d)).toBe('2026-08-01');
  });

  test('getISTWeekStart returns Sunday of the current week', () => {
    // 2026-08-29 is a Saturday -> week start Sunday is 2026-08-23
    const sat = new Date('2026-08-29T10:00:00+05:30');
    expect(getISTWeekStart(sat)).toBe('2026-08-23');

    // 2026-08-23 is a Sunday -> week start is 2026-08-23
    const sun = new Date('2026-08-23T10:00:00+05:30');
    expect(getISTWeekStart(sun)).toBe('2026-08-23');
  });

  test('getISTDaysAgo subtracts calendar days correctly in IST', () => {
    const d = new Date('2026-08-29T10:00:00+05:30');
    expect(getISTDaysAgo(1, d)).toBe('2026-08-28');
    expect(getISTDaysAgo(14, d)).toBe('2026-08-15');
  });

  test('getISTStartOfDay and getISTEndOfDay append IST timezone offsets', () => {
    expect(getISTStartOfDay('2026-08-29')).toBe('2026-08-29T00:00:00+05:30');
    expect(getISTEndOfDay('2026-08-29')).toBe('2026-08-29T23:59:59.999+05:30');
  });

  test('getISOWeekKey computes ISO-8601 week numbers accurately', () => {
    expect(getISOWeekKey('2026-01-01')).toBe('2026-W01');
    expect(getISOWeekKey('2026-08-29')).toBe('2026-W35');
    expect(getISOWeekKey('2025-12-31')).toBe('2026-W01'); // Wednesday in same week as Thursday Jan 1 2026
    expect(getISOWeekKey('2020-12-31')).toBe('2020-W53'); // Thursday in W53 of 2020
  });
});
