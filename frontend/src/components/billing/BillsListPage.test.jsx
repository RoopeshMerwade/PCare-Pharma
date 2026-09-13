import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../ui/Toast';
import BillsListPage from './BillsListPage';

/* Deleting a bill is permanent and never puts stock back, so these lock down
   what a screenshot cannot show: staff never see either Delete control (absent,
   not disabled — §3.6), a bill with a customer return is refused with that
   return named, and the delete sends exactly the reason the owner typed. */

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const mockAuth = vi.hoisted(() => ({ current: null }));

vi.mock('../../lib/api', () => ({ api: mockApi }));
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => mockAuth.current }));

const BILL = {
  id: 'b-1',
  bill_number: 'BILL-0001',
  customer_name: 'Walk-in Customer',
  customer_phone: null,
  created_at: '2026-09-13T05:00:00Z',
  item_count: 1,
  created_by_name: 'Vijay',
  payment_mode: 'cash',
  discount_amount: 0,
  subtotal: 120,
  total: 120,
};

const PREVIEW = {
  bill_count: 1, item_count: 1, total_amount: 120,
  sealed_units_not_restocked: 2, loose_units_not_restocked: 0, blocked: [],
};

const respond = ({ preview = PREVIEW } = {}) => {
  mockApi.get.mockImplementation((url) => {
    if (url.startsWith('/billing/totals')) {
      return Promise.resolve({ data: { summary: { total: 120, cash: 120, upi: 0, credit: 0, card: 0 } } });
    }
    if (url.startsWith('/billing?')) {
      return Promise.resolve({ data: { bills: [BILL], pagination: { page: 1, pages: 1, total: 1, limit: 15 } } });
    }
    if (url === `/billing/${BILL.id}/delete-preview`) return Promise.resolve({ data: { preview } });
    if (url === `/billing/${BILL.id}`) return Promise.resolve({ data: { bill: { ...BILL, items: [] } } });
    return Promise.reject(new Error(`Unmocked GET ${url}`));
  });
};

const asOwner = () => { mockAuth.current = { user: { id: 'u1', role: 'owner' }, isOwner: true }; };
const asStaff = () => { mockAuth.current = { user: { id: 'u2', role: 'staff' }, isOwner: false }; };

const renderPage = () => render(
  <ToastProvider>
    <BillsListPage />
  </ToastProvider>
);

/** Opens the bill detail dialog from the list. */
const openBill = async (user) => {
  const cells = await screen.findAllByText(BILL.bill_number);
  await user.click(cells[0]);
  return screen.findByRole('dialog');
};

/** From the detail dialog, opens the delete dialog for the same bill. */
const openDeleteDialog = async (user) => {
  const detail = await openBill(user);
  await user.click(within(detail).getByRole('button', { name: 'Delete bill' }));
  return screen.findByRole('dialog', { name: /Delete BILL-0001 permanently/ });
};

beforeEach(() => {
  vi.clearAllMocks();
  respond();
});

describe('staff', () => {
  beforeEach(asStaff);

  it('sees neither delete control, and is pointed at customer returns', async () => {
    const user = userEvent.setup();
    renderPage();
    const detail = await openBill(user);

    expect(screen.queryByRole('button', { name: 'Delete bills by date' })).toBeNull();
    expect(within(detail).queryByRole('button', { name: 'Delete bill' })).toBeNull();
    expect(within(detail).getByText(/raise a customer return instead/)).toBeTruthy();
  });
});

describe('owner', () => {
  beforeEach(asOwner);

  it('has both delete controls', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('button', { name: 'Delete bills by date' })).toBeTruthy();
    const detail = await openBill(user);
    expect(within(detail).getByRole('button', { name: 'Delete bill' })).toBeTruthy();
  });

  it('names the return that blocks the delete, and never sends it', async () => {
    respond({
      preview: {
        ...PREVIEW,
        blocked: [{ bill_id: BILL.id, bill_number: 'BILL-0001', return_number: 'CR-0002', return_status: 'approved' }],
      },
    });
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDeleteDialog(user);

    expect(await within(dialog).findByText(/BILL-0001 \(return CR-0002, approved\)/)).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Duplicate bill');
    await user.click(within(dialog).getByRole('button', { name: 'Delete bill' }));
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('says the stock stays deducted, and deletes with the trimmed reason', async () => {
    mockApi.post.mockResolvedValue({ success: true, message: 'Deleted BILL-0001. Stock was not returned.', data: { result: {} } });
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDeleteDialog(user);

    expect(await within(dialog).findByText(/Stock is not returned: 2 packs stay deducted/)).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), '  Duplicate bill  ');
    await user.click(within(dialog).getByRole('button', { name: 'Delete bill' }));

    expect(mockApi.post).toHaveBeenCalledWith(`/billing/${BILL.id}/delete`, { reason: 'Duplicate bill' });
  });
});
