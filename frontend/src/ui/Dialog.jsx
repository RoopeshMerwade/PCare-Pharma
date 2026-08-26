import { forwardRef } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { cn } from '../lib/cn';
import Button from './Button';

/* ═══════════════════════════════════════════════════════════════════════════
   Dialog — replaces sixteen hand-rolled `fixed inset-0` overlays across twelve
   files, none of which trapped focus, handled Escape, locked background
   scroll, or restored focus to the trigger on close.

   That list is precisely why this is built on Radix rather than by hand: A5
   ("Escape closes every modal", "no keyboard traps") and A10 ("focus must not
   silently move or vanish") are the requirements hand-rolled overlays fail,
   and they fail quietly — the modal still looks correct.

   Elevation follows §2.4: shadow.2 for anything above the base plane. The
   surface is surface-muted rather than surface-raised, because on the light
   canvas a #F9FAF9 panel against #FFFFFF cards is invisible — elevation is
   carried by the shadow, which is the spec's own elevation model.
   ═══════════════════════════════════════════════════════════════════════════ */

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

/* Title and Description are exposed raw for the one case DialogHeader cannot
   serve: a dialog with no close affordance. DialogHeader always renders one,
   which is right for every dismissable dialog and wrong for a blocking one —
   a close button that deliberately does nothing is worse than no button.
   Radix still requires both for aria-labelledby/describedby, so a caller that
   skips DialogHeader composes them itself. */
export const DialogTitle = RadixDialog.Title;
export const DialogDescription = RadixDialog.Description;

const CloseIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const DialogContent = forwardRef(function DialogContent(
  { className, children, size = 'default', ...props },
  ref
) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-foreground/50 backdrop-blur-sm',
          'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out'
        )}
      />
      <RadixDialog.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
          'flex max-h-[90vh] flex-col overflow-hidden',
          'rounded-card border border-border bg-card shadow-2',
          'data-[state=open]:animate-zoom-in',
          size === 'default' && 'max-w-[32rem]',
          size === 'wide' && 'max-w-[48rem]',
          size === 'narrow' && 'max-w-[24rem]',
          className
        )}
        {...props}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
});

/**
 * Header with the built-in close affordance. Radix requires a Title for
 * aria-labelledby; omitting one logs a warning rather than failing silently,
 * so every dialog in the app goes through this component to get one.
 */
export function DialogHeader({ title, description, className, ...props }) {
  return (
    <div
      className={cn('flex items-start justify-between gap-s3 border-b border-border px-s4 py-s3', className)}
      {...props}
    >
      <div className="min-w-0 flex-1">
        <RadixDialog.Title className="text-sm font-bold text-foreground">{title}</RadixDialog.Title>
        {description ? (
          <RadixDialog.Description className="mt-s1 text-base text-muted-foreground">
            {description}
          </RadixDialog.Description>
        ) : (
          // Radix warns when Content has no Description. Say so explicitly
          // rather than leaving the warning to be ignored in the console.
          <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
        )}
      </div>
      <RadixDialog.Close asChild>
        <Button variant="ghost" size="icon" aria-label="Close">
          <CloseIcon className="h-5 w-5" />
        </Button>
      </RadixDialog.Close>
    </div>
  );
}

/** Scrolls independently, so the header and footer stay pinned. */
export function DialogBody({ className, children, ...props }) {
  return (
    <div className={cn('flex-1 overflow-y-auto p-s4', className)} {...props}>
      {children}
    </div>
  );
}

/**
 * Footer actions. §3.1: at most one primary per region, and on narrow
 * viewports buttons stack rather than shrinking below the padding token.
 */
export function DialogFooter({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'flex flex-row flex-wrap justify-end gap-s2 border-t border-border px-s4 py-s3',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
