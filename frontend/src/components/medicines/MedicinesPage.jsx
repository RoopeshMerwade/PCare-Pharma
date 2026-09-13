import { useEffect, useState, useMemo } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { count, plural } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import MedicineModal from './MedicineModal';
import { CategoryBadge } from '../categories/CategoryModal';
import Card, { CardBody } from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import { visibleColumns } from '../../ui/Table';
import { useToast } from '../../ui/Toast';
import { PlusIcon, PillIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { StockBadge } from '../../domain/StatusBadge';

const STOCK_FILTERS = [
  { value: '', label: 'All stock levels' },
  { value: 'low', label: 'Low stock' },
  { value: 'out', label: 'Out of stock' },
];

export default function MedicinesPage() {
  const { isOwner } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [categories, setCategories] = useState([]);
  const [editing, setEditing] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const resource = useResource({
    endpoint: '/medicines',
    initialFilters: { search: '', categoryId: '', stock: '' },
    select: (res) => ({
      rows: res.data.medicines,
      pagination: res.data.pagination,
      meta: { stats: res.data.stats },
    }),
  });

  useEffect(() => {
    api.get('/categories').then((r) => setCategories(r.data.categories)).catch(() => {});
  }, []);

  /* Catalogue-wide counts from the server. These tiles say "In Catalogue" and
     "Out of Stock", and used to be computed from `resource.rows` — one page of
     up to 15 medicines — so every figure but `total` described the page rather
     than the catalogue it was labelled with.

     The fallback is that old arithmetic, kept so the tiles degrade to
     page-local numbers against an older backend instead of blanking. */
  const serverStats = resource.meta?.stats;
  const stats = useMemo(() => {
    const rows = resource.rows || [];
    return {
      total: serverStats?.total ?? resource.pagination?.total ?? rows.length,
      low: serverStats?.low ?? rows.filter((m) => m.is_low_stock && Number(m.total_stock) > 0).length,
      out: serverStats?.out ?? rows.filter((m) => Number(m.total_stock) <= 0).length,
      active: serverStats?.active ?? rows.filter((m) => m.is_active).length,
    };
  }, [serverStats, resource.rows, resource.pagination]);

  const columns = visibleColumns(
    [
      {
        key: 'name',
        label: 'Medicine',
        sortable: false,
        className: 'min-w-[240px]',
        render: (m) => {
          const isOut = Number(m.total_stock) <= 0;
          return (
            <div className="flex items-center gap-s3 py-1">
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-pill',
                  isOut
                    ? 'bg-destructive-wash text-destructive'
                    : m.is_low_stock
                    ? 'bg-warning-wash text-warning-ink'
                    : 'bg-primary-light/60 text-accent'
                )}
              >
                <PillIcon className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-col">
                <div className="flex flex-wrap items-center gap-s2">
                  <span className="font-bold text-foreground">{m.name}</span>
                  {!m.is_active && <Badge tone="neutral">Inactive</Badge>}
                  {m.near_expiry_batch_count > 0 && (
                    <Badge tone="low">{plural(m.near_expiry_batch_count, 'batch', 'batches')} near expiry</Badge>
                  )}
                </div>
                {(m.generic_name || m.manufacturer) && (
                  <span className="truncate text-xs text-muted-foreground">
                    {[m.generic_name, m.manufacturer].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            </div>
          );
        },
      },
      {
        key: 'category_name',
        label: 'Category',
        className: 'whitespace-nowrap',
        render: (m) => (
          <div className="flex items-center whitespace-nowrap">
            <CategoryBadge name={m.category_name} color={m.category_color} />
          </div>
        ),
      },
      {
        key: 'unit',
        label: 'Sold as',
        className: 'whitespace-nowrap',
        render: (m) => (
          <span className="inline-flex rounded-control border border-border bg-muted/50 px-s2 py-0.5 font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {m.unit}
          </span>
        ),
      },
      {
        key: 'default_selling_price',
        label: 'Price per unit',
        numeric: true,
        className: 'whitespace-nowrap',
        render: (m) => <Money value={m.default_selling_price} />,
      },
      {
        key: 'total_stock',
        label: 'Stock',
        numeric: true,
        className: 'whitespace-nowrap',
        render: (m) => (
          <div className="flex items-center justify-end gap-s2 whitespace-nowrap">
            <span className="tabular text-sm font-bold text-foreground">{count(m.total_stock ?? 0)}</span>
            <StockBadge medicine={m} />
          </div>
        ),
      },
    ],
    isOwner
  );

  const handleDeactivate = async () => {
    const medicine = confirm.target;
    await api.patch(`/medicines/${medicine.id}/deactivate`);
    toast.success(`${medicine.name} deactivated.`);
    resource.reload();
  };

  const handleReactivate = async (medicine) => {
    try {
      await api.patch(`/medicines/${medicine.id}/reactivate`);
      toast.success(`${medicine.name} reactivated.`);
      resource.reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <ResourcePage
        title="Medicines"
        subtitle={`${count(resource.pagination.total ?? resource.rows.length)} in the catalogue`}
        resource={resource}
        columns={columns}
        itemNoun="medicines"
        caption="The medicine catalogue with prices and current stock levels"
        isRowMuted={(m) => !m.is_active}
        allowHorizontalScroll
        search={{ value: resource.filters.search, onChange: (v) => resource.setFilter('search', v), label: 'Search medicines' }}
        searchPlaceholder="Search name, generic or manufacturer…"
        filters={[
          {
            key: 'categoryId',
            label: 'Category',
            value: resource.filters.categoryId,
            onChange: (v) => resource.setFilter('categoryId', v),
            options: [{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c.id, label: c.name }))],
          },
          {
            key: 'stock',
            label: 'Stock level',
            value: resource.filters.stock,
            onChange: (v) => resource.setFilter('stock', v),
            options: STOCK_FILTERS,
          },
        ]}
        actions={
          isOwner && (
            <Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>
              <PlusIcon className="h-4 w-4" />
              Add medicine
            </Button>
          )
        }
        rowActions={
          isOwner
            ? (m) => (
                <>
                  <Button variant="ghost" size="compact" onClick={() => { setEditing(m); setModalOpen(true); }}>Edit</Button>
                  {m.is_active ? (
                    <Button variant="ghost" size="compact" className="text-destructive" onClick={() => confirm.ask(m)}>
                      Deactivate
                    </Button>
                  ) : (
                    <Button variant="ghost" size="compact" className="text-accent" onClick={() => handleReactivate(m)}>
                      Reactivate
                    </Button>
                  )}
                </>
              )
            : undefined
        }
        emptyTitle="No medicines in the catalogue"
        emptyBody={
          isOwner
            ? 'Add a medicine to make it available for billing and purchase orders. Stock arrives separately, when you receive a purchase order.'
            : "The catalogue is empty. Ask the owner to add the medicines you stock."
        }
        emptyAction={
          isOwner
            ? <Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>Add the first medicine</Button>
            : undefined
        }
        filteredEmptyTitle="No medicines match those filters"
        filteredEmptyBody="Try a different search term, or reset the category and stock filters."
      >
        <div className="mb-s4 grid grid-cols-2 gap-s3 lg:grid-cols-4">
          <Card className="border-border">
            <CardBody className="flex flex-col gap-s1">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">In Catalogue</span>
              <span className="tabular text-lg font-bold text-foreground">{count(stats.total)}</span>
            </CardBody>
          </Card>
          <Card className="border-border">
            <CardBody className="flex flex-col gap-s1">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Active Items</span>
              <span className="tabular text-lg font-bold text-success">{count(stats.active)}</span>
            </CardBody>
          </Card>
          <Card className="border-border">
            <CardBody className="flex flex-col gap-s1">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Low Stock</span>
              <span className={cn('tabular text-lg font-bold', stats.low > 0 ? 'text-warning' : 'text-foreground')}>
                {count(stats.low)}
              </span>
            </CardBody>
          </Card>
          <Card className="border-border">
            <CardBody className="flex flex-col gap-s1">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Out of Stock</span>
              <span className={cn('tabular text-lg font-bold', stats.out > 0 ? 'text-destructive' : 'text-foreground')}>
                {count(stats.out)}
              </span>
            </CardBody>
          </Card>
        </div>
      </ResourcePage>

      <MedicineModal
        medicine={editing}
        categories={categories}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={(wasEdit) => {
          setEditing(null);
          resource.reload();
          toast.success(wasEdit ? 'Medicine updated.' : 'Medicine added to the catalogue.');
        }}
      />

      <ConfirmDialog
        {...confirm.props}
        destructive
        title={`Deactivate ${confirm.target?.name}?`}
        body="It disappears from billing and purchase order pickers. Existing stock, bills and batch history are untouched, and you can reactivate it at any time."
        confirmLabel="Deactivate medicine"
        onConfirm={handleDeactivate}
      />
    </>
  );
}
