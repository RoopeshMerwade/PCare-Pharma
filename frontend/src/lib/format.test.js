import { describe, it, expect } from 'vitest';
import { money, moneyCompact, qty, count, plural, daysUntil, initials, date, shortDate, time, duration, minutesSince } from './format';

/* These replaced 45 hand-written ₹ literals and 35 loose toFixed calls that
   had drifted apart on grouping and precision. §5 treats both as content
   rules: a bare number beside a medicine name is a dispensing hazard. */

describe('money', () => {
  it('uses the ₹ prefix and en-IN grouping', () => {
    expect(money(123456)).toBe('₹1,23,456.00');
    expect(money('1250.5')).toBe('₹1,250.50');
  });

  it('survives the shapes the API actually returns', () => {
    expect(money(null)).toBe('₹0.00');
    expect(money(undefined)).toBe('₹0.00');
    expect(money('')).toBe('₹0.00');
    expect(money('not a number')).toBe('₹0.00');
  });

  it('puts the minus outside the symbol', () => {
    expect(money(-40)).toBe('−₹40.00');
  });

  it('drops paise only when explicitly asked', () => {
    expect(money(123456, { whole: true })).toBe('₹1,23,456');
  });
});

describe('moneyCompact', () => {
  it('uses the Indian units a pharmacist says out loud', () => {
    expect(moneyCompact(950)).toBe('₹950');
    expect(moneyCompact(12400)).toBe('₹12.4K');
    expect(moneyCompact(100000)).toBe('₹1L');
    expect(moneyCompact(250000)).toBe('₹2.5L');
    expect(moneyCompact(12000000)).toBe('₹1.2Cr');
  });

  it('never shows a trailing .0', () => {
    expect(moneyCompact(5000)).toBe('₹5K');
    expect(moneyCompact(10000000)).toBe('₹1Cr');
  });

  it('handles zero, negatives and API garbage', () => {
    expect(moneyCompact(0)).toBe('₹0');
    expect(moneyCompact(-12400)).toBe('−₹12.4K');
    expect(moneyCompact(null)).toBe('₹0');
    expect(moneyCompact('not a number')).toBe('₹0');
  });
});

describe('qty', () => {
  it('always carries the unit', () => {
    expect(qty(12, 'strips')).toBe('12 strips');
  });

  it('falls back to a noun rather than emitting a bare number', () => {
    expect(qty(12)).toBe('12 units');
  });
});

describe('count and plural', () => {
  it('groups counts the Indian way', () => {
    expect(count(1234567)).toBe('12,34,567');
  });

  it('agrees in number', () => {
    expect(plural(1, 'bill')).toBe('1 bill');
    expect(plural(3, 'bill')).toBe('3 bills');
    expect(plural(2, 'batch', 'batches')).toBe('2 batches');
  });
});

describe('daysUntil', () => {
  it('counts forward and backward across whole days', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(daysUntil(tomorrow)).toBe(1);

    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    expect(daysUntil(lastWeek)).toBe(-7);
  });

  it('returns null rather than NaN for missing dates', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil('nonsense')).toBeNull();
  });
});

describe('date', () => {
  it('never renders the ambiguous numeric form', () => {
    expect(date('2026-08-15')).toMatch(/Aug/);
  });

  it('shows an em dash for missing values instead of "Invalid Date"', () => {
    expect(date(null)).toBe('—');
    expect(date('nonsense')).toBe('—');
  });
});

describe('shortDate', () => {
  it('drops the year for axis ticks', () => {
    expect(shortDate('2026-08-15')).toMatch(/15/);
    expect(shortDate('2026-08-15')).toMatch(/Aug/);
    expect(shortDate('2026-08-15')).not.toMatch(/2026/);
  });

  it('returns an empty string rather than "Invalid Date"', () => {
    expect(shortDate(null)).toBe('');
    expect(shortDate('nonsense')).toBe('');
  });
});

describe('time', () => {
  it('renders a clock time without the date', () => {
    const at = new Date(2026, 7, 23, 9, 15);
    expect(time(at)).toMatch(/9:15/);
    expect(time(at)).not.toMatch(/Aug/);
  });

  it('shows an em dash for a shift that has not ended yet', () => {
    // A blank cell reads as a rendering bug; "—" reads as "hasn't happened".
    expect(time(null)).toBe('—');
    expect(time('nonsense')).toBe('—');
  });
});

describe('duration', () => {
  it('says how long someone was on the counter, not how a clock looks', () => {
    expect(duration(45)).toBe('45m');
    expect(duration(380)).toBe('6h 20m');
    expect(duration(180)).toBe('3h');   // never "3h 0m"
    expect(duration(0)).toBe('0m');
  });

  it('returns an em dash rather than NaN for a shift still open', () => {
    expect(duration(null)).toBe('—');
    expect(duration(undefined)).toBe('—');
    expect(duration(-5)).toBe('—');
  });
});

describe('minutesSince', () => {
  it('measures a running shift', () => {
    const twoHoursAgo = new Date(Date.now() - 120 * 60_000);
    expect(minutesSince(twoHoursAgo)).toBe(120);
  });

  it('returns null for a missing or future start rather than a negative shift', () => {
    expect(minutesSince(null)).toBeNull();
    expect(minutesSince('nonsense')).toBeNull();
    expect(minutesSince(new Date(Date.now() + 60 * 60_000))).toBeNull();
  });
});

describe('initials', () => {
  it('takes at most two, uppercased', () => {
    expect(initials('roopesh gowda')).toBe('RG');
    expect(initials('Priya')).toBe('P');
  });

  it('does not blow up on null', () => {
    expect(initials(null)).toBe('?');
  });
});
