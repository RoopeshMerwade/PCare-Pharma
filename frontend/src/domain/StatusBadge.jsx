import Badge from '../ui/Badge';
import { stockStatus, expiryStatus } from './stock';
import { warningLabel, warningTone } from './invoice';

/* ═══════════════════════════════════════════════════════════════════════════
   Status badges — registry-driven, so a status can never render as a bare
   colour (A4, §6) and two screens can never disagree about what a status is
   called.

   Every entry pairs a tone with a WORD. §5's rule that action labels stay
   consistent through a flow applies to statuses too: a purchase order that is
   "Sent" on the list must not be "Dispatched" on the detail.

   Each wrapper forwards `variant` to ui/Badge so a caller can choose the
   solid treatment. It is forwarded, never decided here: whether a pill should
   shout depends on what surrounds it — a status column wants solid, the same
   badge on a dense batch card wants the default wash — and this layer is
   route-agnostic, so it cannot know which surface it landed on. §5 still
   applies to the choice: a status rendered solid on the list must be solid on
   the detail too, or the two screens look like different states.
   ═══════════════════════════════════════════════════════════════════════════ */

const PO_STATUS = {
  draft:             { tone: 'neutral',    label: 'Draft' },
  sent:              { tone: 'processing', label: 'Sent' },
  partially_received:{ tone: 'processing', label: 'Partly received' },
  received:          { tone: 'ok',         label: 'Received' },
  cancelled:         { tone: 'critical',   label: 'Cancelled' },
};

const PAYMENT_STATUS = {
  cash:   { tone: 'ok',       label: 'Cash' },
  upi:    { tone: 'ok',       label: 'UPI' },
  card:   { tone: 'ok',       label: 'Card' },
  credit: { tone: 'warning',  label: 'Credit' },
  paid:   { tone: 'ok',       label: 'Paid' },
  unpaid: { tone: 'critical', label: 'Unpaid' },
  partial:{ tone: 'warning',  label: 'Part paid' },
};

const RETURN_STATUS = {
  pending:  { tone: 'warning',  label: 'Awaiting approval' },
  approved: { tone: 'ok',       label: 'Approved' },
  rejected: { tone: 'critical', label: 'Rejected' },
  completed:{ tone: 'ok',       label: 'Completed' },
};

const ACTIVE_STATUS = {
  true:  { tone: 'ok',      label: 'Active' },
  false: { tone: 'neutral', label: 'Inactive' },
};

/* Module 21 adherence. Advisory only — none of these ever blocks a sale, which
   is a deliberate product decision, so none of them uses the language of a
   block ("Denied", "Not allowed"). They describe the patient's refill timing. */
const ADHERENCE_STATUS = {
  overdue:         { tone: 'critical',   label: 'Overdue for a refill' },
  early_refill:    { tone: 'processing', label: 'Refilling early' },
  due_soon:        { tone: 'warning',    label: 'Due soon' },
  on_track:        { tone: 'ok',         label: 'On track' },
  no_purchase_yet: { tone: 'neutral',    label: 'Not collected yet' },
};

/* Module 26 attendance. `absent` is `neutral`, not `critical`: at 09:00 nobody
   has arrived yet, and painting the whole board red every morning would train
   staff to ignore the colour by the time it means something. It is a statement
   of fact — no row today — not a fault. */
const ATTENDANCE_STATUS = {
  present:     { tone: 'ok',      label: 'Present' },
  checked_out: { tone: 'info',    label: 'Checked out' },
  absent:      { tone: 'neutral', label: 'Not in yet' },
};

/* Module 30 stock requisitions. `approved` is `ok`, not `processing`:
   approving is the END of this workflow, not a step through it. Nothing
   further happens to the record — the owner downloads it and rings the
   distributor — so a label like "Ordered" would name a purchase order this
   module deliberately does not create, on a screen where nothing could ever
   contradict it.

   `cancelled` reads "Withdrawn", not "Cancelled": the staff member took it
   back, which is a different event from the owner saying no, and the two must
   not look alike on a list a staff member reads. */
