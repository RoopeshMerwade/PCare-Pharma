import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   Tooltip — for truncated text (§3.3, §3.7) and for explaining why something
   is unavailable (§3.2).

   A tooltip is supplementary, never the only place information lives: it is
   unreachable by touch, so anything essential must also be in the DOM. Used
   here strictly to restore a value that was truncated for space.
   ═══════════════════════════════════════════════════════════════════════════ */

export function TooltipProvider({ children }) {
  return <RadixTooltip.Provider delayDuration={300}>{children}</RadixTooltip.Provider>;
}

export default function Tooltip({ content, children, side = 'top' }) {
  if (!content) return children;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-[70] max-w-[22rem] rounded-control border border-border bg-card px-s2 py-s1',
            'text-base text-foreground shadow-2 animate-fade-in'
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-card" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
