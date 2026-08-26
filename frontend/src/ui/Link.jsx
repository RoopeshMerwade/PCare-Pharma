import { forwardRef } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { cva } from 'class-variance-authority';
import { cn } from '../lib/cn';
import Spinner from './Spinner';

/* ═══════════════════════════════════════════════════════════════════════════
   Link — §3.2, second-highest density.

   Two rules that differ from Button and are easy to get backwards:

   · A link MAY truncate (unlike an action label), because the full value stays
     reachable at the destination. It gets a title attribute when it does.

   · A non-actionable link is rendered as PLAIN TEXT, never a greyed-out <a>.
     §3.2 is explicit: a dead link that 404s on click, or one that looks
     clickable but isn't, are both failures. `unavailableReason` renders text
     with an explanation instead of a link.
   ═══════════════════════════════════════════════════════════════════════════ */

const linkVariants = cva(
  'rounded-control transition-colors duration-instant underline-offset-4',
  {
    variants: {
      variant: {
        // Inside prose. Always underlined — with body text in the same
        // paragraph, weight alone is too weak a signal and colour alone
        // fails 1.4.1.
        inline: 'text-accent underline decoration-1 hover:decoration-2',
        // Standing on its own ("View all", a bill number in a cell). Carries
        // both accent colour AND bold weight, so it survives the grayscale
        // test in A4; the underline arrives on hover and focus.
        standalone: 'text-accent font-bold no-underline hover:underline focus-visible:underline',
        // Sits on a dark surface (the nav rail). Inherits its colour.
        onDark: 'text-current no-underline hover:underline focus-visible:underline',
      },
      // §3.2 touch targets must include space.1 beyond the visible text bounds.
      padded: { true: 'inline-block p-s1 -m-s1', false: '' },
    },
    defaultVariants: { variant: 'standalone', padded: false },
  }
);

const Link = forwardRef(function Link(
  {
    to,
    href,
    className,
    variant,
    padded,
    loading = false,
    unavailableReason = null,
    truncate = false,
    children,
    ...props
  },
  ref
) {
  // Rendered as text, not as a disabled anchor. The reason is exposed via
  // title so it is reachable on hover and by assistive tech, rather than
  // leaving the user to click and discover a 404.
  if (unavailableReason) {
    return (
      <span
        className={cn('text-muted-foreground', truncate && 'block truncate', className)}
        title={unavailableReason}
      >
        {children}
      </span>
    );
  }

  const content = (
    <>
      <span className={cn(truncate && 'block truncate')}>{children}</span>
      {/* §3.2: async navigation shows a spinner beside the label; the link
          stays focusable but inert while it resolves. */}
      {loading && <Spinner className="ml-s1 inline h-4 w-4 align-[-2px]" />}
    </>
  );

  const classes = cn(
    linkVariants({ variant, padded }),
    truncate && 'block min-w-0 truncate',
    loading && 'pointer-events-none',
    className
  );

  // A string child can be safely used as the tooltip for a truncated label.
  const title = truncate && typeof children === 'string' ? children : undefined;

  if (to) {
    return (
      <RouterLink ref={ref} to={to} className={classes} title={title} aria-busy={loading || undefined} {...props}>
        {content}
      </RouterLink>
    );
  }

  return (
    <a ref={ref} href={href} className={classes} title={title} aria-busy={loading || undefined} {...props}>
      {content}
    </a>
  );
});

export default Link;
