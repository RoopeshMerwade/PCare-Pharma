import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { date, plural } from '../../lib/format';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { SupplierInvoiceStatusBadge } from '../../domain/StatusBadge';
import UploadInvoiceDialog from './UploadInvoiceDialog';

/* ═══════════════════════════════════════════════════════════════════════════
   SupplierInvoicesPage — the queue.

   A list page, so it is a column definition and a useResource call, per the
   pattern. The one thing it does beyond that is send the reviewer straight into
   the invoice they just uploaded: reading is the slow part, and making someone
   find the row afterwards wastes the only moment they are certain which one it
   is.

   Both roles see this page. Staff run the goods-inward desk, and nothing they
   do here becomes stock — only the owner's Approve does.
   ═══════════════════════════════════════════════════════════════════════════ */

const STATUS_FILTERS = [
  { value: '', label: 'All invoices' },
  { value: 'NEEDS_REVIEW', label: 'Needs review' },
  { value: 'IMPORTED', label: 'Imported' },
  { value: 'REJECTED', label: 'Rejected' },
];

export default function SupplierInvoicesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [suppliers, setSuppliers] = useState([]);
  const [uploadOpen, setUploadOpen] = useState(false);

  const resource = useResource({
    endpoint: '/supplier-invoices',
    initialFilters: { status: '' },
    select: (res) => ({ rows: res.data.invoices, pagination: res.data.pagination }),
  });

  useEffect(() => {
    // /options: passed straight down to UploadInvoiceDialog's <select>.
    api.get('/suppliers/options').then((res) => setSuppliers(res.data.suppliers || [])).catch(() => {});
  }, []);

  const columns = [
    {
      key: 'invoice_no',
      label: 'Invoice',
      render: (inv) => (
        <div className="flex flex-col gap-s1">
          <span className="font-mono font-bold text-foreground">
            {inv.invoice_no || 'No number read'}
          </span>
          <span className="text-muted-foreground">
            {inv.supplier_name || inv.supplier_name_raw || 'Distributor not matched'}
          </span>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (inv) => <SupplierInvoiceStatusBadge status={inv.status} variant="solid" /> },
    {
      key: 'lines',
      label: 'Lines',
      render: (inv) => (
        <div className="flex min-w-0 items-center gap-s1 whitespace-nowrap">
          <span className="min-w-0 truncate text-foreground">{plural(inv.line_count, 'line')}</span>
          {/* Both of these are labelled, not colour-coded (A4). They are the
              reason to open a row, so they belong on the list rather than
              only inside the review screen. */}
          {inv.unmapped_count > 0 && (
            <Badge tone="critical" className="shrink-0">
              {inv.unmapped_count} unmapped
            </Badge>
          )}
          {inv.blocking_error_count > 0 && inv.unmapped_count === 0 && (
            <Badge tone="critical" className="shrink-0">
              {plural(inv.blocking_error_count, 'problem')}
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'invoice_date', label: 'Invoice date', render: (inv) => date(inv.invoice_date) },
    { key: 'created_at', label: 'Uploaded', render: (inv) => date(inv.created_at) },
    {
      key: 'net_total',
      label: 'Net total',
      numeric: true,
      render: (inv) => {
        const total = inv.net_total ?? inv.lines_total;
        return total != null
          ? <Money value={total} whole />
          : <span className="text-muted-foreground">—</span>;
      },
    },
  ];

  return (
    <>
      <ResourcePage
        title="Supplier invoices"
        subtitle="Distributor invoices read into stock"
        resource={resource}
        columns={columns}
        itemNoun="invoices"
        caption="Uploaded supplier invoices with their review status and value"
        isRowMuted={(inv) => inv.status === 'REJECTED'}
        onRowClick={(inv) => navigate(`/supplier-invoices/${inv.id}`)}
        filters={[
          {
            key: 'status',
            label: 'Status',
            value: resource.filters.status,
            onChange: (v) => resource.setFilter('status', v),
            options: STATUS_FILTERS,
          },
        ]}
        actions={
          <Button variant="primary" onClick={() => setUploadOpen(true)}>
            <PlusIcon className="h-4 w-4" />
            Upload invoice
          </Button>
        }
        rowActions={(inv) => (
          <Button
            variant={inv.status === 'NEEDS_REVIEW' ? 'secondary' : 'ghost'}
            size="compact"
            onClick={() => navigate(`/supplier-invoices/${inv.id}`)}
          >
            {inv.status === 'NEEDS_REVIEW' ? 'Review' : 'View'}
          </Button>
        )}
        emptyTitle="No supplier invoices yet"
        emptyBody="Upload a distributor's invoice and it is read once, line by line, so taking a delivery into stock is checking numbers rather than typing them."
        emptyAction={
          <Button variant="primary" onClick={() => setUploadOpen(true)}>
            Upload the first invoice
          </Button>
        }
        filteredEmptyTitle="No invoices with that status"
        filteredEmptyBody="Switch the status filter to All invoices to see every upload."
      />

      <UploadInvoiceDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        suppliers={suppliers}
        onUploaded={(invoice) => {
          resource.reload();
          toast.success(
            invoice.line_count
              ? `${plural(invoice.line_count, 'line')} read. Check them before importing.`
              : 'The document was read but no product lines were found. Check the scan.'
          );
          // Straight into the review: the person knows which invoice this is
          // right now, and will not a minute from now.
          navigate(`/supplier-invoices/${invoice.id}`);
        }}
      />
    </>
  );
}
