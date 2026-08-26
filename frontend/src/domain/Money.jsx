import { cn } from '../lib/cn';
import { money as formatMoney, qty as formatQty } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════════════
   Money and Qty — the two values §6 says must NEVER truncate.

   "Must not truncate numeric/currency values under any viewport width —
   reflow before truncating a number." So these deliberately carry
   `whitespace-nowrap` and no truncate/ellipsis class, and the layouts around
   them are what give way. A ₹ figure with its last digit cut off is worse
   than a wrapped card.

   font.size.sm (16px) is the floor here rather than the 14px base — §2.1
   escalates specifically for "the numbers a pharmacist checks under pressure".
   ═══════════════════════════════════════════════════════════════════════════ */

export function Money({ value, whole = false, className, tone, ...props }) {
  return (
    <span
      className={cn(
        'tabular whitespace-nowrap text-sm font-bold',
        tone === 'critical' && 'text-destructive',
        tone === 'ok' && 'text-success',
        tone === 'muted' && 'text-muted-foreground',
        className
      )}
      {...props}
    >
      {formatMoney(value, { whole })}
    </span>
  );
}

export function Qty({ value, unit, className, tone, ...props }) {
  return (
    <span
      className={cn(
        'tabular whitespace-nowrap text-sm font-bold',
        tone === 'critical' && 'text-destructive',
        tone === 'low' && 'text-warning',
        tone === 'ok' && 'text-success',
        className
      )}
      {...props}
    >
      {formatQty(value, unit)}
    </span>
  );
}
