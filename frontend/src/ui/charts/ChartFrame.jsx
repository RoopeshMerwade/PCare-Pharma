import { cloneElement } from 'react';
import { ResponsiveContainer } from 'recharts';
import { cn } from '../../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   ChartFrame — sizing and refetch behaviour for every recharts chart.

   - A <figure> with an aria-label names the chart without flattening it:
     role="img" would hide recharts' keyboard accessibility layer from
     assistive tech, and the table view in ChartCard is the accessible twin,
     so the chart itself stays fully interactive.
   - `dimmed` implements "refetch keeps the frame": while fresh data loads,
     the previous render holds at reduced opacity — no skeleton, no layout
     jump, no flash.
   - Passing a NUMERIC `width` bypasses ResponsiveContainer entirely. That is
     the jsdom escape hatch: the test setup stubs ResizeObserver as a no-op,
     so ResponsiveContainer measures 0×0 under vitest and renders nothing.
     Tests pass explicit dimensions; the app leaves width fluid.
   - The container height includes the x-axis band — the chart sizes itself
     inside it, so axis labels never get a tiny nested scrollbar.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function ChartFrame({
  label,
  height = 260,
  width,
  dimmed = false,
  className,
  children,
}) {
  const fixed = typeof width === 'number';
  return (
    <figure
      aria-label={label}
      className={cn(
        'm-0 w-full transition-opacity duration-instant',
        dimmed && 'opacity-60',
        className
      )}
    >
      {fixed ? (
        cloneElement(children, { width, height })
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {children}
        </ResponsiveContainer>
      )}
    </figure>
  );
}