const REQUISITION_STATUS = {
  pending:   { tone: 'warning',  label: 'Awaiting owner' },
  approved:  { tone: 'ok',       label: 'Approved' },
  rejected:  { tone: 'critical', label: 'Rejected' },
  cancelled: { tone: 'neutral',  label: 'Withdrawn' },
};

/** Falls back to the raw value rather than hiding an unmapped status. */
function lookup(registry, value, fallbackLabel) {
  const entry = registry[String(value)];
  if (entry) return entry;
  return { tone: 'neutral', label: fallbackLabel || String(value ?? 'Unknown') };
}

export function StockBadge({ medicine, variant }) {
  const status = stockStatus(medicine);
  return <Badge tone={status.tone} variant={variant}>{status.label}</Badge>;
}

export function ExpiryBadge({ daysToExpiry, variant }) {
  const status = expiryStatus(daysToExpiry);
  return <Badge tone={status.tone} variant={variant}>{status.label}</Badge>;
}

export function PurchaseStatusBadge({ status, variant }) {
  const entry = lookup(PO_STATUS, status);
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

export function PaymentBadge({ mode, variant }) {
  const entry = lookup(PAYMENT_STATUS, mode);
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

export function ReturnStatusBadge({ status, variant }) {
  const entry = lookup(RETURN_STATUS, status);
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

export function ActiveBadge({ isActive, variant }) {
  const entry = lookup(ACTIVE_STATUS, Boolean(isActive));
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

export function AttendanceBadge({ status, variant }) {
  const entry = lookup(ATTENDANCE_STATUS, status, 'Unknown');
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

export function AdherenceBadge({ status, variant }) {
  const entry = lookup(ADHERENCE_STATUS, status, 'Tracking');
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

export function RequisitionStatusBadge({ status, variant }) {
  const entry = lookup(REQUISITION_STATUS, status, 'Unknown');
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

/** Renders NOTHING for 'normal'. Urgency is an exception on a list where most
 *  rows are not urgent — a badge on every row reading "Normal" is a column of
 *  noise, and it would dilute the one that means hurry. */
export function RequisitionUrgencyBadge({ urgency, variant }) {
  if (urgency !== 'urgent') return null;
  return <Badge tone="critical" variant={variant}>Urgent</Badge>;
}

/** §2.2 status.rxRequired — the outline variant, so it reads as a flag on the
 *  row rather than competing with the stock badge beside it. */
export function RxBadge() {
  return <Badge tone="flag">Prescription required</Badge>;
}

/* Module 23 supplier invoices. "Needs review" is `processing`, not `warning`:
   a freshly read invoice is work in progress, not a problem. The problems are
   the validation badges on its lines, and letting the status compete with them
   would drown the ones that need acting on. */
const SUPPLIER_INVOICE_STATUS = {
  NEEDS_REVIEW: { tone: 'processing', label: 'Needs review' },
  IMPORTED:     { tone: 'ok',         label: 'Imported' },
  REJECTED:     { tone: 'critical',   label: 'Rejected' },
};

export function SupplierInvoiceStatusBadge({ status, variant }) {
  const entry = lookup(SUPPLIER_INVOICE_STATUS, status);
  return <Badge tone={entry.tone} variant={variant}>{entry.label}</Badge>;
}

/**
 * One extracted-data warning. A4: never a bare colour — the code's human label
 * IS the badge's content, and the full sentence is the accessible name so a
 * screen reader gets the explanation rather than the two-word summary.
 */
export function ValidationBadge({ warning }) {
  if (!warning) return null;
  return (
    <Badge tone={warningTone(warning.severity)} title={warning.message} aria-label={warning.message}>
      {warningLabel(warning.code)}
    </Badge>
  );
}
