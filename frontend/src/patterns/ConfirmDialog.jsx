import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogClose } from '../ui/Dialog';
import Button from '../ui/Button';

/* ═══════════════════════════════════════════════════════════════════════════
   ConfirmDialog — replaces nine native confirm() calls across eight files.

   window.confirm cannot be styled, blocks the main thread, and on some mobile
   browsers is suppressed entirely — which silently turned "Deactivate this
   medicine?" into an unconditional deactivate.

   §5 governs the copy: name the record and the consequence. "Deactivate
   Metformin 500mg? It will be hidden from billing and purchase order pickers."
   — not "Are you sure?".
   ═══════════════════════════════════════════════════════════════════════════ */

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
}) {
  const [working, setWorking] = useState(false);

  const handleConfirm = async () => {
    setWorking(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={working ? undefined : onOpenChange}>
      <DialogContent size="narrow">
        <DialogHeader title={title} />
        <DialogBody>
          <p className="text-base text-muted-foreground">{body}</p>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={working}>{cancelLabel}</Button>
          </DialogClose>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            loading={working}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Wiring a confirm per row is repetitive, so this keeps the pending record and
 * the dialog state together.
 *
 *   const confirm = useConfirm();
 *   ...
 *   <Button onClick={() => confirm.ask(medicine)}>Deactivate</Button>
 *   <ConfirmDialog {...confirm.props} title={...} onConfirm={...} />
 */
export function useConfirm() {
  const [target, setTarget] = useState(null);

  return {
    target,
    ask: (record) => setTarget(record ?? true),
    close: () => setTarget(null),
    props: {
      open: target !== null,
      onOpenChange: (next) => { if (!next) setTarget(null); },
    },
  };
}
