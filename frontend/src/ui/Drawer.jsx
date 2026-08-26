import { forwardRef } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { cn } from '../lib/cn';
import Button from './Button';

/* ═══════════════════════════════════════════════════════════════════════════
   Drawer — a side sheet for detail that would otherwise cost a navigation
   (batch lists, a customer's history).

   Shares Radix Dialog's internals with Dialog.jsx rather than reimplementing
   them: it is the same modal contract — focus trap, Escape, scroll lock,
   focus restore — presented against an edge instead of centred. The nav
   drawer in AppShell uses this too, so there is exactly one modal
   implementation in the app.
   ═══════════════════════════════════════════════════════════════════════════ */

export const Drawer = RadixDialog.Root;
export const DrawerTrigger = RadixDialog.Trigger;
export const DrawerClose = RadixDialog.Close;

const CloseIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const DrawerContent = forwardRef(function DrawerContent(
  { className, children, side = 'right', ...props },
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
          'fixed inset-y-0 z-50 flex w-[min(28rem,92vw)] flex-col bg-card shadow-2',
          side === 'right' && 'right-0 border-l border-border data-[state=open]:animate-slide-in-right',
          side === 'left' && 'left-0 border-r border-border data-[state=open]:animate-slide-in-left',
          className
        )}
        {...props}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
});

export function DrawerHeader({ title, description, className, ...props }) {
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

export function DrawerBody({ className, children, ...props }) {
  return (
    <div className={cn('flex-1 overflow-y-auto p-s4', className)} {...props}>
      {children}
    </div>
  );
}

export function DrawerFooter({ className, children, ...props }) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-s2 border-t border-border px-s4 py-s3 sm:flex-row sm:justify-end', className)}
      {...props}
    >
      {children}
    </div>
  );
}
