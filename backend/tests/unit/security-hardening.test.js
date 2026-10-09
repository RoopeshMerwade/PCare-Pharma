/**
 * Three input-trust fixes, each pure: Supabase is a stub that fails the test if
 * a guard lets a request through to the database.
 *
 *   - createReturn refuses the same bill item twice in one request. The
 *     per-line "remaining" check only looks at returns already on file, so
 *     5 + 5 against 5 sold passed both lines.
 *   - updateUser writes profile fields only, for the owner too. The owner path
 *     wrote the raw body, so { is_active: false } skipped the
 *     CANNOT_DEACTIVATE_OWNER guard.
 *   - requestContext honours an inbound X-Request-Id only when it is a short
 *     token, so a caller cannot pick arbitrary ids for their own log lines.
 */

const mockUpdate = jest.fn();
jest.mock('../../src/config/supabase', () => {
  const chain = {
    update: (payload) => { mockUpdate(payload); return chain; },
    eq: () => chain,
    select: () => chain,
    single: async () => ({ data: { id: 'u1' }, error: null }),
  };
  return {
    supabase: {
      from: jest.fn(() => chain),
      rpc: jest.fn(() => { throw new Error('rpc must not be reached'); }),
    },
    createAuthClient: jest.fn(),
  };
});
jest.mock('../../src/utils/audit', () => ({ logAudit: jest.fn() }));

const { supabase } = require('../../src/config/supabase');
const returns = require('../../src/modules/customer-returns/customer-returns.service');
const users = require('../../src/modules/users/users.service');
const { requestContext } = require('../../src/middleware/requestContext');

beforeEach(() => jest.clearAllMocks());

describe('createReturn', () => {
  test('the same bill item twice in one return is refused before any read', async () => {
    const BI = '11111111-1111-1111-1111-111111111111';
    await expect(returns.createReturn({
      bill_id: '22222222-2222-2222-2222-222222222222',
      reason: 'Wrong item',
      refund_mode: 'cash',
      items: [{ bill_item_id: BI, qty_returned: 5 }, { bill_item_id: BI, qty_returned: 5 }],
    }, 'u1')).rejects.toMatchObject({ statusCode: 422, code: 'DUPLICATE_RETURN_ITEM' });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('updateUser', () => {
  const owner = { id: 'owner-1', role: 'owner' };

  test('an owner cannot set is_active (or any non-profile column) through PATCH /users/:id', async () => {
    await users.updateUser('owner-1', { full_name: 'Asha', is_active: false, id: 'x', created_at: 'y' }, owner);
    expect(mockUpdate).toHaveBeenCalledWith({ full_name: 'Asha' });
  });

  test('a body with only non-profile columns is refused rather than written', async () => {
    await expect(users.updateUser('owner-1', { is_active: false }, owner))
      .rejects.toMatchObject({ statusCode: 422, code: 'NO_FIELDS' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('requestContext', () => {
  const run = (header) => {
    const req = { headers: header === undefined ? {} : { 'x-request-id': header } };
    const res = { setHeader: jest.fn(), on: jest.fn() };
    requestContext(req, res, () => {});
    return req.id;
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("nginx's 32-hex request id is kept", () => {
    expect(run('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
  });

  test('an oversized or odd-shaped id is replaced', () => {
    expect(run('a'.repeat(65))).toMatch(UUID);
    expect(run('evil id {"level":60}')).toMatch(UUID);
    expect(run(['a', 'b'])).toMatch(UUID);
  });

  test('a missing id is generated', () => {
    expect(run(undefined)).toMatch(UUID);
  });
});
