import { describe, it, expect } from 'vitest';
import { stockStatus, expiryStatus, STOCK_STATUS } from './stock';

/* This replaced six divergent ternaries. The boundaries are where they
   disagreed, so that is what these lock down. */

describe('stockStatus', () => {
  it('treats zero and below as out of stock', () => {
    expect(stockStatus({ total_stock: 0 })).toBe(STOCK_STATUS.out);
    // Negative should be impossible — the DB trigger prevents it — but if it
    // ever arrives, "Out of stock" is the safe reading, not "In stock".
    expect(stockStatus({ total_stock: -5 })).toBe(STOCK_STATUS.out);
  });

  it('prefers the backend flag, which is the authority', () => {
    expect(stockStatus({ total_stock: 100, is_low_stock: true })).toBe(STOCK_STATUS.low);
    expect(stockStatus({ total_stock: 2, low_stock_threshold: 20, is_low_stock: false })).toBe(STOCK_STATUS.ok);
  });

  it('falls back to the threshold when the flag is absent', () => {
    expect(stockStatus({ total_stock: 5, low_stock_threshold: 20 })).toBe(STOCK_STATUS.low);
    expect(stockStatus({ total_stock: 25, low_stock_threshold: 20 })).toBe(STOCK_STATUS.ok);
  });

  it('counts exactly at the threshold as low — the point is to reorder before running out', () => {
    expect(stockStatus({ total_stock: 20, low_stock_threshold: 20 })).toBe(STOCK_STATUS.low);
  });

  it('does not call everything low when no threshold is set', () => {
    expect(stockStatus({ total_stock: 5, low_stock_threshold: 0 })).toBe(STOCK_STATUS.ok);
  });

  it('survives a missing or malformed record', () => {
    expect(stockStatus(undefined)).toBe(STOCK_STATUS.out);
    expect(stockStatus({})).toBe(STOCK_STATUS.out);
    expect(stockStatus({ total_stock: 'abc' })).toBe(STOCK_STATUS.out);
  });

  it('always pairs a tone with a word, so no caller can render colour alone (A4)', () => {
    for (const status of Object.values(STOCK_STATUS)) {
      expect(status.label).toBeTruthy();
      expect(status.tone).toBeTruthy();
    }
  });
});

describe('expiryStatus', () => {
  it('buckets by days remaining', () => {
    expect(expiryStatus(-1).key).toBe('expired');
    expect(expiryStatus(0).key).toBe('urgent');
    expect(expiryStatus(30).key).toBe('urgent');
    expect(expiryStatus(31).key).toBe('soon');
    expect(expiryStatus(90).key).toBe('soon');
    expect(expiryStatus(91).key).toBe('ok');
  });

  it('says so when there is no expiry date rather than implying it is fine', () => {
    expect(expiryStatus(null).key).toBe('unknown');
    expect(expiryStatus(undefined).key).toBe('unknown');
  });
});
