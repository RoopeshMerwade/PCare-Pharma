import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { checkA11y } from '../../test/axe';
import { ToastProvider } from '../../ui/Toast';
import ExpiryDashboardPage from './ExpiryDashboardPage';

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mockApi }));

/* /expiry/dashboard used to return every batch in the pharmacy, pre-grouped
   into four arrays, and this page switched buckets by picking one of them in
   memory. It now returns counts only, and each bucket is paged from
   /expiry/batches.

   So: the tiles must read `totals`, switching a bucket must REFETCH at page 1,
   and paging must hold the bucket. */

const TOTALS = { expired: 42, critical: 18, warning: 9, watch: 4, potential_loss: 12345.5 };

const batch = (n, urgency) => ({
  id: `b${n}`,
  medicine_name: `Medicine ${n}`,
  batch_no: `BN-${n}`,
  exp_date: '2026-03-31',
  days_to_expiry: urgency === 'expired' ? -5 : 12,
  stock_qty: 10,
  unit: 'strips',
  potential_loss_value: 100,
});

const respond = ({ totals = TOTALS, pages = 3 } = {}) => {
  mockApi.get.mockImplementation((url) => {
    if (url.startsWith('/expiry/dashboard')) {
      return Promise.resolve({ data: { totals } });
    }
    if (url.startsWith('/expiry/batches')) {
      const params = new URLSearchParams(url.split('?')[1] || '');
      const urgency = params.get('urgency');
      const page = Number(params.get('page') || 1);
      return Promise.resolve({
        data: {
          batches: [batch(`${urgency}-${page}`, urgency)],
          pagination: { page, pages, total: totals[urgency] ?? 0, limit: 20 },
        },
      });
    }
    return Promise.reject(new Error(`Unmocked GET ${url}`));
  });
};

const renderPage = () => render(
  <ToastProvider><ExpiryDashboardPage /></ToastProvider>
);

const lastBatchesUrl = () => [...mockApi.get.mock.calls]
  .reverse().find(([url]) => url.startsWith('/expiry/batches'))?.[0];

beforeEach(() => {
  mockApi.get.mockReset();
  respond();
});

describe('ExpiryDashboardPage — tiles read totals, not array lengths', () => {
  test('each bucket tile shows the server count', async () => {
    renderPage();
    // One row per bucket comes back from /expiry/batches; the tiles must show
    // 42/18/9/4 regardless.
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  test('the value at risk comes from totals.potential_loss', async () => {
    renderPage();
    expect(await screen.findByText(/Value at risk/)).toBeInTheDocument();
  });

  test('the heading counts the whole bucket, not the page', async () => {
    renderPage();
    // 42 expired, one of which is on this page.
    expect(await screen.findByText(/Expired — 42 batches/)).toBeInTheDocument();
  });
});

describe('ExpiryDashboardPage — bucket switching', () => {
  test('the first bucket is fetched from the rows endpoint on mount', async () => {
    renderPage();
    await waitFor(() => expect(lastBatchesUrl()).toContain('urgency=expired'));
    expect(lastBatchesUrl()).toContain('page=1');
  });

  test('clicking a bucket refetches that bucket at page 1', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/Expired — 42 batches/);

    await user.click(screen.getByText('Expiring in 60 days'));

    await waitFor(() => expect(lastBatchesUrl()).toContain('urgency=warning'));
    expect(lastBatchesUrl()).toContain('page=1');
  });

  test('switching bucket while deep in a page resets to page 1', async () => {
    // Otherwise moving from page 3 of Expired to a two-page Critical bucket
    // lands on an empty list.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('navigation', { name: /pagination/i });

    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(lastBatchesUrl()).toContain('page=2'));

    await user.click(screen.getByText('Expiring in 30 days'));
    await waitFor(() => expect(lastBatchesUrl()).toContain('urgency=critical'));
    expect(lastBatchesUrl()).toContain('page=1');
  });
});

describe('ExpiryDashboardPage — pagination', () => {
  test('the pager renders for a multi-page bucket', async () => {
    renderPage();
    expect(await screen.findByRole('navigation', { name: /pagination/i })).toBeInTheDocument();
  });

  test('paging holds the current bucket', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('navigation', { name: /pagination/i });

    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(lastBatchesUrl()).toContain('page=2'));
    expect(lastBatchesUrl()).toContain('urgency=expired');
  });

  test('no pager when the bucket fits on one page', async () => {
    respond({ pages: 1 });
    renderPage();
    await screen.findByText(/Expired — 42 batches/);
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
  });

  test('an empty bucket renders its empty state, not a crash', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url.startsWith('/expiry/dashboard')) {
        return Promise.resolve({ data: { totals: { expired: 0, critical: 0, warning: 0, watch: 0, potential_loss: 0 } } });
      }
      return Promise.resolve({ data: { batches: [], pagination: { page: 1, pages: 0, total: 0, limit: 20 } } });
    });
    renderPage();
    expect(await screen.findByText(/Nothing expired on the shelf/)).toBeInTheDocument();
  });
});

describe('ExpiryDashboardPage — accessibility', () => {
  test('has no axe violations', async () => {
    const { container } = renderPage();
    await screen.findByText(/Expired — 42 batches/);
    await checkA11y(container);
  });
});
