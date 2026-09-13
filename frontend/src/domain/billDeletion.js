// ═══════════════════════════════════════════════════════════════════════════
// Bill deletion — the owner-only, permanent removal of bills (schema-38).
//
// Stock is never returned: the ledger rows a bill wrote stay exactly as they
// were. These helpers only decide what the confirmation dialogs say and when
// their submit button may be pressed. The server re-checks every one of these
// rules, under a row lock, so nothing here is a security control.
// ═══════════════════════════════════════════════════════════════════════════

/** Mirrors RANGE_TOO_LARGE in delete_bills_core. */
export const MAX_BILLS_PER_DELETE = 1000;

/** Mirrors REASON_REQUIRED in delete_bills_core. */
export const MIN_REASON_LENGTH = 5;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Why this deletion cannot go ahead, as a sentence the owner can act on — or
 * null when nothing in the preview stands in the way.
 */
export function deletionBlockedReason(preview) {
  if (!preview) return 'Checking what this would delete…';
  if (!preview.bill_count) return 'There are no bills to delete.';
  if (preview.bill_count > MAX_BILLS_PER_DELETE) {
    return `That is ${preview.bill_count} bills. Delete at most ${MAX_BILLS_PER_DELETE} at once — choose a shorter date range.`;
  }

  const blocked = preview.blocked || [];
  if (!blocked.length) return null;

  const list = blocked
    .map((b) => `${b.bill_number} (return ${b.return_number}, ${b.return_status === 'pending' ? 'awaiting approval' : b.return_status})`)
    .join(', ');
  // An approved return already refunded money and put stock back, so the bill
  // it belongs to has to stay. A pending one can be rejected first.
  const anyPending = blocked.some((b) => b.return_status === 'pending');
  return `Can't delete bills with a customer return: ${list}.${anyPending ? ' Reject a pending return first.' : ''}`;
}

export function reasonBlockedReason(reason) {
  return String(reason ?? '').trim().length >= MIN_REASON_LENGTH
    ? null
    : `Give a reason of at least ${MIN_REASON_LENGTH} characters.`;
}

/** The range dialog asks the owner to type the bill count back. */
export function rangeConfirmationMatches(typed, billCount) {
  return String(typed ?? '').trim() === String(billCount);
}

/** "3 packs and 10 loose units" — what stays deducted from stock. */
export function unitsLeftDeducted(sealedUnits, looseUnits) {
  const sealed = Number(sealedUnits) || 0;
  const loose = Number(looseUnits) || 0;
  const parts = [];
  if (sealed) parts.push(plural(sealed, 'pack', 'packs'));
  if (loose) parts.push(plural(loose, 'loose unit', 'loose units'));
  return parts.length ? parts.join(' and ') : 'no units';
}
