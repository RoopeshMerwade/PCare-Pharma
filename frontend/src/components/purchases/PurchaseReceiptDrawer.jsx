import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { date, daysUntil, money, qty as formatQty } from '../../lib/format';
import { Drawer, DrawerContent, DrawerHeader, DrawerBody } from '../../ui/Drawer';
import ErrorState from '../../ui/ErrorState';
import EmptyState from '../../ui/EmptyState';
import { SkeletonRegion, SkeletonRows } from '../../ui/Skeleton';
import { Money } from '../../domain/Money';
import { ExpiryBadge } from '../../domain/StatusBadge';

/* ═══════════════════════════════════════════════════════════════════════════
   PurchaseReceiptDrawer — what a received order actually put into stock.

   Read-only by design. Receipts create ledger entries, and the ledger is
   append-only (CLAUDE.md: no hard deletes, corrections go through returns), so
   there is no edit affordance here to imply otherwise.

   It shows cost against selling price per batch because that margin is the
   reason an owner opens this at all — and purchases is an owner-only route, so
   no field-gating applies.
   ═══════════════════════════════════════════════════════════════════════════ */

function ReceiptLine({ item }) {
  const medicine = item.medicines || {};
  const unit = medicine.unit || 'units';
  const cost = parseFloat(item.unit_cost) || 0;
  const selling = parseFloat(item.selling_price) || 0;
  const received = item.qty_received ?? 0;
  const margin = selling - cost;

  return (
    <li className="rounded-card border border-border p-s3">
      <div className="flex flex-wrap items-baseline justify-between gap-s2">
        <span className="text-base font-bold text-foreground">{medicine.name || 'Unknown medicine'}</span>
        <span className="text-base text-muted-foreground">{formatQty(received, unit)}</span>
      </div>

      <dl className="mt-s2 flex flex-col divide-y divide-border">
        <div className="flex items-baseline justify-between gap-s3 py-s1">
          <dt className="text-base text-muted-foreground">Batch</dt>
          <dd className="font-mono text-base font-bold text-foreground">{item.batch_no || '—'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-s3 py-s1">
          <dt className="text-base text-muted-foreground">Expires</dt>
          <dd className="flex items-center gap-s2">
            <span className="text-base text-foreground">{date(item.exp_date)}</span>
            {item.exp_date && <ExpiryBadge daysToExpiry={daysUntil(item.exp_date)} />}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-s3 py-s1">
          <dt className="text-base text-muted-foreground">Cost / MRP</dt>
          <dd className="flex items-baseline gap-s2">
            <Money value={item.unit_cost} />
            <span className="text-base text-muted-foreground">/</span>
            <Money value={item.mrp} className="text-base" />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-s3 py-s1">
          <dt className="text-base text-muted-foreground">Selling price</dt>
          <dd className="flex items-baseline gap-s2">
            <Money value={item.selling_price} />
            {/* money() renders its own minus sign, so only the plus is added. */}
            <span className="text-base text-muted-foreground">
              {margin >= 0 ? '+' : ''}{money(margin)} margin
            </span>
          </dd>
        </div>
      </dl>
    </li>
  );
}

export default function PurchaseReceiptDrawer({ purchase, open, onOpenChange }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !purchase) return undefined;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);

    api.get(`/purchases/${purchase.id}`)
      .then((res) => { if (!cancelled) setDetail(res.data.purchase); })
      .catch((err) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, purchase]);

  const items = detail?.items || [];
  const receivedValue = items.reduce(
    (sum, i) => sum + (i.qty_received ?? 0) * (parseFloat(i.unit_cost) || 0),
    0
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader
          title={`Receipt for ${purchase?.purchase_number ?? 'order'}`}
          description={
            detail?.received_at
              ? `Received ${date(detail.received_at)} from ${purchase?.supplier_name ?? 'the supplier'}${detail?.invoice_no ? ` • Inv: ${detail.invoice_no}` : ''}.`
              : purchase?.supplier_name
          }
        />

        <DrawerBody>
          {loading && (
            <SkeletonRegion label="Loading the receipt lines…">
              <SkeletonRows count={3} />
            </SkeletonRegion>
          )}

          {error && <ErrorState title="Couldn't load the receipt" message={error.message} />}

          {!loading && !error && items.length === 0 && (
            <EmptyState
              title="No lines on this receipt"
              body="The order was marked received but carries no item lines. Check the audit log for what happened to it."
            />
          )}

          {!loading && !error && items.length > 0 && (
            <>
              <ul className="flex flex-col gap-s2">
                {items.map((item) => <ReceiptLine key={item.id} item={item} />)}
              </ul>

              <div className="mt-s4 flex items-baseline justify-between gap-s3 border-t border-border pt-s3">
                <span className="text-sm font-bold text-foreground">Total received value</span>
                <Money value={receivedValue} className="text-md" />
              </div>
            </>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
