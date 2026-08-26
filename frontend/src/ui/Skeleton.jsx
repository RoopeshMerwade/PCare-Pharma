import { cn } from '../lib/cn';

/**
 * Loading placeholder. §3.3/§3.4/§3.7 all require the skeleton to match the
 * final layout so nothing reflows when real content lands.
 *
 * aria-hidden on purpose: the busy state is announced by the region that owns
 * the fetch (A10), and a screen reader reading out a row of grey boxes is
 * noise. `animate-pulse` is disabled app-wide under prefers-reduced-motion.
 */
export default function Skeleton({ className, ...props }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-control bg-border', className)}
      {...props}
    />
  );
}

/** Rows sized to the list they stand in for. */
export function SkeletonRows({ count = 5, className }) {
  return (
    <div className="flex flex-col gap-s2">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn('h-target w-full', className)} />
      ))}
    </div>
  );
}
