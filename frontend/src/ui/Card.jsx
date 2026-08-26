import { forwardRef } from 'react';
import { cn } from '../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   Card — §3.3.

   The rule that matters here: hover and focus treatment belongs ONLY to cards
   that actually go somewhere. §3.3 calls implying interactivity where none
   exists an accessibility failure in its own right, because users will try to
   activate it. So an interactive card is a real <button>, and a static card
   is a <div> with no state styling at all — there is no middle setting.
   ═══════════════════════════════════════════════════════════════════════════ */

const base = 'rounded-card bg-card border border-border shadow-1';

const Card = forwardRef(function Card({ className, onClick, as, children, ...props }, ref) {
  if (onClick) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={cn(
          base,
          'w-full text-left transition-colors duration-instant',
          'hover:bg-muted active:bg-border',
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }

  const Comp = as || 'div';
  return (
    <Comp ref={ref} className={cn(base, className)} {...props}>
      {children}
    </Comp>
  );
});

/** Header row: title on the left, optional action on the right. */
export function CardHeader({ className, children, action, ...props }) {
  return (
    <div
      className={cn('flex items-start justify-between gap-s3 px-s4 pt-s4', className)}
      {...props}
    >
      <div className="min-w-0">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardTitle({ className, as: Comp = 'h2', children, ...props }) {
  return (
    <Comp className={cn('text-sm font-bold text-foreground', className)} {...props}>
      {children}
    </Comp>
  );
}

export function CardDescription({ className, children, ...props }) {
  return (
    <p className={cn('text-base text-muted-foreground', className)} {...props}>
      {children}
    </p>
  );
}

/** §3.3 anatomy: space.4 internal padding. */
export function CardBody({ className, children, ...props }) {
  return (
    <div className={cn('p-s4', className)} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...props }) {
  return (
    <div className={cn('flex items-center gap-s3 border-t border-border px-s4 py-s3', className)} {...props}>
      {children}
    </div>
  );
}

export default Card;
