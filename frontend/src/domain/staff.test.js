import { describe, it, expect } from 'vitest';
import { isSetupPending } from './staff';

describe('isSetupPending', () => {
  it('flags an active staff member with no login on record', () => {
    expect(isSetupPending({ role: 'staff', is_active: true, last_login_at: null })).toBe(true);
    // staff_summary returns null, but an absent key must read the same way.
    expect(isSetupPending({ role: 'staff', is_active: true })).toBe(true);
  });

  it('clears as soon as they have signed in once', () => {
    expect(isSetupPending({ role: 'staff', is_active: true, last_login_at: '2026-09-13T11:19:41Z' })).toBe(false);
  });

  it('leaves a deactivated account to its Deactivated badge', () => {
    expect(isSetupPending({ role: 'staff', is_active: false, last_login_at: null })).toBe(false);
  });

  it('never applies to the owner', () => {
    expect(isSetupPending({ role: 'owner', is_active: true, last_login_at: null })).toBe(false);
  });

  it('tolerates a missing user', () => {
    expect(isSetupPending(undefined)).toBe(false);
  });
});
