import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import useNotifications from '../../hooks/useNotifications';
import { cn } from '../../lib/cn';
import { initials } from '../../lib/format';
import Button from '../../ui/Button';
import { Drawer, DrawerContent } from '../../ui/Drawer';
import NotificationBell, { UnreadBadge } from './NotificationBell';
import ThemeToggle from './ThemeToggle';
import {
  HomeIcon, BillIcon, ListIcon, BoxIcon, PillIcon, UsersIcon, ReturnIcon,
  TruckIcon, CartIcon, ClockIcon, ChartIcon, TagIcon, BellIcon, GearIcon,
  ShieldIcon, LogoutIcon, ChevronIcon, MenuIcon, CloseIcon, ScanDocIcon,
  ClipboardIcon,
} from '../../ui/icons';

/* ═══════════════════════════════════════════════════════════════════════════
   AppShell — §3.6. One nav item by the spec's density count, but load-bearing
   for the entire app.

   Role scoping is an information-architecture rule, not a styling one: an item
   the current role may not use is ABSENT, never disabled. §3.6 is explicit
   that a greyed-out "Vendor Payments" tells Staff a feature exists that they
   are blocked from, which leaks the shape of the system.

   The nav is declared once and rendered twice — as the desktop rail and as the
   drawer below `lg` — so the two can never drift apart. The drawer is the
   shared Drawer primitive, which brings the focus trap, Escape handling and
   scroll lock that the previous hand-rolled version did not have.
   ═══════════════════════════════════════════════════════════════════════════ */

const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: HomeIcon, role: 'owner' },
      { to: '/staff',     label: 'Today',     icon: HomeIcon, role: 'staff' },
    ],
  },
  {
    label: 'Counter',
    items: [
      { to: '/billing/new', label: 'New bill',  icon: BillIcon },
      { to: '/billing',     label: 'Bills',     icon: ListIcon },
      { to: '/inventory',   label: 'Inventory', icon: BoxIcon },
      { to: '/medicines',   label: 'Medicines', icon: PillIcon },
    ],
  },
  {
    label: 'Patients',
    items: [
      { to: '/customers',        label: 'Customers', icon: UsersIcon },
      { to: '/customer-returns', label: 'Returns',   icon: ReturnIcon },
    ],
  },
  {
    label: 'Business',
    items: [
      // No `role`: staff run the goods-inward desk and correct the drafts. Only
      // the owner's Approve creates stock, and that guard is on the API route —
      // hiding the whole page from staff would just mean the owner typing every
      // invoice themselves.
      // Module 30, and no `role` for the same reason: noticing the shelf is
      // empty is the counter's job, so staff raise the request and read their
      // own. Approving it and downloading the order are owner-only, and both
      // guards sit on the API route rather than on this link.
      { to: '/stock-requisitions', label: 'Stock requests',   icon: ClipboardIcon },
      { to: '/supplier-invoices', label: 'Supplier invoices', icon: ScanDocIcon },
      { to: '/suppliers',        label: 'Suppliers',        icon: TruckIcon, role: 'owner' },
      { to: '/purchases',        label: 'Purchase orders',  icon: CartIcon,  role: 'owner' },
      { to: '/supplier-returns', label: 'Supplier returns', icon: ReturnIcon, role: 'owner' },
      { to: '/expiry',           label: 'Expiry tracker',   icon: ClockIcon, role: 'owner' },
      { to: '/reports',          label: 'Reports',          icon: ChartIcon, role: 'owner' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/categories',    label: 'Categories',    icon: TagIcon,    role: 'owner' },
      { to: '/users',         label: 'Staff',         icon: UsersIcon,  role: 'owner' },
      { to: '/notifications', label: 'Notifications', icon: BellIcon },
      { to: '/settings',      label: 'Settings',      icon: GearIcon,   role: 'owner' },
      { to: '/audit-logs',    label: 'Audit log',     icon: ShieldIcon, role: 'owner' },
    ],
  },
];

