import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { checkA11y } from '../../test/axe';
import { ToastProvider } from '../../ui/Toast';
import PurchasesPage from './PurchasesPage';

/* The receiving screen is the only place in the app that creates stock from
   nothing, and every field on it lands in an append-only ledger. These tests
   cover the two rules that are invisible in a screenshot: the action only
   appears on a status the RPC will actually accept, and the client refuses a
   payload the RPC would reject (expired batch, selling price above MRP).    */

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('../../lib/api', () => ({ api: mockApi }));

const SENT_PO = {
  id: 'po-1',
  purchase_number: 'PO-2026-0001',
  supplier_name: 'MedPlus Distributors',
  status: 'sent',
  item_count: 1,
  created_at: '2026-08-01T10:00:00Z',
  ordered_total: 2500,
  received_total: 0,
};

const RECEIVED_PO = {
  ...SENT_PO,
  id: 'po-2',
  purchase_number: 'PO-2026-0002',
  status: 'received',
  received_total: 2500,
};

const DETAIL_ITEMS = [
  {
    id: 'item-1',
    qty_ordered: 100,
    unit_cost: '25.00',
    qty_received: 100,
    batch_no: 'BATCH-A',
    exp_date: '2028-06-30',
    mrp: '30.00',
    selling_price: '28.00',
    medicines: { name: 'Paracetamol 650mg', unit: 'strips', default_selling_price: '28.00' },
  },
];

/** Routes each mocked GET to its fixture, so a page render and a detail fetch
 *  can be in flight at once without the tests caring about ordering. */
const respond = ({ rows = [SENT_PO], detail = {} } = {}) => {
  mockApi.get.mockImplementation((url) => {
    if (url.startsWith('/suppliers')) {
      return Promise.resolve({ data: { suppliers: [{ id: 's-1', name: 'MedPlus Distributors' }] } });
    }
    if (url.startsWith('/purchases?')) {
      return Promise.resolve({
        data: { purchases: rows, pagination: { page: 1, pages: 1, total: rows.length, limit: 15 } },
      });
    }
    if (url.startsWith('/purchases/')) {
      return Promise.resolve({
        data: { purchase: { ...SENT_PO, items: DETAIL_ITEMS, ...detail } },
      });
    }
    return Promise.reject(new Error(`Unmocked GET ${url}`));
  });
};

const renderPage = () => render(
  <ToastProvider>
    <PurchasesPage />
  </ToastProvider>
);

/** Opens the receive dialog and waits for the line fields to arrive. */
const openReceiveDialog = async (user) => {
  const rows = await screen.findAllByRole('button', { name: 'Receive goods' });
  await user.click(rows[0]);
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByLabelText(/Batch number/);
  return dialog;
};

/** Fills one line with a valid receipt, overriding individual fields. */
const fillLine = async (user, dialog, overrides = {}) => {
  const values = { batch: 'batch-2026-a', expiry: '2028-06-30', mrp: '30.00', selling: '28.00', ...overrides };

  // user.type() throws on an empty string, so '' means "leave this field
  // blank" — which is exactly what the missing-batch case needs to assert.
  const fill = async (matcher, value) => {
    const control = within(dialog).getByLabelText(matcher);
    await user.clear(control);
    if (value !== '') await user.type(control, value);
  };

  await fill(/Batch number/, values.batch);
  await fill(/Expiry date/, values.expiry);
  await fill(/MRP/, values.mrp);
  await fill(/Selling price/, values.selling);
};

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.patch.mockReset();
  respond();
});

describe('PurchasesPage — receiving actions', () => {
  it('offers "Receive goods" on a sent order', async () => {
    renderPage();
    expect((await screen.findAllByRole('button', { name: 'Receive goods' })).length).toBeGreaterThan(0);
  });

  it('offers "View receipt" instead once the order is received', async () => {
    respond({ rows: [RECEIVED_PO] });
    renderPage();

    expect((await screen.findAllByRole('button', { name: 'View receipt' })).length).toBeGreaterThan(0);
    // Receiving twice is rejected by the RPC, so the action must be gone.
    expect(screen.queryByRole('button', { name: 'Receive goods' })).not.toBeInTheDocument();
  });

  it('opens the receive dialog with the order lines loaded', async () => {
    const user = userEvent.setup();
    renderPage();

    const dialog = await openReceiveDialog(user);

    expect(mockApi.get).toHaveBeenCalledWith('/purchases/po-1');
    expect(within(dialog).getByText('Paracetamol 650mg')).toBeInTheDocument();
    // Received qty defaults to the ordered qty — a full delivery is the norm.
    expect(within(dialog).getByLabelText(/Received quantity/)).toHaveValue('100');
    // Selling price pre-fills from the medicine's standard price.
    expect(within(dialog).getByLabelText(/Selling price/)).toHaveValue('28.00');
  });
});

