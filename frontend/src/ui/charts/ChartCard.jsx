import { useState } from 'react';
import Card, { CardHeader, CardTitle, CardDescription, CardBody } from '../Card';
import Table from '../Table';
import ErrorState from '../ErrorState';
import EmptyState from '../EmptyState';
import Skeleton from '../Skeleton';
import { cn } from '../../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   ChartCard — the furniture every chart sits in: title, the chart itself,
   and a "Show data table" disclosure.

   The table is not a nicety. Tooltips enhance, they never gate — every value
   a chart encodes must be reachable without hovering, and three light-mode
   series slots sit below 3:1 on the card (a validator WARN whose obligatory
   relief is exactly this table). A chart with no `table` prop needs its
   values readable somewhere else on the page, or it is shipping a fail.

   Empty copy is caller-authored and required — EmptyState throws in dev on
   generic titles, deliberately.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function ChartCard({
  title,
  subtitle,
  action,
  loading = false,          // first load only — refetch should dim, not unmount
  height = 260,             // reserved while loading, so nothing reflows
  error = null,
  onRetry,
  empty = false,
  emptyTitle,
  emptyBody,
  table,                    // { columns, rows, caption, keyField? } — the accessible twin
  className,
  children,
}) {
  const [showTable, setShowTable] = useState(false);

  const showChart = !loading && !error && !empty;
  const hasTable = showChart && table?.rows?.length > 0;

  return (
    <Card as="section" className={cn('flex flex-col', className)}>
      <CardHeader action={action}>
        <CardTitle>{title}</CardTitle>
        {subtitle && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardBody className="flex flex-1 flex-col pt-s3">
        {error ? (
          <ErrorState title="Couldn't draw this chart" message={error.message} onRetry={onRetry} />
        ) : loading ? (
          <Skeleton className="w-full rounded-control" style={{ height }} />
        ) : empty ? (
          <EmptyState title={emptyTitle} body={emptyBody} className="border-0" />
        ) : (
          children
        )}

        {hasTable && (
          <>
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              aria-expanded={showTable}
              className="mt-s2 inline-flex min-h-target items-center self-start rounded-control text-base font-bold text-accent transition-colors duration-instant hover:underline"
            >
              {showTable ? 'Hide data table' : 'Show data table'}
            </button>
            {showTable && (
              <div className="mt-s1">
                <Table
                  columns={table.columns}
                  rows={table.rows}
                  caption={table.caption}
                  keyField={table.keyField || 'id'}
                  emptyTitle={emptyTitle}
                  emptyBody={emptyBody}
                />
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
