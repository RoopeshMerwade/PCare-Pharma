import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { count, plural } from '../../lib/format';
import useResource from '../../hooks/useResource';
import ResourcePage from '../../patterns/ResourcePage';
import BatchDrawer from './BatchDrawer';
import { CategoryBadge } from '../categories/CategoryModal';
import Badge from '../../ui/Badge';
import Button from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { Qty } from '../../domain/Money';
import { contentNoun } from '../../domain/pack';
import { StockBadge } from '../../domain/StatusBadge';
import { stockStatus } from '../../domain/stock';

const STOCK_FILTERS = [
  { value: '', label: 'All stock levels' },
  { value: 'low', label: 'Low stock' },
  { value: 'out', label: 'Out of stock' },
  { value: 'near_expiry', label: 'Near expiry' },
];

export default function InventoryPage() {
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const initialStock = searchParams.get('stock') || '';
  const [categories, setCategories] = useState([]);
  const [selected, setSelected] = useState(null);

  const resource = useResource({
    endpoint: '/inventory',
    initialFilters: { search: '', categoryId: '', stock: initialStock },
    select: (res) => ({
      rows: res.data.inventory,
      pagination: res.data.pagination,
      meta: { stats: res.data.stats },
    }),
  });

  useEffect(() => {
    const stock = searchParams.get('stock');
    if (stock !== null && stock !== resource.filters?.stock) {
      resource.setFilter('stock', stock);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/categories').then((r) => setCategories(r.data.categories)).catch(() => {});
  }, []);

  /* Whole-catalogue counts from the server, scoped to the search and category
     but deliberately NOT to the stock filter — these chips SET that filter, so
     a count that changed because you clicked it could not be used to navigate.

     The ?? fallbacks are the page's old row-derived arithmetic. They cover an
     older backend and a count query that failed on its own (the service sends
     null rather than 0 for that, so an unknown chip is absent, not a claim). */
  const stats = resource.meta?.stats;
  const alerts = {
    out: stats?.out ?? resource.rows.filter((m) => stockStatus(m).key === 'out').length,
    low: stats?.low ?? resource.rows.filter((m) => stockStatus(m).key === 'low').length,
    near: stats?.near ?? resource.rows.filter((m) => m.near_expiry_batch_count > 0).length,
  };

  const columns = [
    {
      key: 'name',
      label: 'Medicine',
      render: (m) => (
        <div className="flex flex-col gap-s1">
          <div className="flex flex-wrap items-center gap-s2">
            <span className="font-bold text-foreground">{m.name}</span>
            {m.near_expiry_batch_count > 0 && (
              <Badge tone="low">{plural(m.near_expiry_batch_count, 'batch', 'batches')} near expiry</Badge>
            )}
          </div>
          {m.manufacturer && <span className="text-muted-foreground">{m.manufacturer}</span>}
        </div>
      ),
    },
    {
      key: 'category_name',
      label: 'Category',
      render: (m) => <CategoryBadge name={m.category_name} color={m.category_color} />,
    },
    {
      key: 'total_stock',
      label: 'On hand',
      numeric: true,
      /* Sealed packs are the headline because that is what the reorder
         threshold counts. Loose units sit underneath rather than being added
         in: 24 strips plus 6 tablets is not 30 of anything, and a single
         blended number is what would send someone to the shelf for the wrong
         thing. */
      render: (m) => (
        <>
          <Qty value={m.total_stock} unit={m.unit} />
          {Number(m.total_loose_stock) > 0 && (
            <span className="block text-base text-warning-ink">
              + {plural(Number(m.total_loose_stock), contentNoun(m.pack_content_unit))} loose
            </span>
          )}
        </>
      ),
    },
    { key: 'status', label: 'Status', render: (m) => <StockBadge medicine={m} /> },
  ];

  return (
    <>
      <ResourcePage
        title="Inventory"
        subtitle={`${count(stats?.total ?? resource.pagination.total ?? resource.rows.length)} medicines stocked`}
        resource={resource}
        columns={columns}
        itemNoun="medicines"
        caption="Current stock on hand for each medicine"
        onRowClick={(m) => setSelected(m)}
        search={{ value: resource.filters.search, onChange: (v) => resource.setFilter('search', v), label: 'Search inventory' }}
        searchPlaceholder="Search medicines…"
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
        rowActions={(m) => (
          <Button variant="ghost" size="compact" onClick={() => setSelected(m)}>
            View batches
          </Button>
        )}
        emptyTitle="Nothing in stock yet"
        emptyBody="Stock appears here once a purchase order is received. Until then the catalogue exists but the shelves are empty."
        filteredEmptyTitle="No medicines match those filters"
        filteredEmptyBody="Try a different search term, or reset the category and stock filters."
      >
        {/* Quick filters for the three things worth acting on today. Each
            carries its count in words, so the chips are readable without
            relying on colour (A4). */}
        {!resource.loading && (alerts.out > 0 || alerts.low > 0 || alerts.near > 0) && (
          <div className="mb-s4 flex flex-wrap gap-s2">
            {alerts.out > 0 && (
              <AlertChip
                tone="critical"
                active={resource.filters.stock === 'out'}
                onClick={() => resource.setFilter('stock', resource.filters.stock === 'out' ? '' : 'out')}
              >
                {plural(alerts.out, 'medicine')} out of stock
              </AlertChip>
            )}
            {alerts.low > 0 && (
              <AlertChip
                tone="low"
                active={resource.filters.stock === 'low'}
                onClick={() => resource.setFilter('stock', resource.filters.stock === 'low' ? '' : 'low')}
              >
                {plural(alerts.low, 'medicine')} running low
              </AlertChip>
            )}
            {alerts.near > 0 && (
              <AlertChip
                tone="low"
                active={resource.filters.stock === 'near_expiry'}
                onClick={() => resource.setFilter('stock', resource.filters.stock === 'near_expiry' ? '' : 'near_expiry')}
              >
                {plural(alerts.near, 'medicine')} with batches near expiry
              </AlertChip>
            )}
          </div>
        )}
      </ResourcePage>

      <BatchDrawer
        medicine={selected}
        open={Boolean(selected)}
        onOpenChange={(next) => { if (!next) { setSelected(null); resource.reload(); } }}
        onChanged={(message) => { toast.success(message); resource.reload(); }}
      />
    </>
  );
}

function AlertChip({ tone, active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="min-h-target rounded-pill transition-opacity duration-instant hover:opacity-80"
    >
      <Badge tone={tone} className={active ? 'ring-2 ring-ring ring-offset-2' : undefined}>
        {children}
      </Badge>
    </button>
  );
}
