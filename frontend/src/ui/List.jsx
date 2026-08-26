import { cn } from '../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   List — §3.4. The row primitive, and the shape Table collapses into below the
   tablet breakpoint, so a record looks the same however it is reached.

   Row height is at least 44px even on desktop. §3.4 asks for that explicitly
   "for consistency" — but it also means a row action can never be smaller than
   its A6 target, which is where per-page row layouts kept drifting.

   De-emphasis (a read notification, a discontinued medicine) uses
   muted-foreground, never opacity. Opacity multiplies against whatever is
   behind it and quietly drops the row below 4.5:1; a token that was chosen to
   pass at 7.48:1 stays passing.
   ═══════════════════════════════════════════════════════════════════════════ */

export function List({ className, children, ...props }) {
  return (
    <ul className={cn('flex flex-col gap-s2', className)} {...props}>
      {children}
    </ul>
  );
}

export function ListRow({
  leading,
  title,
  meta,
  trailing,
  onClick,
  muted = false,
  className,
  children,
  ...props
}) {
  const interactive = Boolean(onClick);

  const inner = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        {title && (
          <span className={cn('block truncate text-base font-bold', muted ? 'text-muted-foreground' : 'text-foreground')}>
            {title}
          </span>
        )}
        {meta && <span className="block truncate text-base text-muted-foreground">{meta}</span>}
        {children}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-s2">{trailing}</span>}
    </>
  );

  const shared = 'flex w-full min-h-target items-center gap-s3 rounded-card border border-border bg-card px-s3 py-s2 text-left';

  return (
    <li className={className}>
      {interactive ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(shared, 'transition-colors duration-instant hover:bg-muted active:bg-border')}
          {...props}
        >
          {inner}
        </button>
      ) : (
        <div className={shared} {...props}>
          {inner}
        </div>
      )}
    </li>
  );
}

/**
 * Label/value pair for the stacked card view of a table row.
 *
 * Numeric values keep font.size.sm and tabular figures here as well as in the
 * table — §2.1's escalation applies to the number, not to the layout it
 * happens to be in.
 */
export function ListField({ label, value, numeric = false, className }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-s3 py-s1', className)}>
      <span className="shrink-0 text-base text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 text-right text-base font-bold text-foreground', numeric && 'tabular text-sm')}>
        {value}
      </span>
    </div>
  );
}

export default List;