describe('PurchasesPage — receipt submission', () => {
  it('posts the batch details and reloads the list', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { purchase: RECEIVED_PO } });
    renderPage();

    const dialog = await openReceiveDialog(user);
    await fillLine(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: /Receive and add to stock/ }));

    expect(mockApi.post).toHaveBeenCalledWith('/purchases/po-1/receive', {
      invoice_no: null,
      items: [{
        purchase_item_id: 'item-1',
        // Uppercased to match the RPC's own upper(trim(...)) storage.
        batch_no: 'BATCH-2026-A',
        qty_received: 100,
        exp_date: '2028-06-30',
        mfg_date: null,
        mrp: 30,
        selling_price: 28,
      }],
    });

    // The list refetches so the row moves to Received.
    expect(await screen.findByText('Purchase received and inventory stock updated.')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(expect.stringContaining('/purchases?'));
  });

  it('posts with distributor invoice number when provided', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { purchase: { ...RECEIVED_PO, invoice_no: 'INV-9988' } } });
    renderPage();

    const dialog = await openReceiveDialog(user);
    const invoiceInput = within(dialog).getByLabelText(/Distributor invoice/);
    await user.type(invoiceInput, 'INV-9988');
    await fillLine(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: /Receive and add to stock/ }));

    expect(mockApi.post).toHaveBeenCalledWith('/purchases/po-1/receive', {
      invoice_no: 'INV-9988',
      items: [{
        purchase_item_id: 'item-1',
        batch_no: 'BATCH-2026-A',
        qty_received: 100,
        exp_date: '2028-06-30',
        mfg_date: null,
        mrp: 30,
        selling_price: 28,
      }],
    });
  });

  it('refuses a selling price above MRP instead of letting the RPC reject it', async () => {
    const user = userEvent.setup();
    renderPage();

    const dialog = await openReceiveDialog(user);
    await fillLine(user, dialog, { mrp: '30.00', selling: '35.00' });
    await user.click(within(dialog).getByRole('button', { name: /Receive and add to stock/ }));

    expect(await within(dialog).findByText('Selling price cannot be above the MRP.')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('refuses an already-expired batch', async () => {
    const user = userEvent.setup();
    renderPage();

    const dialog = await openReceiveDialog(user);
    await fillLine(user, dialog, { expiry: '2020-01-31' });
    await user.click(within(dialog).getByRole('button', { name: /Receive and add to stock/ }));

    expect(await within(dialog).findByText(/already expired/)).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('requires a batch number on every line', async () => {
    const user = userEvent.setup();
    renderPage();

    const dialog = await openReceiveDialog(user);
    await fillLine(user, dialog, { batch: '' });
    await user.click(within(dialog).getByRole('button', { name: /Receive and add to stock/ }));

    expect(await within(dialog).findByText(/Batch number is printed/)).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('keeps a rejected receipt on screen with the server message', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue(new Error('One of the batch numbers already exists for that medicine.'));
    renderPage();

    const dialog = await openReceiveDialog(user);
    await fillLine(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: /Receive and add to stock/ }));

    // Inline, not a toast — a toast behind an open modal is unreachable.
    expect(
      await within(dialog).findByText('One of the batch numbers already exists for that medicine.')
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('PurchasesPage — receipt drawer', () => {
  it('shows the batches a received order put into stock', async () => {
    const user = userEvent.setup();
    respond({ rows: [RECEIVED_PO], detail: { ...RECEIVED_PO, received_at: '2026-08-05T09:00:00Z' } });
    renderPage();

    const buttons = await screen.findAllByRole('button', { name: 'View receipt' });
    await user.click(buttons[0]);

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('BATCH-A')).toBeInTheDocument();
    expect(within(drawer).getByText('Paracetamol 650mg')).toBeInTheDocument();
    expect(within(drawer).getByText('Total received value')).toBeInTheDocument();
  });
});

describe('PurchasesPage — accessibility', () => {
  it('has no axe violations on the list', async () => {
    const { container } = renderPage();
    await screen.findAllByRole('button', { name: 'Receive goods' });
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('has no axe violations on the receive dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openReceiveDialog(user);
    expect(await checkA11y(dialog)).toHaveNoViolations();
  });
});
