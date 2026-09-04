import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { checkA11y } from '../../test/axe';
import { ToastProvider } from '../../ui/Toast';
import { ThemeProvider } from '../../hooks/useTheme';
import AppShell from './AppShell';

/* AppShell carries the two rules that are security concerns as much as UI
   ones: role-restricted navigation must be ABSENT for staff rather than
   disabled (A9, §3.6), and the skip link must be the first focusable element
   on every page (§3.6). Both are invisible in a screenshot. */

const mockAuth = vi.hoisted(() => ({ current: null }));
const mockNotifications = vi.hoisted(() => ({ current: null }));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => mockAuth.current,
}));

/* Stubbed for the same reason useAuth is: the shell polls /notifications/count
   on mount, and these tests are about navigation, not the network. */
vi.mock('../../hooks/useNotifications', () => ({
  default: () => mockNotifications.current,
}));

const renderShell = (user, { unreadCount = 0 } = {}) => {
  mockAuth.current = {
    user,
    isOwner: user.role === 'owner',
    logout: vi.fn(),
    loading: false,
  };
  mockNotifications.current = {
    unreadCount,
    recentNotifications: [],
    loading: false,
    error: null,
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    loadRecent: vi.fn(),
    refresh: vi.fn(),
  };
  return render(
    // ThemeProvider & ToastProvider mirror App.jsx's real provider stack
    <ThemeProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={['/inventory']}>
          <AppShell title="Inventory">
            <p>Page content</p>
          </AppShell>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>
  );
};

const OWNER = { full_name: 'Roopesh Gowda', role: 'owner' };
const STAFF = { full_name: 'Priya Nair', role: 'staff' };

beforeEach(() => { mockAuth.current = null; });

describe('AppShell — A9 role scoping', () => {
  const OWNER_ONLY = ['Suppliers', 'Purchase orders', 'Supplier returns', 'Reports', 'Settings', 'Audit log', 'Categories'];

  it('omits owner-only navigation from a Staff session entirely', () => {
    renderShell(STAFF);
    for (const label of OWNER_ONLY) {
      // Not "present but disabled" — a greyed-out Vendor Payments link tells
      // Staff a feature exists that they are blocked from (§3.6).
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
  });

  it('shows them to an Owner', () => {
    renderShell(OWNER);
    for (const label of OWNER_ONLY) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('gives each role its own home destination', () => {
    renderShell(STAFF);
    expect(screen.getByRole('link', { name: 'Today' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});

describe('AppShell — §3.6 navigation', () => {
  it('puts "Skip to main content" first in the tab order', async () => {
    renderShell(OWNER);
    await userEvent.tab();
    expect(document.activeElement).toHaveTextContent('Skip to main content');
    expect(document.activeElement).toHaveAttribute('href', '#main-content');
  });

  it('marks the current page with aria-current, not colour alone (A4)', () => {
    renderShell(OWNER);
    const current = screen.getAllByRole('link', { name: 'Inventory' })[0];
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('gives the drawer trigger a real button with aria-expanded', () => {
    renderShell(OWNER);
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('has no axe violations for either role', async () => {
    const owner = renderShell(OWNER);
    expect(await checkA11y(owner.container)).toHaveNoViolations();
    owner.unmount();

    const staff = renderShell(STAFF);
    expect(await checkA11y(staff.container)).toHaveNoViolations();
  });
});

describe('AppShell — account menu', () => {
  it('carries identity and sign-out in the header, not the rail', async () => {
    renderShell(OWNER);

    // Log out is behind the menu, never a bare button beside the bell — one
    // stray thumb at the counter must not end the session.
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Account: Roopesh Gowda/ }));
    expect(screen.getByRole('menuitem', { name: /log out/i })).toBeInTheDocument();
  });

  it('logs out from the menu item', async () => {
    renderShell(OWNER);
    await userEvent.click(screen.getByRole('button', { name: /Account: Roopesh Gowda/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /log out/i }));
    expect(mockAuth.current.logout).toHaveBeenCalled();
  });

  it('names the account button for staff too, where the label is hidden below lg', () => {
    renderShell(STAFF);
    // Below lg the trigger is an avatar with two initials in it, so the whole
    // identity has to survive in the accessible name (A10).
    expect(screen.getByRole('button', { name: /Account: Priya Nair/ })).toBeInTheDocument();
  });
});

describe('AppShell — pinned Settings', () => {
  it('sits in its own landmark at the foot of the rail, outside the scrolling groups', () => {
    renderShell(OWNER);
    const footer = screen.getByRole('navigation', { name: 'Settings' });
    expect(footer).toContainElement(screen.getByRole('link', { name: 'Settings' }));
    // Not duplicated back into the System group it was moved out of.
    expect(screen.getAllByRole('link', { name: 'Settings' })).toHaveLength(1);
  });

  it('is absent entirely for Staff, landmark included', () => {
    renderShell(STAFF);
    expect(screen.queryByRole('navigation', { name: 'Settings' })).not.toBeInTheDocument();
  });
});

describe('AppShell — notification bell', () => {
  it('reaches Staff too, not just Owner', () => {
    renderShell(STAFF, { unreadCount: 2 });
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
  });

  it('carries the unread count in the accessible name, not colour alone (A4)', () => {
    renderShell(OWNER, { unreadCount: 3 });
    // The red dot is aria-hidden decoration; the count has to survive without it.
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Notifications, 3 unread' }).length).toBeGreaterThan(0);
  });

  it('drops the count from the name when nothing is unread', () => {
    renderShell(OWNER, { unreadCount: 0 });
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('caps the badge at 9+ so a long count cannot break the rail', () => {
    renderShell(OWNER, { unreadCount: 42 });
    expect(screen.getAllByText('9+').length).toBeGreaterThan(0);
    // The precise figure is still announced even though the badge is capped.
    expect(screen.getByRole('button', { name: 'Notifications, 42 unread' })).toBeInTheDocument();
  });

  it('opens a panel with a route to the full list', async () => {
    renderShell(OWNER, { unreadCount: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    expect(screen.getByRole('button', { name: /View all notifications/ })).toBeInTheDocument();
    expect(mockNotifications.current.loadRecent).toHaveBeenCalled();
  });

  it('closes the panel on Escape', async () => {
    renderShell(OWNER, { unreadCount: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    expect(screen.getByRole('button', { name: /View all notifications/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /View all notifications/ })).not.toBeInTheDocument();
  });
});
