import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   Toast — one implementation, replacing fourteen copies.

   Every page had its own `const [toast, setToast]` plus a 3.5s setTimeout.
   None announced anything to a screen reader, and because each held a single
   string, a second message silently destroyed the first — so two failures in
   a row showed one error and the user acted on incomplete information.

   This keeps a queue, and routes tone to the right live region: success and
   info are polite (they can wait for a pause in speech), errors are assertive
   (they cannot). Both live in a container that is always mounted, because a
   live region inserted at the same moment as its content is not reliably
   announced.

   Deliberately NOT built on Radix Toast: this has no focus management to get
   wrong, and the dependency would buy nothing.
   ═══════════════════════════════════════════════════════════════════════════ */

const ToastContext = createContext(null);

const DEFAULT_DURATION = 5000;
// Errors stay put. §5's error rule ("state what happened and how to fix it")
// is worthless if the message leaves before it can be read and acted on.
const ERROR_DURATION = 9000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message, { tone = 'info', duration } = {}) => {
      if (!message) return null;
      const id = nextId.current++;
      const life = duration ?? (tone === 'critical' ? ERROR_DURATION : DEFAULT_DURATION);
      setToasts((current) => [...current, { id, message, tone }]);
      if (life !== Infinity) setTimeout(() => dismiss(id), life);
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      /** Neutral acknowledgement. */
      info: (message, opts) => push(message, { ...opts, tone: 'info' }),
      /** §5: the confirmation must echo the action's own words — a button
       *  labelled "Complete Sale" confirms with "Sale completed". */
      success: (message, opts) => push(message, { ...opts, tone: 'ok' }),
      /** Something failed. Says what happened and what to do about it. */
      error: (message, opts) => push(message, { ...opts, tone: 'critical' }),
      dismiss,
    }),
    [push, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/* Both regions are always mounted so the announcement fires when a
          message is inserted into them. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-s2 p-s4 sm:inset-x-auto sm:right-0 sm:top-0 sm:items-end"
        // Bottom-anchored on mobile so it clears the bottom nav bar, and it
        // never covers the primary action at the counter.
      >
        <ToastRegion
          toasts={toasts.filter((t) => t.tone !== 'critical')}
          onDismiss={dismiss}
          live="polite"
          role="status"
        />
        <ToastRegion
          toasts={toasts.filter((t) => t.tone === 'critical')}
          onDismiss={dismiss}
          live="assertive"
          role="alert"
        />
      </div>
    </ToastContext.Provider>
  );
}

function ToastRegion({ toasts, onDismiss, live, role }) {
  return (
    <div role={role} aria-live={live} aria-atomic="false" className="flex w-full flex-col items-center gap-s2 sm:items-end">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex w-full max-w-[26rem] items-start gap-s3 rounded-card border p-s3 shadow-2 animate-fade-in',
            toast.tone === 'ok' && 'border-success/30 bg-success-wash text-success',
            toast.tone === 'critical' && 'border-destructive/30 bg-destructive-wash text-destructive-ink',
            toast.tone === 'info' && 'border-border bg-card text-foreground'
          )}
        >
          <p className="flex-1 text-base font-bold">{toast.message}</p>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss"
            className="-m-s1 shrink-0 rounded-control p-s1 transition-colors duration-instant hover:bg-foreground/10"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
