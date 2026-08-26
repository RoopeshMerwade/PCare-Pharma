import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from './useAuth';

/* ═══════════════════════════════════════════════════════════════════════════
   useNotifications — the unread count for the header bell.

   Two endpoints with deliberately different cadences:

     /notifications/count  polled, because the badge must go stale-free on its
                           own. It is a HEAD-style count on the server, so it
                           is cheap enough to run on a timer.
     /notifications        fetched only when the popover actually opens. The
                           list returns up to 50 rows; pulling that every
                           minute to render five of them would be waste.

   Polling pauses while the tab is hidden and catches up the moment it is
   focused again — a counter hand leaves this open all day, and a background
   tab firing a request every minute for eight hours is real load for no
   benefit. Nothing polls while logged out, or the interval would fire 401s
   against a cleared session after logout.

   Call this ONCE per tree (AppShell does) and pass the result down. Two call
   sites means two intervals.
   ═══════════════════════════════════════════════════════════════════════════ */

const POLL_MS = 60_000;
const RECENT_LIMIT = 6;

export default function useNotifications({ pollMs = POLL_MS } = {}) {
  const { user } = useAuth();

  const [unreadCount, setUnreadCount] = useState(0);
  const [recentNotifications, setRecentNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Guards a slow response from overwriting a newer one, and guards setState
  // after unmount — the same hazard useResource solves with a request id.
  const listRequestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refreshCount = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api.get('/notifications/count');
      // NOTE: the controller emits `unread_count`, not `count`.
      if (mounted.current) setUnreadCount(res.data.unread_count ?? 0);
    } catch {
      // A failed count is not worth an error state — the badge simply holds
      // its last value. Surfacing "couldn't load notifications" over the whole
      // shell because one poll missed would be worse than a stale number.
    }
  }, [user]);

  const loadRecent = useCallback(async () => {
    if (!user) return;
    const id = ++listRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/notifications');
      if (id !== listRequestId.current || !mounted.current) return;
      setRecentNotifications((res.data.notifications || []).slice(0, RECENT_LIMIT));
    } catch (err) {
      if (id !== listRequestId.current || !mounted.current) return;
      setError(err);
    } finally {
      if (id === listRequestId.current && mounted.current) setLoading(false);
    }
  }, [user]);

  /** Count + list together, for after an action that may have changed both. */
  const refresh = useCallback(async () => {
    await Promise.all([refreshCount(), loadRecent()]);
  }, [refreshCount, loadRecent]);

  // ── Initial fetch + poll ────────────────────────────────────────────────
  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      setRecentNotifications([]);
      return undefined;
    }

    refreshCount();

    const tick = () => { if (!document.hidden) refreshCount(); };
    const timer = setInterval(tick, pollMs);

    const onVisible = () => { if (!document.hidden) refreshCount(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, pollMs, refreshCount]);

  // ── Mutations ───────────────────────────────────────────────────────────
  /* Both apply optimistically and roll back on failure. Pretending a mark
     succeeded would silently drop a real alert off the badge — the same
     reasoning NotificationsPage documents on its own revert. */

  const markAsRead = useCallback(async (id) => {
    let wasUnread = false;
    setRecentNotifications((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n;
        wasUnread = !n.is_read;
        return { ...n, is_read: true };
      })
    );
    if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1));

    try {
      await api.patch(`/notifications/${id}/read`);
    } catch (err) {
      setRecentNotifications((ns) => ns.map((n) => (n.id === id ? { ...n, is_read: false } : n)));
      if (wasUnread) setUnreadCount((c) => c + 1);
      throw err;
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    const previousCount = unreadCount;
    const previousList = recentNotifications;
    setUnreadCount(0);
    setRecentNotifications((ns) => ns.map((n) => ({ ...n, is_read: true })));

    try {
      await api.patch('/notifications/read-all');
    } catch (err) {
      setUnreadCount(previousCount);
      setRecentNotifications(previousList);
      throw err;
    }
  }, [unreadCount, recentNotifications]);

  return {
    unreadCount,
    recentNotifications,
    loading,
    error,
    markAsRead,
    markAllAsRead,
    loadRecent,
    refresh,
  };
}
