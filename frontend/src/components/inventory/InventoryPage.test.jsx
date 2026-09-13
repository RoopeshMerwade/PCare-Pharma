import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { checkA11y } from '../../test/axe';
import { ToastProvider } from '../../ui/Toast';
import InventoryPage from './InventoryPage';

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mockApi }));

// BatchDrawer (rendered closed alongside the list) reads isOwner. Stubbing the
// hook keeps this suite about the list, not about session bootstrapping.
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'owner' }, isOwner: true }),
}));

/* The page's alert chips used to be counted from `resource.rows`. That looked
   right only because /inventory never paginated — it returned the whole
   filtered catalogue. Now that it pages, a chip counted from the loaded rows
   would describe at most 15 medicines while claiming to describe the shop.

   The two tests that matter: the chips render the SERVER's counts, and they do
   not move when you click one (they set the stock filter, so a count narrowed
   by it would redraw the instant it was used). */

// Two rows on the page; the stats describe a much larger catalogue. Any figure
// the page derives from these rows is therefore visibly wrong.
const ROWS = [
  { id: 'm1', name: 'Amoxicillin 500', unit: 'strips', total_stock: 4, low_stock_threshold: 20, near_expiry_batch_count: 0, category_name: 'Antibiotics', category_color: '#0a7' },
  { id: 'm2', name: 'Paracetamol 650', unit: 'strips', total_stock: 60, low_stock_threshold: 20, near_expiry_batch_count: 0, category_name: 'Analgesics', category_color: '#07a' },
];
const STATS = { total: 412, out: 40, low: 12, near: 7 };

const respond = ({ rows = ROWS, stats = STATS, pages = 3 } = {}) => {
  mockApi.get.mockImplementation((url) => {
    if (url.startsWith('/categories')) {
      return Promise.resolve({ data: { categories: [{ id: 'c1', name: 'Antibiotics' }] } });
    }
    if (url.startsWith('/inventory')) {
      return Promise.resolve({
        data: {
          inventory: rows,
          pagination: { page: 1, pages, total: stats ? stats.total : rows.length, limit: 15 },
          ...(stats ? { stats } : {}),
        },
      });
    }
    return Promise.reject(new Error(`Unmocked GET ${url}`));
  });
};

const renderPage = () => render(
  <MemoryRouter>
    <ToastProvider><InventoryPage /></ToastProvider>
  </MemoryRouter>
);

/** The last /inventory URL the page requested. */
const lastInventoryUrl = () => [...mockApi.get.mock.calls]
  .reverse().find(([url]) => url.startsWith('/inventory'))?.[0];

beforeEach(() => {
  mockApi.get.mockReset();
  respond();
});

describe('InventoryPage — alert chips', () => {
  test('render the server stats, not counts derived from the loaded page', async () => {
    renderPage();
    // 40 out / 12 low / 7 near — none of which the two rows on screen support.
    expect(await screen.findByText(/40 medicines out of stock/)).toBeInTheDocument();
    expect(screen.getByText(/12 medicines running low/)).toBeInTheDocument();
    expect(screen.getByText(/7 medicines with batches near expiry/)).toBeInTheDocument();
  });

  test('the subtitle counts the whole catalogue, not the page', async () => {
    renderPage();
    expect(await screen.findByText(/412 medicines stocked/)).toBeInTheDocument();
  });

  test('clicking a chip filters the list but does NOT change the counts', async () => {
    const user = userEvent.setup();
    renderPage();
    const chip = await screen.findByText(/12 medicines running low/);

    await user.click(chip);

    // The request narrowed...
    await waitFor(() => expect(lastInventoryUrl()).toContain('stock=low'));
    // ...and the chips still say what they said. This is the whole reason the
    // backend scopes stats to search + category but not to the stock filter.
    expect(screen.getByText(/12 medicines running low/)).toBeInTheDocument();
    expect(screen.getByText(/40 medicines out of stock/)).toBeInTheDocument();
    expect(screen.getByText(/7 medicines with batches near expiry/)).toBeInTheDocument();
  });

  test('falls back to row-derived counts when the backend sends no stats', async () => {
    // An older backend, or a count query that failed on its own — the service
    // sends null for that case rather than 0. The page must still render.
    respond({ stats: null, pages: 1 });
    renderPage();

    // One of the two rows is below its threshold and none are out.
    expect(await screen.findByText(/1 medicine running low/)).toBeInTheDocument();
    expect(screen.queryByText(/out of stock/)).not.toBeInTheDocument();
  });

  test('a chip is hidden when its count is zero', async () => {
    respond({ stats: { total: 412, out: 0, low: 12, near: 0 } });
    renderPage();
    expect(await screen.findByText(/12 medicines running low/)).toBeInTheDocument();
    expect(screen.queryByText(/out of stock/)).not.toBeInTheDocument();
    expect(screen.queryByText(/near expiry/)).not.toBeInTheDocument();
  });
});

describe('InventoryPage — pagination', () => {
  test('the pager appears now that the endpoint reports more than one page', async () => {
    renderPage();
    // It never rendered before: with no `pagination` in the response,
    // useResource fell back to pages: 1 and Pagination returned null.
    expect(await screen.findByRole('navigation', { name: /pagination/i })).toBeInTheDocument();
  });

  test('paging requests the next page and keeps the active filters', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('navigation', { name: /pagination/i });

    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(lastInventoryUrl()).toContain('page=2'));
  });

  test('no pager when everything fits on one page', async () => {
    respond({ pages: 1 });
    renderPage();
    await screen.findByText(/40 medicines out of stock/);
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
  });
});

describe('InventoryPage — accessibility', () => {
  test('has no axe violations', async () => {
    const { container } = renderPage();
    await screen.findByText(/40 medicines out of stock/);
    await checkA11y(container);
  });
});
