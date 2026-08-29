import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import Button from '../../ui/Button';
import Skeleton, { SkeletonRegion } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { BellIcon, ClockIcon } from '../../ui/icons';
import { destinationFor, notificationMeta } from '../../domain/notifications';

/* ═══════════════════════════════════════════════════════════════════════════
   NotificationBell — header entry point with popup panel.
   Matches the sleek modern notification drawer with circular avatars,
   relative timestamps with clock icons, and clean right-aligned unread dots.
   ═══════════════════════════════════════════════════════════════════════════ */

export function UnreadBadge({ count, className }) {
  if (!count) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-4 min-w-4 items-center justify-center rounded-pill px-s1',
        'bg-destructive text-base font-bold leading-none text-destructive-foreground shadow-1',
        className
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'Just now';
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return 'Just now';

  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);

  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function NotificationRow({ notification, isOwner, onSelect }) {
  const meta = notificationMeta(notification.type);
  const Icon = meta.icon;
  const unread = !notification.is_read;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(notification, destinationFor(notification.type, isOwner))}
        className={cn(
          'group flex w-full min-h-target items-start gap-3 bg-card px-4 py-3.5 text-left',
          'transition-colors duration-instant hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none'
        )}
      >
        {/* Left Circular Avatar Icon */}
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base shadow-sm ring-1 ring-border/50',
            meta.wash
          )}
        >
          <Icon className="h-5 w-5" />
        </span>

        {/* Content Column */}
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span
              className={cn(
                'block text-sm leading-snug tracking-tight',
                unread ? 'font-bold text-foreground' : 'font-normal text-muted-foreground'
              )}
            >
              {notification.title}
            </span>
            {unread && (
              <>
                <span className="sr-only">Unread</span>
                <span
                  aria-hidden="true"
                  className="mt-s1 h-2.5 w-2.5 shrink-0 rounded-pill bg-destructive shadow-1 ring-2 ring-destructive/20"
                />
              </>
            )}
          </span>

          {notification.message && (
            <span className="mt-s1 block text-base leading-relaxed text-muted-foreground line-clamp-2">
              {notification.message}
            </span>
          )}

          {/* Time with clock icon */}
          <span className="mt-s1 flex items-center gap-s1 text-base text-muted-foreground font-normal">
            <ClockIcon className="h-3 w-3 inline shrink-0 opacity-70" />
            <span>{formatRelativeTime(notification.created_at)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

export default function NotificationBell({ notifications, isOwner }) {
  const { unreadCount, recentNotifications, loading, error, markAsRead, markAllAsRead, loadRecent } = notifications;
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) loadRecent();
  }, [open, loadRecent]);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const handleSelect = async (notification, to) => {
    setOpen(false);
    navigate(to);
    if (notification.is_read) return;
    try {
      await markAsRead(notification.id);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleMarkAll = async () => {
    try {
      await markAllAsRead();
      toast.success('All notifications marked as read.');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          className="relative text-foreground hover:bg-muted"
        >
          <BellIcon className="h-5 w-5" />
          <UnreadBadge count={unreadCount} className="absolute right-1 top-1" />
        </Button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className={cn(
            'z-50 w-[min(23rem,calc(100vw-1.5rem))] overflow-hidden',
            'rounded-2xl border border-border bg-card shadow-2 animate-fade-in'
          )}
        >
          {/* Top Header matching reference image: Notifications ... View all */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
            <h2 className="text-base font-bold text-foreground tracking-tight">
              Notifications
            </h2>
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAll}
                  className="text-base font-bold text-muted-foreground hover:text-foreground transition-colors duration-instant"
                >
                  Mark read
                </button>
              )}
              <button
                type="button"
                aria-label="View all notifications"
                onClick={() => {
                  setOpen(false);
                  navigate('/notifications');
                }}
                className="text-base font-bold text-accent hover:underline transition-colors duration-instant"
              >
                View all
              </button>
            </div>
          </div>

          {/* List content */}
          <div className="max-h-[24rem] overflow-y-auto">
            {loading && recentNotifications.length === 0 ? (
              // Rows, not a spinner in an empty panel: the panel is a fixed
              // 24rem scroller and the notifications drop straight into these
              // positions, so nothing under the pointer moves when they land.
              <SkeletonRegion label="Loading notifications…" className="flex flex-col gap-s2 p-s3">
                {[0, 1, 2].map((n) => (
                  <div key={n} className="flex items-start gap-s3">
                    <Skeleton className="h-10 w-10 shrink-0 rounded-pill" />
                    <div className="flex min-w-0 flex-1 flex-col gap-s1">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                  </div>
                ))}
              </SkeletonRegion>
            ) : error ? (
              <div className="px-4 py-5 text-center">
                <p className="text-sm font-bold text-foreground">Couldn&rsquo;t load notifications</p>
                <p className="mt-1 text-xs text-muted-foreground">{error.message}</p>
                <Button variant="secondary" size="compact" className="mt-3" onClick={loadRecent}>
                  Try again
                </Button>
              </div>
            ) : recentNotifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-bold text-foreground">Nothing needs your attention</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Low stock, near-expiry items and customer returns appear here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {recentNotifications.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    isOwner={isOwner}
                    onSelect={handleSelect}
                  />
                ))}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
