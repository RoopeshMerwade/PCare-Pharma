const usersService = require('../../src/modules/users/users.service');
const { supabase } = require('../../src/config/supabase');

// staff_summary has no email column — the address lives only in auth.users.
// listUsers adds it per row from the Auth admin API; before that, UsersPage
// showed a blank line on every card and a reset dialog reading "a link at
// undefined".
jest.mock('../../src/config/supabase', () => {
  const original = jest.requireActual('../../src/config/supabase');
  return {
    ...original,
    supabase: {
      from: jest.fn(),
      auth: { admin: { getUserById: jest.fn() } },
    },
  };
});

const ROWS = [
  { id: 'u1', full_name: 'Asha', role: 'staff', is_active: true, last_login_at: null },
  { id: 'u2', full_name: 'Ravi', role: 'staff', is_active: true, last_login_at: '2026-09-13T11:19:41Z' },
];

function staffSummaryReturns(result) {
  supabase.from.mockReturnValue({
    select: () => ({ order: () => Promise.resolve(result) }),
  });
}

const emailFor = async (id) => ({ data: { user: { id, email: `${id}@pcare.in` } }, error: null });

describe('listUsers — staff email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('adds each account\'s email from Supabase Auth and keeps the view\'s fields and order', async () => {
    staffSummaryReturns({ data: ROWS, error: null });
    supabase.auth.admin.getUserById.mockImplementation(emailFor);

    const users = await usersService.listUsers();

    expect(supabase.from).toHaveBeenCalledWith('staff_summary');
    expect(users).toEqual([
      { ...ROWS[0], email: 'u1@pcare.in' },
      { ...ROWS[1], email: 'u2@pcare.in' },
    ]);
  });

  test('an Auth error for one account leaves that email null and still returns the list', async () => {
    staffSummaryReturns({ data: ROWS, error: null });
    supabase.auth.admin.getUserById.mockImplementation(async (id) =>
      (id === 'u1' ? { data: { user: null }, error: { message: 'User not found' } } : emailFor(id)));

    const users = await usersService.listUsers();

    expect(users.map((u) => u.email)).toEqual([null, 'u2@pcare.in']);
  });

  test('a thrown Auth lookup is contained the same way', async () => {
    staffSummaryReturns({ data: ROWS, error: null });
    supabase.auth.admin.getUserById.mockImplementation(async (id) => {
      if (id === 'u2') throw new Error('network timeout to auth service');
      return emailFor(id);
    });

    const users = await usersService.listUsers();

    expect(users.map((u) => u.email)).toEqual(['u1@pcare.in', null]);
  });

  test('no staff means no Auth lookups', async () => {
    staffSummaryReturns({ data: [], error: null });

    await expect(usersService.listUsers()).resolves.toEqual([]);
    expect(supabase.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  test('a failure reading the view still fails the request', async () => {
    staffSummaryReturns({ data: null, error: { message: 'relation does not exist' } });

    await expect(usersService.listUsers()).rejects.toThrow('Failed to fetch users.');
    expect(supabase.auth.admin.getUserById).not.toHaveBeenCalled();
  });
});
