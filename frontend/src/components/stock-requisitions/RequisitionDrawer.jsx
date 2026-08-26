import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { dateTime, plural, shortDate } from '../../lib/format';
import {
  Button, Drawer, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter,
  ErrorState, Field, Spinner, Textarea,
} from '../../ui';
import { DownloadIcon } from '../../ui/icons';
import { Money, Qty } from '../../domain/Money';
import { RequisitionStatusBadge, RequisitionUrgencyBadge } from '../../domain/StatusBadge';
import FormDialog from '../../patterns/FormDialog';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { useAuth } from '../../hooks/useAuth';

/* ═══════════════════════════════════════════════════════════════════════════
   One stock request, in a drawer rather than on its own route.

   BatchDrawer is the precedent: the owner inspects a finished document without
   leaving the queue, which is what lets them work down it. A second route would
   mean a second fetch-by-id page and a second set of loading/empty/error
   branches for a record of at most fifty lines.

   Lines are GROUPED BY VENDOR here using the same rule the export uses, so the
   screen and the downloaded file can never tell different stories about who is
   being ordered from.
   ═══════════════════════════════════════════════════════════════════════════ */

const NO_VENDOR = 'Vendor not specified';

/** Mirrors groupByVendor in stock-requisitions.export.js: named vendors
 *  alphabetically, then the unspecified group last. */
function groupLines(items) {
  const groups = new Map();
  (items || []).forEach((item) => {
    const name = item.supplier_name || null;
    const key = name || ' unspecified';
    if (!groups.has(key)) groups.set(key, { name, lines: [] });
    groups.get(key).lines.push(item);
  });

  const all = [...groups.values()];
  const named = all.filter((g) => g.name).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const rest = all.filter((g) => !g.name);

  return [...named, ...rest].map((g) => ({
    ...g,
    total: g.lines.reduce((s, l) => s + (l.line_total || 0), 0),
    hasPrices: g.lines.some((l) => l.unit_cost !== null),
  }));
}

function LineRow({ line }) {
  return (
    <li className="flex flex-wrap items-baseline gap-s2 py-s2">
      <span className="min-w-[8rem] flex-1 text-base font-bold text-foreground">
        {line.medicine_name}
      </span>
      <Qty value={line.qty} unit={line.unit} />
      <span className="w-[5.5rem] text-right text-base text-muted-foreground">
        {line.unit_cost === null ? '—' : <Money value={line.unit_cost} />}
      </span>
      <span className="w-[6rem] text-right">
        {line.line_total === null ? (
          <span className="text-base text-muted-foreground">—</span>
        ) : (
          <Money value={line.line_total} />
        )}
      </span>
      {line.price_as_of && (
        <span className="w-full text-base text-muted-foreground">
          Rate last paid {shortDate(line.price_as_of)}
          {line.mrp !== null && <> · MRP <Money value={line.mrp} /></>}
        </span>
      )}
    </li>
  );
}

