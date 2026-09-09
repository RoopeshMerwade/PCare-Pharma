import { BellIcon, BoxIcon, ClockIcon, ReturnIcon, AlertIcon, UsersIcon, ClipboardIcon } from '../ui/icons';

/* ═══════════════════════════════════════════════════════════════════════════
   Notification registry — one table, read by both the header bell and the
   full /notifications page.

   Previously the type→icon map lived inside SettingsPages.jsx, which meant the
   bell would have had to duplicate it. It had also drifted from the backend, so
   a type it did not list fell through to a generic bell icon. Same failure mode
   StatusBadge exists to prevent — two screens disagreeing about what a thing is.

   Two sources feed this table. Most types are EVENTS: stored rows written when
   something happened (a staff arrival, a requisition decision). NEAR_EXPIRY and
   LOW_STOCK are ALERTS: computed per request from expiry_summary and
   medicines_with_stock, never stored, and silenced through
   notification_dismissals rather than an is_read flag. Both arrive in the same
   payload shape, so nothing here needs to know which is which — an alert simply
   also carries `context` and `derived: true`.

   `to` is where the alert is actionable. Several of those routes are
   owner-only (App.jsx guards /expiry, /purchases, /supplier-returns with
   role="owner"), so `ownerOnly` marks them: sending Staff there would bounce
   them to /unauthorized, which reads as a broken notification rather than a
   permission boundary. `destinationFor` degrades those to the notifications
   list instead.
   ═══════════════════════════════════════════════════════════════════════════ */

const TYPES = {
  /* Derived alert (Module 36), owner-only in the payload. The filtered
     destination is the one OwnerDashboard's "Running low" card already links
     to — landing on the unfiltered list would make the reader re-find the row
     they were just told about. */
  LOW_STOCK: {
    icon: BoxIcon,
    to: '/inventory?stock=low',
    /* Wash tones mirror the Badge ramp: low stock is amber, never mint. */
    wash: 'bg-warning-wash text-warning-ink',
  },
  /* Derived alert (Module 36). ownerOnly is now belt-and-braces: the server
     never puts one in a staff payload, because expiry decisions are the
     owner's and /expiry is authorize('owner'). */
  NEAR_EXPIRY: {
    icon: ClockIcon,
    to: '/expiry',
    ownerOnly: true,
    wash: 'bg-warning-wash text-warning-ink',
  },
  CUSTOMER_RETURN_PENDING: {
    icon: ReturnIcon,
    to: '/customer-returns',
    wash: 'bg-warning-wash text-warning-ink',
  },
  SUPPLIER_RETURN_PENDING: {
    icon: ReturnIcon,
    to: '/supplier-returns',
    ownerOnly: true,
    wash: 'bg-warning-wash text-warning-ink',
  },
  PURCHASE_OVERDUE: {
    icon: AlertIcon,
    to: '/purchases',
    ownerOnly: true,
    wash: 'bg-destructive-wash text-destructive-ink',
  },
  /* Chronic-care patients who have not collected a refill. A person, not a
     stock line — hence the different icon. Nothing raises this today: it was
     one of the branches of the never-called generateAlerts, removed in Module
     36. Kept here so it renders correctly if the derived framework is extended
     to cover it, which is a builder function and a query. */
  REFILL_OVERDUE: {
    icon: UsersIcon,
    to: '/customers',
    wash: 'bg-destructive-wash text-destructive-ink',
  },
  /* Module 26. Raised on every staff arrival and departure and addressed to
     the owner, so the destination is the owner dashboard the board lives on —
     ownerOnly, because App.jsx guards /dashboard and bouncing Staff to
     /unauthorized would read as a broken notification rather than a boundary.

     Not an alert: an arrival is good news and a departure is routine, so
     neither wears the warning or destructive wash. They are the only two
     entries in this table that are purely informational, which is the point —
     the bell stops meaning "something is wrong" only if these look different
     from the ones that do. */
  STAFF_CHECK_IN: {
    icon: ClockIcon,
    to: '/dashboard',
    ownerOnly: true,
    wash: 'bg-success-wash text-success',
  },
  STAFF_CHECK_OUT: {
    icon: ClockIcon,
    to: '/dashboard',
    ownerOnly: true,
    wash: 'bg-muted text-muted-foreground',
  },
  /* Module 30. All three land on /stock-requisitions, and NONE of them is
     ownerOnly — that would be a bug rather than caution. The route is open to
     both roles, so degrading the destination would strand the owner one click
     from the queue they were just told about, and would bounce the staff member
     away from the outcome of their own request. */
  STOCK_REQUISITION_RAISED: {
    icon: ClipboardIcon,
    to: '/stock-requisitions',
    wash: 'bg-warning-wash text-warning-ink',
  },
  STOCK_REQUISITION_APPROVED: {
    icon: ClipboardIcon,
    to: '/stock-requisitions',
    wash: 'bg-success-wash text-success',
  },
  STOCK_REQUISITION_REJECTED: {
    icon: ClipboardIcon,
    to: '/stock-requisitions',
    wash: 'bg-destructive-wash text-destructive-ink',
  },
  SYSTEM: {
    icon: BellIcon,
    to: '/notifications',
    wash: 'bg-muted text-muted-foreground',
  },
};

const FALLBACK = TYPES.SYSTEM;

export function notificationMeta(type) {
  return TYPES[type] || FALLBACK;
}

/**
 * Where clicking a notification should land, given who is looking at it.
 * Staff never get routed into an owner-only page.
 */
export function destinationFor(type, isOwner) {
  const meta = notificationMeta(type);
  if (meta.ownerOnly && !isOwner) return '/notifications';
  return meta.to;
}

export { TYPES as NOTIFICATION_TYPES };
