import { useAuth } from '../../hooks/useAuth';
import Button from '../../ui/Button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../ui/Dialog';
import { AlertIcon } from '../../ui/icons';

/* ═══════════════════════════════════════════════════════════════════════════
   Shown when somebody else signs in on this browser.

   Deliberately NOT dismissable — no close button, Escape and outside-click are
   both blocked. There is no safe "continue": the credentials this tab would
   send now belong to another person, and the record this app keeps of who
   dispensed what is the thing being protected.

   It is a freeze, not an immediate sign-out, so a half-finished bill is still
   on screen behind it. Nothing can be sent regardless — the hard stop is the
   latch in lib/api.js, which refuses every request; this is what explains it.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function SessionTakeoverOverlay() {
  const { takeover, leaveTakenOverSession } = useAuth();
  if (!takeover) return null;

  const who = takeover.byName ? `${takeover.byName} signed in` : 'Someone else signed in';

  return (
    <Dialog open>
      <DialogContent
        size="narrow"
        // A blocking dialog: every route out of it has to go through the button.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="flex flex-col items-start gap-s3 p-s4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-warning-wash text-warning-ink">
            <AlertIcon className="h-5 w-5" />
          </span>

          <DialogTitle className="text-sm font-bold text-foreground">
            {who} on another tab
          </DialogTitle>

          <DialogDescription className="text-base text-muted-foreground">
            This tab has been locked so nothing is recorded under the wrong name.
            Anything unfinished on this screen was not sent.
          </DialogDescription>

          <Button variant="primary" size="block" onClick={leaveTakenOverSession}>
            Sign in again
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