function VendorGroup({ group }) {
  return (
    <section
      className={
        group.name
          ? 'rounded-card border border-border p-s3'
          : 'rounded-card border border-warning/40 bg-warning-wash p-s3'
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-s2">
        <h3 className="text-base font-bold text-foreground">{group.name || NO_VENDOR}</h3>
        {group.hasPrices
          ? <Money value={group.total} className="text-sm" />
          : <span className="text-base text-muted-foreground">No rates on record</span>}
      </div>
      <ul className="divide-y divide-border">
        {group.lines.map((line) => <LineRow key={line.id} line={line} />)}
      </ul>
    </section>
  );
}

export default function RequisitionDrawer({ requisitionId, open, onOpenChange, onChanged }) {
  const [requisition, setRequisition] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const withdraw = useConfirm();
  const toast = useToast();
  const { user, isOwner } = useAuth();

  useEffect(() => {
    if (!open || !requisitionId) { setRequisition(null); setError(''); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/stock-requisitions/${requisitionId}`);
        if (!cancelled) setRequisition(res.data.requisition);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [open, requisitionId]);

  const groups = useMemo(() => groupLines(requisition?.items), [requisition]);
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  const act = async (path, label) => {
    setBusy(label);
    try {
      const res = await api.patch(`/stock-requisitions/${requisitionId}/${path}`);
      setRequisition(res.data.requisition);
      toast.success(res.message);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    const res = await api.patch(`/stock-requisitions/${requisitionId}/reject`, {
      rejection_note: rejectNote,
    });
    setRequisition(res.data.requisition);
    toast.success(res.message);
    onChanged?.();
    setRejectNote('');
  };

  const handleDownload = async (format) => {
    setBusy(format);
    try {
      // The server names the file; the fallback only matters if the API is
      // cross-origin and Content-Disposition is not exposed.
      const name = await api.download(
        `/stock-requisitions/${requisitionId}/export/${format}`,
        `${requisition.requisition_number}.${format}`
      );
      toast.success(`${name} downloaded.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const isPending = requisition?.status === 'pending';
  const canReview = isPending && isOwner;
  const canDownload = requisition?.status === 'approved' && isOwner;
  // Withdrawing is the RAISER's act, not the owner's. An owner who wants this
  // gone rejects it, with a reason the raiser can act on — which is why the
  // service refuses a cancel from anyone but the creator, and why the button is
  // absent here rather than present and refused.
  const canWithdraw = isPending && requisition?.created_by === user?.id;

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader
            title={requisition?.requisition_number || 'Stock request'}
            description={requisition
              ? `Raised by ${requisition.created_by_name || '—'} · ${dateTime(requisition.created_at)}`
              : undefined}
          />

          <DrawerBody>
            {error && <ErrorState message={error} />}

            {!requisition && !error && (
              <div className="flex items-center gap-s2 text-base text-muted-foreground">
                <Spinner className="h-4 w-4" /> Loading…
              </div>
            )}

            {requisition && (
              <div className="flex flex-col gap-s4">
                <div className="flex flex-wrap items-center gap-s2">
                  <RequisitionStatusBadge status={requisition.status} variant="solid" />
                  <RequisitionUrgencyBadge urgency={requisition.urgency} variant="solid" />
                  <span className="text-base text-muted-foreground">
                    {plural(requisition.item_count, 'line')}
                  </span>
                </div>

                {requisition.note && (
                  <p className="rounded-card bg-muted p-s3 text-base text-foreground">
                    {requisition.note}
                  </p>
                )}

                {requisition.status === 'rejected' && requisition.rejection_note && (
                  <p className="rounded-card border border-destructive/40 bg-destructive-wash p-s3 text-base text-destructive-ink">
                    <span className="font-bold">Rejected: </span>{requisition.rejection_note}
                  </p>
                )}

                {requisition.reviewed_at && (
                  <p className="text-base text-muted-foreground">
                    {requisition.status === 'approved' ? 'Approved' : 'Rejected'} by{' '}
                    {requisition.reviewed_by_name || '—'} · {dateTime(requisition.reviewed_at)}
                  </p>
                )}

                {groups.map((group) => (
                  <VendorGroup key={group.name || '__none'} group={group} />
                ))}

                <div className="flex items-baseline justify-between gap-s3 border-t border-border pt-s3">
                  <span className="text-sm font-bold text-foreground">
                    Estimated cost
                    <span className="ml-s2 font-normal text-muted-foreground">
                      at the rates we last paid
                    </span>
                  </span>
                  <Money value={grandTotal} className="text-md" />
                </div>

                {requisition.unpriced_item_count > 0 && (
                  <p className="text-base text-muted-foreground">
                    {plural(requisition.unpriced_item_count, 'line')} with no rate on record
                    {requisition.unpriced_item_count === 1 ? ' is' : ' are'} not in that figure.
                  </p>
                )}
              </div>
            )}
          </DrawerBody>

          {requisition && (
            <DrawerFooter>
              {canDownload && (
                <>
                  <Button
                    variant="primary"
                    loading={busy === 'xlsx'}
                    onClick={() => handleDownload('xlsx')}
                  >
                    <DownloadIcon className="h-4 w-4" />
                    Excel
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy === 'pdf'}
                    onClick={() => handleDownload('pdf')}
                  >
                    <DownloadIcon className="h-4 w-4" />
                    PDF
                  </Button>
                </>
              )}

              {canReview && (
                <>
                  <Button
                    variant="primary"
                    loading={busy === 'approve'}
                    onClick={() => act('approve', 'approve')}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setRejecting(true)}
                  >
                    Reject
                  </Button>
                </>
              )}

              {canWithdraw && (
                <Button variant="ghost" onClick={() => withdraw.ask(requisition)}>
                  Withdraw
                </Button>
              )}
            </DrawerFooter>
          )}
        </DrawerContent>
      </Drawer>

      <FormDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={`Reject ${requisition?.requisition_number || 'this request'}?`}
        description="The person who raised it is notified with your reason, so they can correct it and send it again."
        submitLabel="Reject request"
        submitBlockedReason={rejectNote.trim().length < 5
          ? 'Give a reason of at least five characters.' : null}
        onSubmit={handleReject}
      >
        <Field label="Why not?" required>
          <Textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="We already have three months of this on order."
          />
        </Field>
      </FormDialog>

      <ConfirmDialog
        {...withdraw.props}
        title={`Withdraw ${withdraw.target?.requisition_number}?`}
        body="The owner stops seeing it in their queue. It stays on record."
        confirmLabel="Withdraw request"
        cancelLabel="Keep it"
        onConfirm={() => act('cancel', 'cancel')}
      />
    </>
  );
}

export { groupLines };
