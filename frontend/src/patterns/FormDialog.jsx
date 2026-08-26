import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogClose } from '../ui/Dialog';
import Button from '../ui/Button';
import ErrorState from '../ui/ErrorState';

/* ═══════════════════════════════════════════════════════════════════════════
   FormDialog — Dialog + <form> + API error banner + Cancel/Submit footer.

   Every create/edit modal in the app repeated this scaffolding, along with its
   own `apiError` state and its own submit-in-flight flag. Centralising it also
   centralises two behaviours that were inconsistent:

   · the submit button reserves its label width while loading, so the footer
     does not jump (§3.1);
   · the dialog cannot be dismissed mid-submit, so a half-finished write can't
     be orphaned by an Escape keypress.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'default',
  submitLabel,
  cancelLabel = 'Cancel',
  onSubmit,
  submitBlockedReason = null,
  children,
}) {
  const [apiError, setApiError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setApiError(null);
    setSaving(true);
    try {
      await onSubmit();
      onOpenChange(false);
    } catch (err) {
      // Server-side validation and conflict errors stay inside the dialog,
      // beside the fields that caused them — a toast behind a modal is
      // unreachable and often unread.
      setApiError(err.message || 'The change could not be saved. Check the fields above and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        if (!next) setApiError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent size={size}>
        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-col">
          <DialogHeader title={title} description={description} />
          <DialogBody>
            <div className="flex flex-col gap-s4">
              {apiError && <ErrorState message={apiError} />}
              {children}
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={saving}>{cancelLabel}</Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              blockedReason={submitBlockedReason}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
