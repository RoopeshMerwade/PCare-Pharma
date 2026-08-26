import { cn } from '../lib/cn';

/**
 * Inline busy indicator. `currentColor` throughout so it inherits whatever
 * surface it lands on and never needs a colour prop.
 *
 * Purely decorative — the announcement belongs to the control that owns it,
 * via aria-busy (A10). Marking this aria-hidden stops screen readers reading
 * a meaningless graphic alongside the real status.
 */
export default function Spinner({ className, label }) {
  return (
    <svg
      className={cn('animate-spin', className || 'h-4 w-4')}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
