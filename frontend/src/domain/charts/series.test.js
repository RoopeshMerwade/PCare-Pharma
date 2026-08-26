import { describe, it, expect } from 'vitest';
import {
  PAYMENT_SERIES,
  num,
  zeroFillDays,
  deltaVs,
  shareOf,
  bucketByMonth,
  monthLabel,
  truncate,
} from './series';

describe('PAYMENT_SERIES', () => {
  it('binds each mode to its fixed slot — colour follows the entity, never rank', () => {
    expect(PAYMENT_SERIES.map((s) => s.mode)).toEqual(['cash', 'upi', 'credit', 'card']);
    expect(PAYMENT_SERIES[0].color).toBe('var(--chart-1)');
    expect(PAYMENT_SERIES[3].swatchClass).toBe('bg-chart-4');
  });
});

describe('num', () => {
  it('treats API garbage as 0, never NaN', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num('')).toBe(0);
    expect(num('nonsense')).toBe(0);
  });
});

describe('zeroFillDays', () => {
  const keys = ['total_revenue', 'cash_total'];

  it('plots a quiet day as 0 instead of dropping it', () => {
    const rows = [
      { sale_date: '2026-08-01', total_revenue: '100', cash_total: '60' },
      { sale_date: '2026-08-03', total_revenue: '300', cash_total: '0' },
    ];
    const out = zeroFillDays(rows, '2026-08-01', '2026-08-03', keys);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ sale_date: '2026-08-02', total_revenue: 0, cash_total: 0 });
    expect(out[0].total_revenue).toBe(100); // strings coerced to numbers
  });

  it('crosses month boundaries without losing a day', () => {
    const out = zeroFillDays([], '2026-07-30', '2026-08-02', keys);
    expect(out.map((r) => r.sale_date)).toEqual(['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']);
  });

  it('falls back to normalising given rows when the range is unusable', () => {
    const rows = [{ sale_date: '2026-08-01', total_revenue: '5', cash_total: null }];
    expect(zeroFillDays(rows, 'garbage', '2026-08-02', keys)).toEqual([
      { sale_date: '2026-08-01', total_revenue: 5, cash_total: 0 },
    ]);
    expect(zeroFillDays(rows, '2026-08-02', '2026-08-01', keys)).toHaveLength(1); // inverted range
    expect(zeroFillDays(rows, '2020-01-01', '2026-08-01', keys)).toHaveLength(1); // absurd span
  });
});

describe('deltaVs', () => {
  it('is a signed percent against the base period', () => {
    expect(deltaVs(150, 100)).toBe(50);
    expect(deltaVs(75, 100)).toBe(-25);
  });

  it('is null — not Infinity — when there is no meaningful base', () => {
    expect(deltaVs(150, 0)).toBeNull();
    expect(deltaVs(150, null)).toBeNull();
  });
});

describe('shareOf', () => {
  it('is a 0–100 share, null for an empty whole', () => {
    expect(shareOf(25, 100)).toBe(25);
    expect(shareOf('50', '200')).toBe(25);
    expect(shareOf(5, 0)).toBeNull();
  });
});

describe('bucketByMonth', () => {
  it('groups by calendar month, sums, and sorts ascending', () => {
    const items = [
      { created_at: '2026-08-10T09:00:00Z', ordered_total: '100', received_total: '80' },
      { created_at: '2026-07-01T12:00:00Z', ordered_total: 50, received_total: 50 },
      { created_at: '2026-08-21T18:00:00Z', ordered_total: 200, received_total: null },
      { created_at: null, ordered_total: 999, received_total: 999 }, // dropped, not crashed
    ];
    const out = bucketByMonth(items, 'created_at', ['ordered_total', 'received_total']);
    expect(out).toEqual([
      { month: '2026-07', ordered_total: 50, received_total: 50 },
      { month: '2026-08', ordered_total: 300, received_total: 80 },
    ]);
  });
});

describe('monthLabel and truncate', () => {
  it('renders a month humans say', () => {
    expect(monthLabel('2026-08')).toMatch(/Aug/);
    expect(monthLabel('2026-08')).toMatch(/2026/);
    expect(monthLabel(null)).toBe('');
  });

  it('truncates axis ticks with an ellipsis, never mid-way blowing up on null', () => {
    expect(truncate('Amoxicillin + Clavulanate 625', 18)).toBe('Amoxicillin + Cla…');
    expect(truncate('Short', 18)).toBe('Short');
    expect(truncate(null)).toBe('');
  });
});
