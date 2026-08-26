import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { date as formatDate, dateTime, plural } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import PageHeader from '../../patterns/PageHeader';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import FormDialog from '../../patterns/FormDialog';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input, { Textarea } from '../../ui/Input';
import Select from '../../ui/Select';
import Link from '../../ui/Link';
import Badge from '../../ui/Badge';
import Spinner from '../../ui/Spinner';
import ErrorState from '../../ui/ErrorState';
import { SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { AlertIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { SupplierInvoiceStatusBadge, ValidationBadge } from '../../domain/StatusBadge';
import { blockingIssues, canImport, partitionWarnings, sumLineValues, warningLabel } from '../../domain/invoice';
import DocumentPreview from './DocumentPreview';
import InvoiceLineCard from './InvoiceLineCard';
import MedicineMatchDialog from './MedicineMatchDialog';
import QuickAddMedicineDialog from './QuickAddMedicineDialog';
import QuickAddSupplierDialog from './QuickAddSupplierDialog';
import useInvoiceReview from './useInvoiceReview';

/* ═══════════════════════════════════════════════════════════════════════════
   InvoiceReviewPage — the human half of the feature.

   The layout is the argument: document on the left, its transcription on the
   right, both on screen at once. Everything else here is in service of one
   question the reviewer is answering line by line — "does this say what the
   paper says?" So the printed line stays visible next to the mapped catalogue
   name, the computed line value sits next to the printed one, and every
   warning names the field it belongs to.

   Below `lg` the two halves stack, document first. A phone cannot show both at
   a legible size, and pretending otherwise gives a 40%-width scan of a smudged
   expiry date — which is worse than scrolling.

   Approve is owner-only and it is the only control here that writes stock.
   Everything else edits a draft, which is why staff can do all of it.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function InvoiceReviewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isOwner } = useAuth();
  const review = useInvoiceReview(id);
  const { invoice, editItem, editHeader, saveItem, saveHeader } = review;

  const [suppliers, setSuppliers] = useState([]);
  const [matchLine, setMatchLine] = useState(null);
  const [quickAddLine, setQuickAddLine] = useState(null);
  const [quickAddSupplierOpen, setQuickAddSupplierOpen] = useState(false);
  const [showIssueDetails, setShowIssueDetails] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const approve = useConfirm();

  useEffect(() => {
    api.get('/suppliers').then((res) => setSuppliers(res.data.suppliers || [])).catch(() => setSuppliers([]));
  }, []);

  const readOnly = !invoice || invoice.status !== 'NEEDS_REVIEW';
  const ready = invoice ? (invoice.can_import ?? canImport(invoice)) : false;
  const issues = useMemo(() => blockingIssues(invoice), [invoice]);
  const activeLines = useMemo(() => (invoice?.items || []).filter((l) => !l.is_excluded), [invoice]);
  const linesTotal = useMemo(() => sumLineValues(invoice?.items || []), [invoice]);
  const docWarnings = invoice?.validation_warnings || [];
  const { advisories } = partitionWarnings(docWarnings);
  const docError = (field) => docWarnings.find((w) => w.field === field && w.severity === 'error')?.message;

  // Group issues for compact summary
  const issueSummary = useMemo(() => {
    const counts = {};
    for (const issue of issues) {
      const label = warningLabel(issue.code);
      counts[label] = (counts[label] || 0) + 1;
    }
    return Object.entries(counts).map(([label, count]) => ({ label, count }));
  }, [issues]);

  const persistHeader = (changes) => { saveHeader(changes).catch(() => {}); };
  const persistItem = (lineId, changes) => { saveItem(lineId, changes).catch(() => {}); };

  const headerCommit = (key, transform) => () => {
    const raw = invoice?.[key];
    const next = transform ? transform(raw) : raw;
    if (next !== raw) editHeader({ [key]: next });
    persistHeader({ [key]: next === '' ? null : next });
  };

  const handlePickMedicine = async (medicine) => {
    const line = matchLine;
    editItem(line.id, { medicine_id: medicine.id, medicines: medicine });
    try {
      await saveItem(line.id, { medicine_id: medicine.id });
      toast.success(`Line ${line.line_no} linked to ${medicine.name}.`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleToggleExclude = async (line) => {
    const next = !line.is_excluded;
    editItem(line.id, { is_excluded: next });
    try {
      await saveItem(line.id, { is_excluded: next });
    } catch (err) {
      editItem(line.id, { is_excluded: !next });
      toast.error(err.message);
    }
  };

  const handleApprove = async () => {
    const res = await api.post(`/supplier-invoices/${id}/approve`);
    review.replace(res.data.invoice);
    toast.success(
      `Imported as ${res.data.invoice.purchase_number}. ${plural(activeLines.length, 'batch', 'batches')} added to stock.`
    );
  };

  const handleReject = async () => {
    const res = await api.post(`/supplier-invoices/${id}/reject`, { reason: rejectReason.trim() || null });
    review.replace(res.data.invoice);
    toast.success('Invoice rejected. The document and everything read from it stay on record.');
  };

  const scrollToLine = (lineNo) => {
    const el = document.getElementById(`line-${lineNo}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-focus');
      setTimeout(() => el.classList.remove('ring-2', 'ring-focus'), 2000);
    }
  };

  if (review.loading) {
    return (
      <div>
        <PageHeader title="Invoice review" subtitle="Loading the document and its lines…" />
        <SkeletonRows count={4} />
      </div>
    );
  }

  if (review.error) {
    return (
      <div>
        <PageHeader title="Invoice review" />
        <ErrorState
          title="Couldn't load this invoice"
          message={review.error.message}
          onRetry={() => review.reload().catch(() => {})}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={invoice.invoice_no ? `Invoice ${invoice.invoice_no}` : 'Unnumbered invoice'}
        subtitle={
          invoice.supplier_name
            ? `${invoice.supplier_name} · uploaded ${dateTime(invoice.created_at)} by ${invoice.uploaded_by_name || 'a colleague'}`
            : `Uploaded ${dateTime(invoice.created_at)} · distributor not yet matched`
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/supplier-invoices')}>
              Back to invoices
            </Button>
            {!readOnly && (
              <>
                <Button variant="secondary" onClick={() => setRejectOpen(true)}>
                  Reject
                </Button>
                <Button
                  variant="primary"
                  onClick={() => approve.ask(true)}
                  blockedReason={
                    !isOwner
                      ? 'Only the owner can import an invoice into stock. Finish correcting it and they will approve it.'
                      : !ready
                      ? `${plural(issues.length, 'problem')} would make the stock wrong. Fix the lines marked in red first.`
                      : review.saving
                      ? 'Waiting for the last change to save.'
                      : null
                  }
                >
                  Approve &amp; commit
                </Button>
              </>
            )}
          </>
        }
      />

      {/* ── Status strip ─────────────────────────────────────────────────── */}
      <div className="mb-s3 flex flex-wrap items-center gap-s3 rounded-card border border-border bg-card px-s3 py-s2">
        <SupplierInvoiceStatusBadge status={invoice.status} />
        <span className="text-base text-muted-foreground">
          {plural(invoice.items.length, 'line')} read
          {invoice.items.length !== activeLines.length && ` · ${invoice.items.length - activeLines.length} excluded`}
        </span>
        {invoice.extraction_model && (
          <span className="text-base text-muted-foreground">
            Read by {invoice.extraction_model}
            {invoice.extraction_ms ? ` in ${(invoice.extraction_ms / 1000).toFixed(1)}s` : ''}
          </span>
        )}
        {advisories.length > 0 && (
          <div className="flex flex-wrap items-center gap-s1">
            {advisories.map((w, i) => <ValidationBadge key={`${w.code}-${i}`} warning={w} />)}
          </div>
        )}
        {review.saving && (
          <span className="ml-auto flex items-center gap-s2 text-base text-muted-foreground">
            <Spinner /> Saving…
          </span>
        )}
      </div>

      {invoice.status === 'IMPORTED' && (
        <div className="mb-s3 flex flex-wrap items-center gap-s2 rounded-card border border-success/30 bg-success-wash px-s3 py-s2 text-base text-foreground">
          <span className="font-bold">Imported into stock.</span>
          <span>
            Approved by {invoice.approved_by_name || 'the owner'} on {formatDate(invoice.approved_at)}
            {invoice.purchase_number && ' · '}
          </span>
          {invoice.purchase_number && (
            <Link to="/purchases">{invoice.purchase_number}</Link>
          )}
          <span>Corrections now go through a Supplier Return, not through this screen.</span>
        </div>
      )}

      {invoice.status === 'REJECTED' && (
        <div className="mb-s3 rounded-card border border-border bg-muted px-s3 py-s2 text-base text-muted-foreground">
          <span className="font-bold text-foreground">Rejected.</span>{' '}
          {invoice.rejected_reason || 'No reason was recorded.'} The document and everything read from it are kept.
        </div>
      )}

      {review.saveError && (
        <ErrorState
          className="mb-s3"
          title="That change didn't save"
          message={`${review.saveError.message} Your edit is still on screen — try the field again.`}
          onRetry={() => review.reload().then(review.clearSaveError).catch(() => {})}
        />
      )}

      {/* ── Modern Aesthetic Issue Banner ────────────────────────────────── */}
      {!readOnly && issues.length > 0 && (
        <div
          role="alert"
          className="mb-s4 overflow-hidden rounded-card border border-border bg-card shadow-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-s3 p-s3">
            <div className="flex flex-wrap items-center gap-s2">
              <div className="flex items-center gap-s2">
                <AlertIcon className="h-4 w-4 shrink-0 text-destructive" />
                <span className="text-sm font-bold text-foreground">
                  {plural(issues.length, 'problem')} to resolve before import:
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-s1">
                {issueSummary.map(({ label, count }) => (
                  <Badge key={label} tone="critical">
                    {count > 1 ? `${count} × ` : ''}{label}
                  </Badge>
                ))}
              </div>
            </div>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => setShowIssueDetails((prev) => !prev)}
            >
              {showIssueDetails ? 'Hide details' : 'Show details'}
            </Button>
          </div>

          {showIssueDetails && (
            <div className="border-t border-border bg-muted/30 p-s3">
              <ul className="flex flex-col divide-y divide-border">
                {issues.map((issue, i) => (
                  <li
                    key={`${issue.code}-${issue.line_no ?? 'doc'}-${i}`}
                    className="flex flex-wrap items-center justify-between gap-s2 py-s2 first:pt-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-baseline gap-s2 text-base">
                      <Badge tone={issue.line_no ? 'neutral' : 'critical'}>
                        {issue.line_no ? `Line ${issue.line_no}` : 'Invoice'}
                      </Badge>
                      <span className="font-bold text-foreground">{warningLabel(issue.code)}:</span>
                      <span className="text-muted-foreground">{issue.message}</span>
                    </div>
                    {issue.line_no && (
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={() => scrollToLine(issue.line_no)}
                      >
                        Jump to line {issue.line_no}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── The split ────────────────────────────────────────────────────── */}
      <div className="grid items-start gap-s4 lg:grid-cols-2 lg:gap-s5">
        {/* min-w-0 on both columns: a grid child's default min-width is its
            content's intrinsic size, so the document photo would otherwise
            force this column past the viewport on phones. */}
        <div className="min-w-0 lg:sticky lg:top-s3 lg:self-start">
          <DocumentPreview invoiceId={invoice.id} fileName={invoice.file_name} />
        </div>

        <div className="flex min-w-0 flex-col gap-s4">
          {/* ── Header fields ──────────────────────────────────────────── */}
          <section aria-label="Invoice details" className="flex flex-col gap-s3 rounded-card border border-border bg-card p-s3">
            <h2 className="text-sm font-bold text-foreground">Invoice details</h2>

            <Field
              label="Distributor"
              required
              error={docError('supplier_id')}
              hint={invoice.supplier_name_raw ? `printed as “${invoice.supplier_name_raw}”` : undefined}
            >
              {/* Stacks below the select on phones — a side-by-side button
                  squeezes the select past legibility and overflows the card. */}
              <div className="flex flex-col gap-s2 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <Select
                    value={invoice.supplier_id ?? ''}
                    disabled={readOnly}
                    placeholder="Select the distributor…"
                    onChange={(e) => {
                      const value = e.target.value || null;
                      editHeader({ supplier_id: value });
                      persistHeader({ supplier_id: value });
                    }}
                  >
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </div>
                {!readOnly && (
                  <Button
                    variant="secondary"
                    type="button"
                    className="shrink-0"
                    onClick={() => setQuickAddSupplierOpen(true)}
                  >
                    + Add supplier
                  </Button>
                )}
              </div>
            </Field>

            <div className="grid gap-s3 sm:grid-cols-2">
              <Field label="GST number" hint={invoice.supplier_gstin ? 'extracted from the invoice' : undefined}>
                <Input
                  value={invoice.supplier_gstin ?? ''}
                  readOnly
                  disabled={!invoice.supplier_gstin}
                  placeholder="Not printed on the invoice"
                  className="font-mono uppercase"
                />
              </Field>
              <Field label="Drug license no." hint={invoice.supplier_dl_no ? 'extracted from the invoice' : undefined}>
                <Input
                  value={invoice.supplier_dl_no ?? ''}
                  readOnly
                  disabled={!invoice.supplier_dl_no}
                  placeholder="Not printed on the invoice"
                  className="font-mono uppercase"
                />
              </Field>
            </div>

            <div className="grid gap-s3 sm:grid-cols-2">
              <Field
                label="Invoice number"
                required
                error={docError('invoice_no')}
              >
                <Input
                  value={invoice.invoice_no ?? ''}
                  disabled={readOnly}
                  onChange={(e) => editHeader({ invoice_no: e.target.value })}
                  onBlur={headerCommit('invoice_no', (v) => String(v ?? '').trim())}
                  className="font-mono"
                  autoComplete="off"
                />
              </Field>

              <Field label="Invoice date" required>
                <Input
                  type="date"
                  value={invoice.invoice_date ?? ''}
                  disabled={readOnly}
                  onChange={(e) => editHeader({ invoice_date: e.target.value })}
                  onBlur={headerCommit('invoice_date')}
                />
              </Field>
            </div>

            <div className="grid gap-s3 sm:grid-cols-2">
              <Field
                label="Net total (₹)"
                hint={invoice.net_total != null ? 'extracted / entered' : 'defaults to lines sum'}
                error={docError('net_total')}
              >
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={invoice.net_total ?? ''}
                  disabled={readOnly}
                  placeholder={linesTotal ? linesTotal.toFixed(2) : '0.00'}
                  onChange={(e) => editHeader({ net_total: e.target.value })}
                  onBlur={headerCommit('net_total', (v) => (v === '' || v === null ? null : parseFloat(v)))}
                  className="font-mono"
                />
              </Field>

              <Field
                label="Taxable total (₹)"
                hint={invoice.taxable_total != null ? 'extracted / entered' : 'before GST'}
                error={docError('taxable_total')}
              >
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={invoice.taxable_total ?? ''}
                  disabled={readOnly}
                  placeholder={linesTotal ? linesTotal.toFixed(2) : '0.00'}
                  onChange={(e) => editHeader({ taxable_total: e.target.value })}
                  onBlur={headerCommit('taxable_total', (v) => (v === '' || v === null ? null : parseFloat(v)))}
                  className="font-mono"
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-s2 border-t border-border pt-s2">
              <span className="text-base text-muted-foreground">
                The {plural(activeLines.length, 'line')} above add up to
              </span>
              <Money
                value={linesTotal}
                tone={
                  invoice.taxable_total != null && Math.abs(linesTotal - Number(invoice.taxable_total)) > Math.max(1, Number(invoice.taxable_total) * 0.02)
                    ? 'critical'
                    : undefined
                }
              />
            </div>
          </section>

          {/* ── Lines ──────────────────────────────────────────────────── */}
          <section aria-label="Invoice lines" className="flex flex-col gap-s3">
            <div className="flex flex-wrap items-baseline justify-between gap-s2">
              <h2 className="text-sm font-bold text-foreground">Lines</h2>
              {invoice.unmapped_count > 0 && (
                <Badge tone="critical">{plural(invoice.unmapped_count, 'line')} not in the catalogue</Badge>
              )}
            </div>

            {invoice.items.length === 0 ? (
              <ErrorState
                title="No lines were read from this document"
                message="Nothing can be imported from it. If it is a photo, retake it square-on with the whole product table in frame, then upload it again."
              />
            ) : (
              invoice.items.map((line) => (
                <InvoiceLineCard
                  key={line.id}
                  line={line}
                  readOnly={readOnly}
                  isOwner={isOwner}
                  onEdit={editItem}
                  onSave={persistItem}
                  onOpenMatch={setMatchLine}
                  onOpenQuickAdd={(l) => setQuickAddLine(l)}
                  onToggleExclude={handleToggleExclude}
                />
              ))
            )}
          </section>
        </div>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
      <MedicineMatchDialog
        open={Boolean(matchLine)}
        onOpenChange={(next) => { if (!next) setMatchLine(null); }}
        line={matchLine}
        canQuickAdd={isOwner}
        onPick={handlePickMedicine}
        onQuickAdd={() => { setQuickAddLine(matchLine); setMatchLine(null); }}
      />

      <QuickAddMedicineDialog
        open={Boolean(quickAddLine)}
        onOpenChange={(next) => { if (!next) setQuickAddLine(null); }}
        invoiceId={id}
        line={quickAddLine}
        onCreated={(fresh, medicine) => {
          review.replace(fresh);
          setQuickAddLine(null);
          toast.success(`${medicine.name} added to the catalogue and linked.`);
        }}
      />

      <QuickAddSupplierDialog
        open={quickAddSupplierOpen}
        onOpenChange={setQuickAddSupplierOpen}
        defaultName={invoice.supplier_name_raw || ''}
        defaultGstNo={invoice.supplier_gstin || ''}
        defaultDrugLicenseNo={invoice.supplier_dl_no || ''}
        defaultPhone={invoice.supplier_phone || ''}
        onCreated={(newSupplier) => {
          setSuppliers((prev) => [...prev, newSupplier]);
          editHeader({ supplier_id: newSupplier.id });
          persistHeader({ supplier_id: newSupplier.id });
          toast.success(`Supplier ${newSupplier.name} added and linked.`);
        }}
      />

      <ConfirmDialog
        {...approve.props}
        title="Import this invoice into stock?"
        body={
          `${plural(activeLines.length, 'batch', 'batches')} will be created with the batch numbers, expiry dates and costs shown, ` +
          `and the stock ledger will be credited. This is recorded as a received purchase order and cannot be edited afterwards — ` +
          `a mistake found later has to go through a Supplier Return.`
        }
        confirmLabel="Import to stock"
        cancelLabel="Keep reviewing"
        onConfirm={handleApprove}
      />

      <FormDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title="Reject this invoice?"
        description="Nothing is deleted. The document, everything read from it and your reason all stay on record, and this invoice number stops blocking a corrected re-upload."
        submitLabel="Reject invoice"
        cancelLabel="Keep reviewing"
        onSubmit={handleReject}
      >
        <Field label="Reason" hint="(optional, but the next person will want it)">
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            placeholder="This is the delivery challan, not the tax invoice."
          />
        </Field>
      </FormDialog>
    </div>
  );
}
