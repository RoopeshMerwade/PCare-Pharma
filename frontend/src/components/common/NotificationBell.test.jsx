import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../ui/Toast';
import NotificationBell from './NotificationBell';

/* Two kinds of row reach this panel and they are dated differently.

   An EVENT is a fact about a moment — "Ravi checked in" — and a relative
   timestamp is exactly right for it.

   An ALERT (expiry, low stock) is a condition computed per request. It carries
   `context` instead, because a timestamp would be a lie in both directions:
   low stock has no derivable onset at all, and a batch that entered the
   critical window a month ago would print "Just now" on every 60-second poll.
   These tests pin that split, and the id shape the dismissal path depends on. */

const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => mockNavigate,
}));

const ALERT = {
  id: 'alert:NEAR_EXPIRY:b1111111-2222-4333-8444-555555555555:critical',
  type: 'NEAR_EXPIRY',
  title: 'Dolo 650 — expires in 12 days',
  message: 'Batch B12 · 40 strips',
  context: 'Expires in 12 days',
  is_read: false,
  created_at: '2026-11-01',
  derived: true,
};

const EVENT = {
  id: '99999999-8888-4777-8666-555555555555',
  type: 'STAFF_CHECK_IN',
  title: 'Ravi checked in',
  message: '09:02 am',
  is_read: false,
  created_at: new Date().toISOString(),
};

const notifications = (over = {}) => ({
  unreadCount: 1,
  recentNotifications: [],
  loading: false,
  error: null,
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn(),
  loadRecent: vi.fn(),
  refresh: vi.fn(),
  ...over,
});

const renderBell = (props) =>
  render(
    <ToastProvider>
      <MemoryRouter>
        <NotificationBell notifications={props} isOwner />
      </MemoryRouter>
    </ToastProvider>
  );

const openPanel = async (user) =>
  user.click(screen.getByRole('button', { name: /notifications/i }));

beforeEach(() => mockNavigate.mockClear());

describe('NotificationBell — derived alerts', () => {
  it('prints an alert’s condition, not a relative time', async () => {
    const user = userEvent.setup();
    renderBell(notifications({ recentNotifications: [ALERT] }));
    await openPanel(user);

    expect(screen.getByText('Expires in 12 days')).toBeInTheDocument();
    // The onset date must not leak through as "10 months ago" or "Just now".
    expect(screen.queryByText(/ago$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Just now')).not.toBeInTheDocument();
  });

  it('still dates a stored event relatively', async () => {
    const user = userEvent.setup();
    renderBell(notifications({ recentNotifications: [EVENT] }));
    await openPanel(user);

    expect(screen.getByText('Just now')).toBeInTheDocument();
  });

  it('dates each kind its own way in one list', async () => {
    const user = userEvent.setup();
    renderBell(notifications({ recentNotifications: [ALERT, EVENT], unreadCount: 2 }));
    await openPanel(user);

    expect(screen.getByText('Expires in 12 days')).toBeInTheDocument();
    expect(screen.getByText('Just now')).toBeInTheDocument();
  });

  it('dismisses by the alert KEY, which is what the server branches on', async () => {
    const user = userEvent.setup();
    const props = notifications({ recentNotifications: [ALERT] });
    renderBell(props);
    await openPanel(user);
    await user.click(screen.getByRole('button', { name: /Dolo 650/ }));

    // Passing anything but the full `alert:` key would either 422 at the
    // validator or mark an unrelated notification read.
    expect(props.markAsRead).toHaveBeenCalledWith(ALERT.id);
    expect(mockNavigate).toHaveBeenCalledWith('/expiry');
  });

  it('sends a low-stock alert to the filtered inventory list', async () => {
    const user = userEvent.setup();
    const lowStock = {
      ...ALERT,
      id: 'alert:LOW_STOCK:m2222222-3333-4444-8555-666666666666:out',
      type: 'LOW_STOCK',
      title: 'Azithral 500 is out of stock',
      context: 'Out of stock',
      created_at: null,
    };
    renderBell(notifications({ recentNotifications: [lowStock] }));
    await openPanel(user);

    // A null created_at must not fall back to "Just now" — context covers it.
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(screen.queryByText('Just now')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Azithral 500/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/inventory?stock=low');
  });
});
