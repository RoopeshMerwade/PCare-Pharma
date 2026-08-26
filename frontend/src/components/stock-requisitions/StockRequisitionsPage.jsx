import { useState } from 'react';
import { date, plural } from '../../lib/format';
import { Badge, Button } from '../../ui';
import { PlusIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { RequisitionStatusBadge, RequisitionUrgencyBadge } from '../../domain/StatusBadge';
import ResourcePage from '../../patterns/ResourcePage';
import useResource from '../../hooks/useResource';
import { useAuth } from '../../hooks/useAuth';
import CreateRequisitionModal from './CreateRequisitionModal';
import RequisitionDrawer from './RequisitionDrawer';

/* ═══════════════════════════════════════════════════════════════════════════
   Stock requests.

   Open to both roles, and the payload is what differs — staff receive only the
   requests they raised, scoped server-side in listRequisitions(). Approval and
   download are owner-only, guarded on the API routes rather than by hiding a
   button, so a staff session that reached them anyway would still be refused.
   ═══════════════════════════════════════════════════════════════════════════ */

const STATUS_FILTER = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Awaiting owner' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Withdrawn' },
];

const columns = [
  {
    key: 'requisition_number',
    label: 'Request',
    render: (row) => (
      <span>
        <span className="block font-bold text-foreground">{row.requisition_number}</span>
        <span className="block text-base text-muted-foreground">{row.created_by_name}</span>
      </span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    render: (row) => (
      <span className="flex flex-wrap items-center gap-s1">
        <RequisitionStatusBadge status={row.status} variant="solid" />
        <RequisitionUrgencyBadge urgency={row.urgency} variant="solid" />
      </span>
    ),
  },
  {
    key: 'item_count',
    label: 'Lines',
    render: (row) => (
      <span className="flex flex-wrap items-center gap-s1">
        {plural(row.item_count, 'line')}
        {/* The owner needs to know a request has gaps BEFORE opening it. */}
        {row.unpriced_item_count > 0 && (
          <Badge tone="warning">{row.unpriced_item_count} with no rate</Badge>
        )}
      </span>
    ),
  },
  {
    key: 'vendor_count',
    label: 'Distributors',
    numeric: true,
    render: (row) => row.vendor_count || '—',
  },
  { key: 'created_at', label: 'Raised', render: (row) => date(row.created_at) },
  {
    key: 'estimated_total',
    label: 'Estimated',
    numeric: true,
    render: (row) => <Money value={row.estimated_total} whole />,
  },
];

export default function StockRequisitionsPage() {
  const { isOwner } = useAuth();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);

  const resource = useResource({
    endpoint: '/stock-requisitions',
    initialFilters: { status: '' },
    select: (res) => ({ rows: res.data.requisitions, pagination: res.data.pagination }),
  });

  return (
    <>
      <ResourcePage
        title="Stock requests"
        subtitle={isOwner
          ? 'What the counter needs ordering, and who to order it from.'
          : 'Tell the owner what has run out.'}
        actions={(
          <Button variant="primary" onClick={() => setCreating(true)}>
            <PlusIcon className="h-5 w-5" />
            Request stock
          </Button>
        )}
        resource={resource}
        columns={columns}
        onRowClick={(row) => setOpenId(row.id)}
        itemNoun="stock requests"
        caption="Stock requests raised by counter staff"
        filters={[{
          label: 'Status',
          value: resource.filters.status,
          onChange: (v) => resource.setFilter('status', v),
          options: STATUS_FILTER,
        }]}
        emptyTitle={isOwner ? 'No stock requests yet' : "You haven't asked for anything yet"}
        emptyBody={isOwner
          ? 'When someone on the counter notices a shelf is empty, their request lands here for you to approve and order.'
          : 'When something runs out, raise a request and the owner is notified straight away.'}
        emptyAction={(
          <Button variant="primary" onClick={() => setCreating(true)}>
            <PlusIcon className="h-5 w-5" />
            Request stock
          </Button>
        )}
        filteredEmptyTitle="No requests match that filter"
        filteredEmptyBody="Try a different status, or clear the filter to see everything."
      />

      <CreateRequisitionModal
        open={creating}
        onOpenChange={setCreating}
        onCreated={resource.reload}
      />

      <RequisitionDrawer
        requisitionId={openId}
        open={Boolean(openId)}
        onOpenChange={(next) => { if (!next) setOpenId(null); }}
        onChanged={resource.reload}
      />
    </>
  );
}
