import { describe, it, expect } from 'vitest';
import {
  deletionBlockedReason, reasonBlockedReason, rangeConfirmationMatches, unitsLeftDeducted,
  MAX_BILLS_PER_DELETE,
} from './billDeletion';

const preview = (over = {}) => ({ bill_count: 2, item_count: 3, total_amount: 250, blocked: [], ...over });

describe('deletionBlockedReason', () => {
  it('waits for the preview before allowing anything', () => {
    expect(deletionBlockedReason(null)).toMatch(/Checking/);
  });

  it('allows a preview with bills and nothing in the way', () => {
    expect(deletionBlockedReason(preview())).toBeNull();
  });

  it('refuses an empty range', () => {
    expect(deletionBlockedReason(preview({ bill_count: 0 }))).toMatch(/no bills/);
  });

  it('refuses more bills than the server will delete in one call', () => {
    expect(deletionBlockedReason(preview({ bill_count: MAX_BILLS_PER_DELETE + 1 }))).toMatch(/at most 1000/);
    expect(deletionBlockedReason(preview({ bill_count: MAX_BILLS_PER_DELETE }))).toBeNull();
  });

  it('names every blocking return, and only suggests rejecting when one is pending', () => {
    const approvedOnly = deletionBlockedReason(preview({
      blocked: [{ bill_number: 'BILL-0003', return_number: 'CR-0001', return_status: 'approved' }],
    }));
    expect(approvedOnly).toContain('BILL-0003 (return CR-0001, approved)');
    expect(approvedOnly).not.toMatch(/Reject/);

    const withPending = deletionBlockedReason(preview({
      blocked: [
        { bill_number: 'BILL-0003', return_number: 'CR-0001', return_status: 'approved' },
        { bill_number: 'BILL-0007', return_number: 'CR-0004', return_status: 'pending' },
      ],
    }));
    expect(withPending).toContain('BILL-0007 (return CR-0004, awaiting approval)');
    expect(withPending).toMatch(/Reject a pending return first/);
  });
});

describe('reasonBlockedReason', () => {
  it('needs at least five characters once trimmed', () => {
    expect(reasonBlockedReason('')).toMatch(/at least 5/);
    expect(reasonBlockedReason('  abcd  ')).toMatch(/at least 5/);
    expect(reasonBlockedReason('Test bill')).toBeNull();
  });
});

describe('rangeConfirmationMatches', () => {
  it('matches only the exact bill count', () => {
    expect(rangeConfirmationMatches('12', 12)).toBe(true);
    expect(rangeConfirmationMatches(' 12 ', 12)).toBe(true);
    expect(rangeConfirmationMatches('1', 12)).toBe(false);
    expect(rangeConfirmationMatches('', 12)).toBe(false);
  });
});

describe('unitsLeftDeducted', () => {
  it('describes sealed and loose units in words', () => {
    expect(unitsLeftDeducted(3, 10)).toBe('3 packs and 10 loose units');
    expect(unitsLeftDeducted(1, 0)).toBe('1 pack');
    expect(unitsLeftDeducted(0, 1)).toBe('1 loose unit');
    expect(unitsLeftDeducted(0, 0)).toBe('no units');
  });
});
