const authService = require('../../src/modules/auth/auth.service');
const { supabase } = require('../../src/config/supabase');
const { logAudit } = require('../../src/utils/audit');

jest.mock('../../src/config/supabase', () => {
  const original = jest.requireActual('../../src/config/supabase');
  return {
    ...original,
    supabase: {
      ...original.supabase,
      auth: {
        admin: {
          signOut: jest.fn(),
        },
      },
    },
  };
});

jest.mock('../../src/utils/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(true),
}));

describe('Auth Service — Logout & Session Revocation (Issue 3A)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('valid token logout revokes session in Supabase admin and writes audit log', async () => {
    supabase.auth.admin.signOut.mockResolvedValueOnce({ data: {}, error: null });

    const dummyToken = 'mock-jwt-token-xyz';
    const userId = '00000000-0000-0000-0000-000000000001';

    await expect(authService.logout(dummyToken, userId)).resolves.not.toThrow();

    expect(supabase.auth.admin.signOut).toHaveBeenCalledTimes(1);
    expect(supabase.auth.admin.signOut).toHaveBeenCalledWith(dummyToken);
    expect(logAudit).toHaveBeenCalledWith(userId, 'logout', {});
  });

  test('idempotent logout: upstream signOut error does not crash logout or prevent audit logging', async () => {
    supabase.auth.admin.signOut.mockResolvedValueOnce({
      data: null,
      error: { message: 'session_not_found: session has already been revoked or expired' },
    });

    const dummyToken = 'mock-jwt-token-expired';
    const userId = '00000000-0000-0000-0000-000000000002';

    await expect(authService.logout(dummyToken, userId)).resolves.not.toThrow();

    expect(supabase.auth.admin.signOut).toHaveBeenCalledWith(dummyToken);
    expect(logAudit).toHaveBeenCalledWith(userId, 'logout', {});
  });

  test('upstream signOut rejected promise does not crash logout', async () => {
    supabase.auth.admin.signOut.mockRejectedValueOnce(new Error('network timeout to auth service'));

    const dummyToken = 'mock-jwt-network-error';
    const userId = '00000000-0000-0000-0000-000000000003';

    await expect(authService.logout(dummyToken, userId)).resolves.not.toThrow();
    expect(logAudit).toHaveBeenCalledWith(userId, 'logout', {});
  });

  test('repeated logout calls remain idempotent', async () => {
    supabase.auth.admin.signOut.mockResolvedValue({ data: {}, error: null });

    const dummyToken = 'mock-jwt-repeated';
    const userId = '00000000-0000-0000-0000-000000000004';

    await expect(authService.logout(dummyToken, userId)).resolves.not.toThrow();
    await expect(authService.logout(dummyToken, userId)).resolves.not.toThrow();

    expect(supabase.auth.admin.signOut).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenCalledTimes(2);
  });
});
