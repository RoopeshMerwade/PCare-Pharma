// ═══════════════════════════════════════════════════════════════════════════
// Stock status — one definition, replacing six.
//
// The old code decided "is this low?" in six places (InventoryPage twice,
// BatchDrawer, ReportsPage, MedicineCard, useMedicineSearch) and they had
// drifted: some tested `is_low_stock`, some compared against
// `low_stock_threshold`, some only checked for zero. That is a correctness
// problem rather than a styling one — two screens could disagree about
// whether the same medicine needed reordering.
//
// The backend computes `is_low_stock` against the medicine's own threshold and
// is the authority. The local comparison is a fallback for payloads that do
// not carry the flag (batch rows, search results).
// ═══════════════════════════════════════════════════════════════════════════

export const STOCK_STATUS = {
  out: { key: 'out', tone: 'critical', label: 'Out of stock' },
  low: { key: 'low', tone: 'low',      label: 'Low stock' },
  ok:  { key: 'ok',  tone: 'ok',       label: 'In stock' },
};

export function stockStatus(item) {
  const stock = Number(item?.total_stock ?? 0);
  if (!Number.isFinite(stock) || stock <= 0) return STOCK_STATUS.out;

  const threshold = Number(item?.low_stock_threshold ?? 0);
  const isLow = item?.is_low_stock ?? (threshold > 0 && stock <= threshold);

  return isLow ? STOCK_STATUS.low : STOCK_STATUS.ok;
}

// ── Expiry ────────────────────────────────────────────────────────────────
// Thresholds match the expiry dashboard's own buckets so a batch cannot be
// "expiring soon" on one screen and healthy on another.

export const EXPIRY_SOON_DAYS = 90;
export const EXPIRY_URGENT_DAYS = 30;

export function expiryStatus(daysToExpiry) {
  if (daysToExpiry === null || daysToExpiry === undefined) {
    return { key: 'unknown', tone: 'neutral', label: 'No expiry date' };
  }
  if (daysToExpiry < 0) return { key: 'expired', tone: 'critical', label: 'Expired' };
  if (daysToExpiry <= EXPIRY_URGENT_DAYS) return { key: 'urgent', tone: 'critical', label: 'Expires this month' };
  if (daysToExpiry <= EXPIRY_SOON_DAYS) return { key: 'soon', tone: 'low', label: 'Expiring soon' };
  return { key: 'ok', tone: 'ok', label: 'In date' };
}