// The five a counter hand needs within one thumb's reach.
const MOBILE_PRIMARY = [
  { to: '/dashboard', toStaff: '/staff', label: 'Home',     icon: HomeIcon },
  { to: '/billing/new',                  label: 'Bill',     icon: BillIcon },
  { to: '/customers',                    label: 'Patients', icon: UsersIcon },
  { to: '/inventory',                    label: 'Stock',    icon: BoxIcon },
  { to: '/notifications',                label: 'Alerts',   icon: BellIcon },
];

const SIDEBAR_KEY = 'pcare.sidebarCollapsed';

export default function AppShell({ children, title }) {
  const { user, isOwner, logout } = useAuth();
  const navigate = useNavigate();

  // One instance for the whole shell — the bell, the sidebar item and the
  // bottom bar all read this same count. See the note in useNotifications.
  const notifications = useNotifications();

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleSidebar = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  };

  // Items the current role has no business seeing never reach the DOM.
  const visibleGroups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.role || i.role === user?.role) }))
    .filter((g) => g.items.length > 0);

  const handleLogout = async () => { await logout(); navigate('/login'); };

  return (
    <div className="min-h-screen bg-background lg:flex lg:h-screen lg:overflow-hidden">
      {/* §3.6 requires this to be the first focusable element on the page. */}
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* ── Desktop rail (lg+) ─────────────────────────────────────────── */}
      <aside
        className={cn(
          'hidden shrink-0 border-r border-border bg-card lg:flex lg:h-screen lg:flex-col',
          'transition-[width] duration-instant ease-out',
          collapsed ? 'lg:w-[76px]' : 'lg:w-64'
        )}
      >
        <SidebarPanel
          collapsed={collapsed}
          groups={visibleGroups}
          user={user}
          unreadCount={notifications.unreadCount}
          onLogout={handleLogout}
          headerAction={
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
            >
              <ChevronIcon className={cn('h-[18px] w-[18px] transition-transform duration-instant', collapsed && 'rotate-180')} />
            </Button>
          }
        />
      </aside>

      {/* ── Drawer (< lg) — the shared modal primitive, not a bespoke one ── */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerContent side="left" className="w-[min(17rem,85vw)] lg:hidden">
          <SidebarPanel
            collapsed={false}
            groups={visibleGroups}
            user={user}
            unreadCount={notifications.unreadCount}
            onLogout={handleLogout}
            onNavigate={() => setDrawerOpen(false)}
            titleId="drawer-title"
            headerAction={
              <Button variant="ghost" size="icon" onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
                <CloseIcon className="h-[18px] w-[18px]" />
              </Button>
            }
          />
        </DrawerContent>
      </Drawer>

      {/* ── Main column ─────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col lg:h-screen lg:overflow-hidden">
        <header className="sticky top-0 z-30 flex shrink-0 items-center justify-between gap-s3 border-b border-border bg-card/95 px-s4 py-s2 backdrop-blur lg:px-s6">
          <div className="flex items-center gap-s2 lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
            >
              <MenuIcon className="h-5 w-5" />
            </Button>
            <BrandMark compact />
          </div>

          {title && <h1 className="hidden text-md font-bold text-foreground lg:block">{title}</h1>}

          <div className="ml-auto flex items-center gap-s2">
            <ThemeToggle />
            <NotificationBell notifications={notifications} isOwner={isOwner} />
          </div>
        </header>

        {/* The shell owns page padding. Page components must not add their own
            page-level padding — mobile loses 32px of width when they do. */}
        <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto px-s4 py-s5 pb-bottombar lg:px-s6 lg:pb-s6">
          <div className="w-full">{children}</div>
        </main>
      </div>

      {/* ── Bottom bar (< lg) ───────────────────────────────────────────── */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-border bg-card px-s2 py-s1 lg:hidden"
      >
        {MOBILE_PRIMARY.map((item) => (
          <NavLink
            key={item.label}
            to={isOwner ? item.to : (item.toStaff || item.to)}
            end
            aria-label={
              item.to === '/notifications' && notifications.unreadCount > 0
                ? `${item.label}, ${notifications.unreadCount} unread`
                : undefined
            }
            className={({ isActive }) =>
              cn(
                'relative flex min-h-target min-w-target flex-col items-center justify-center gap-s1 rounded-control px-s2 py-s1',
                'transition-colors duration-instant',
                isActive ? 'font-bold text-accent' : 'text-muted-foreground'
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon className={cn('h-5 w-5', isActive && 'stroke-[2.4]')} />
                <span className="text-base">{item.label}</span>
                {item.to === '/notifications' && (
                  <UnreadBadge count={notifications.unreadCount} className="absolute right-s1 top-0" />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/* Rendered twice — as the rail and as the drawer — so navigation cannot drift
   between breakpoints. `collapsed` is icon-only mode and applies to the rail
   only; the drawer is never collapsed. */
function SidebarPanel({ collapsed, groups, user, unreadCount = 0, onLogout, headerAction, onNavigate, titleId }) {
  return (
    <>
      <div className={cn('flex shrink-0 py-s4', collapsed ? 'flex-col items-center gap-s3 px-s2' : 'items-center justify-between gap-s2 px-s4')}>
        <BrandMark compact={collapsed} titleId={titleId} />
        {headerAction}
      </div>

      <nav
        aria-label="Main"
        className={cn('sidebar-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-s4', collapsed ? 'px-s2' : 'px-s3')}
      >
        <div className="flex flex-col gap-s5">
          {groups.map((group) => (
            <div key={group.label}>
              {collapsed ? (
                <div className="mx-s2 mb-s2 border-t border-border" aria-hidden="true" />
              ) : (
                <p className="mb-s1 px-s3 text-base font-bold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
              )}
              <div className="flex flex-col gap-s1">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    aria-label={
                      item.to === '/notifications' && unreadCount > 0
                        ? `${item.label}, ${unreadCount} unread`
                        : undefined
                    }
                    className={({ isActive }) =>
                      cn(
                        'relative flex min-h-target items-center rounded-control text-base',
                        'transition-colors duration-instant',
                        collapsed ? 'justify-center px-s2' : 'gap-s2 px-s3',
                        // A4: the current item is marked by weight AND fill, so
                        // it survives the grayscale test. NavLink also sets
                        // aria-current="page" for assistive tech.
                        isActive
                          ? 'bg-primary font-bold text-primary-foreground'
                          : 'font-normal text-muted-foreground hover:bg-muted hover:text-foreground'
                      )
                    }
                  >
                    <item.icon className="h-[18px] w-[18px] shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {item.to === '/notifications' && (
                      // Expanded: trails the label. Collapsed: the label is
                      // gone, so it pins to the icon's top-right corner.
                      <UnreadBadge
                        count={unreadCount}
                        className={collapsed ? 'absolute right-s1 top-s1' : 'ml-auto'}
                      />
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className={cn('shrink-0 mt-auto border-t border-border py-s3', collapsed ? 'px-s2' : 'px-s3')}>
        <div
          className={cn('flex items-center py-s2', collapsed ? 'justify-center' : 'gap-s2 px-s3')}
          title={collapsed ? `${user?.full_name} · ${user?.role}` : undefined}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-primary text-base font-bold text-primary-foreground">
            {initials(user?.full_name)}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-bold text-foreground">{user?.full_name}</span>
              <span className="block text-base capitalize text-muted-foreground">{user?.role}</span>
            </span>
          )}
        </div>

        <Button
          variant="ghost"
          onClick={onLogout}
          title={collapsed ? 'Log out' : undefined}
          className={cn('mt-s1 w-full', collapsed ? 'justify-center px-s2' : 'justify-start gap-s2 px-s3')}
        >
          <LogoutIcon className="h-[18px] w-[18px] shrink-0" />
          {!collapsed && 'Log out'}
        </Button>
      </div>
    </>
  );
}

function BrandMark({ compact, titleId }) {
  return (
    <div className="flex items-center gap-s2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-primary text-sm font-bold text-primary-foreground">
        P
      </span>
      {!compact && (
        <span id={titleId}>
          <span className="block text-base font-bold leading-tight text-foreground">P.Care Pharma</span>
          <span className="block text-base leading-tight text-muted-foreground">Gadag · Karnataka</span>
        </span>
      )}
    </div>
  );
}
