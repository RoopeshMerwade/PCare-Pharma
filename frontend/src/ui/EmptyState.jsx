import { cn } from '../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   EmptyState — §5 and §6.

   "No data available" is prohibited, and every empty state must be written for
   its own context: "No sales yet today. They'll show up here as they're rung
   up." is a different message from "All stock levels healthy."

   This component therefore has NO default copy. Both `title` and `body` are
   required, and omitting either throws in development. A generic empty state
   cannot be shipped by accident — you have to go out of your way to write one.
   ═══════════════════════════════════════════════════════════════════════════ */

const BANNED = [
  'no data',
  'no data available',
  'nothing here',
  'nothing here yet',
  'something went wrong',
  'no results',
];

export default function EmptyState({ title, body, action, className, ...props }) {
  if (import.meta.env.DEV) {
    if (!title || !body) {
      throw new Error(
        'EmptyState requires both `title` and `body`, written for this specific ' +
          'context (§5). A shared default is exactly what this component exists to prevent.'
      );
    }
    if (BANNED.includes(String(title).trim().toLowerCase().replace(/[.!]$/, ''))) {
      throw new Error(
        `EmptyState title "${title}" is a generic placeholder, which §6 prohibits. ` +
          'Say what is empty and what would fill it.'
      );
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-s2 rounded-card border border-border bg-card px-s4 py-s6 text-center',
        className
      )}
      {...props}
    >
      <p className="text-sm font-bold text-foreground">{title}</p>
      <p className="max-w-[46ch] text-base text-muted-foreground">{body}</p>
      {action && <div className="mt-s2">{action}</div>}
    </div>
  );
}
