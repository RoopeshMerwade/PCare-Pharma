import { cn } from '../lib/cn';
import Button from './Button';

/* ═══════════════════════════════════════════════════════════════════════════
   ErrorState — §3.3 requires a failed panel to show an inline error with a
   retry, never a silently empty one, and §5 requires the message to say what
   happened rather than apologise.

   Rendered inside the region that failed (a card body, a table region), so
   surrounding filters and navigation stay usable — replacing the whole page
   with an error throws away context the user may need to recover.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function ErrorState({ title, message, onRetry, className, ...props }) {
  if (import.meta.env.DEV && !message) {
    throw new Error(
      'ErrorState requires a `message` describing what failed and what to do (§5). ' +
        '"Something went wrong" is prohibited by §6.'
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-s3 rounded-card border border-destructive/30 bg-destructive-wash p-s4',
        className
      )}
      {...props}
    >
      <div className="flex flex-col gap-s1">
        {title && <p className="text-sm font-bold text-destructive-ink">{title}</p>}
        <p className="text-base text-destructive-ink">{message}</p>
      </div>
      {onRetry && (
        <Button variant="secondary" size="compact" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
