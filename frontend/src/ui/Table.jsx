import { cn } from '../lib/cn';
import Skeleton from './Skeleton';
import EmptyState from './EmptyState';
import { ListField } from './List';

/* ═══════════════════════════════════════════════════════════════════════════
   Table — §3.7. One instance by the spec's count, but the highest per-instance
   complexity in the app (the medicine inventory table).

   Column config drives everything, which is what makes role-gating a security
   control rather than a styling one: an Owner-only column is REMOVED FROM THE
   COLUMNS ARRAY, so no cell is ever rendered and nothing exists in the DOM or
   the accessibility tree for a Staff session (A9, §6). Use `visibleColumns()`
   below — never a CSS class, never `aria-hidden`.

     const columns = visibleColumns([
       { key: 'name',  label: 'Medicine' },
       { key: 'cost',  label: 'Cost price', numeric: true, ownerOnly: true },
     ], isOwner);

   Below `md` the table becomes one card per row rather than a horizontal
   scroller. §3.7 permits horizontal scroll only as an opt-in on the sales
   history table, via `allowHorizontalScroll`.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Strips columns the current role may not see. Returns a new array; the
 * removed columns are gone, not hidden.
 */
export function visibleColumns(columns, isOwner) {
  return columns.filter((col) => !col.ownerOnly || isOwner);
}

const SortIcon = ({ dir }) => (
  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    {dir === 'asc' && <path d="M7 14l5-5 5 5" />}
    {dir === 'desc' && <path d="M7 10l5 5 5-5" />}
    {!dir && <path d="M8 10l4-4 4 4M8 14l4 4 4-4" opacity="0.4" />}
  </svg>
);

export default function Table({
  columns,
  rows,
  keyField = 'id',
  onRowClick,
  rowActions,
  isRowMuted,
  sort,
  onSortChange,
  loading = false,
  emptyTitle,
  emptyBody,
  emptyAction,
  caption,
  allowHorizontalScroll = false,
  className,
}) {
  if (loading) {
    return (
      <div className="overflow-hidden rounded-card border border-border bg-card">
        {/* Skeleton mirrors the real column structure so nothing reflows. */}
        <div className="hidden border-b border-border bg-muted px-s3 py-s2 md:flex md:gap-s3">
          {columns.map((col) => (
            <Skeleton key={col.key} className="h-4 flex-1" />
          ))}
        </div>
        <div className="flex flex-col gap-s2 p-s3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-target w-full" />
          ))}
        </div>
      </div>
    );
  }

  // §3.7: the empty state renders inside the table region, so filters and
  // search stay visible and the user can undo whatever emptied it.
  if (!rows?.length) {
    return <EmptyState title={emptyTitle} body={emptyBody} action={emptyAction} />;
  }

  const handleSort = (col) => {
    if (!col.sortable || !onSortChange) return;
    const dir = sort?.key === col.key && sort.dir === 'asc' ? 'desc' : 'asc';
    onSortChange({ key: col.key, dir });
  };

  return (
    <>
      {/* ── Desktop: a real table ───────────────────────────────────────── */}
      {/* `relative` contains the sr-only <caption> (position:absolute) — with
          no positioned ancestor it would escape to the <body>'s coordinate
          space and stretch the page's scrollable area. */}
      <div
        className={cn(
          'relative hidden rounded-card border border-border bg-card md:block',
          allowHorizontalScroll ? 'overflow-x-auto' : 'overflow-hidden',
          className
        )}
      >
        <table className="w-full border-collapse">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-border-strong bg-muted">
              {columns.map((col) => {
                const active = sort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    // aria-sort reflects state for assistive tech (§3.7).
                    aria-sort={col.sortable ? (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                    className={cn(
                      'px-s3 py-s2 text-base font-bold text-muted-foreground',
                      col.numeric || col.align === 'right' ? 'text-right' : 'text-left'
                    )}
                  >
                    {col.sortable ? (
                      // A real button: Enter and Space sort it, and it is a
                      // Tab stop. A th with an onClick is neither.
                      <button
                        type="button"
                        onClick={() => handleSort(col)}
                        className={cn(
                          'inline-flex min-h-target items-center gap-s1 rounded-control py-s1 transition-colors duration-instant hover:text-foreground',
                          col.numeric || col.align === 'right' ? 'flex-row-reverse' : ''
                        )}
                      >
                        {col.label}
                        <SortIcon dir={active ? sort.dir : null} />
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                );
              })}
              {rowActions && (
                <th scope="col" className="px-s3 py-s2 text-right text-base font-bold text-muted-foreground">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const muted = isRowMuted?.(row);
              return (
                <tr
                  key={row[keyField]}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-border last:border-0 transition-colors duration-instant',
                    onRowClick && 'cursor-pointer hover:bg-muted'
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        'px-s3 py-s2 align-middle',
                        // §2.1: currency and stock figures never render below
                        // 16px — these are the numbers checked under pressure.
                        col.numeric ? 'tabular text-right text-sm font-bold' : 'text-base',
                        col.align === 'right' && !col.numeric && 'text-right',
                        muted ? 'text-muted-foreground' : 'text-foreground',
                        col.className
                      )}
                    >
                      {col.render ? col.render(row) : row[col.key]}
                    </td>
                  ))}
                  {rowActions && (
                    // Always rendered, never revealed on hover — §3.7 and §6
                    // both prohibit hover-only row actions as a keyboard failure.
                    <td className="px-s3 py-s2 text-right">
                      <div
                        className="flex items-center justify-end gap-s1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {rowActions(row)}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Below md: one card per row, built from the same column config ── */}
      <div className="flex flex-col gap-s2 md:hidden">
        {rows.map((row) => {
          const muted = isRowMuted?.(row);
          const [primary, ...rest] = columns;
          return (
            <div
              key={row[keyField]}
              className={cn(
                'rounded-card border border-border bg-card p-s3',
                onRowClick && 'cursor-pointer active:bg-muted'
              )}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              <div className={cn('text-sm font-bold', muted ? 'text-muted-foreground' : 'text-foreground')}>
                {primary.render ? primary.render(row) : row[primary.key]}
              </div>
              <div className="mt-s2 flex flex-col divide-y divide-border">
                {rest.map((col) => (
                  <ListField
                    key={col.key}
                    label={col.label}
                    numeric={col.numeric}
                    value={col.render ? col.render(row) : row[col.key]}
                  />
                ))}
              </div>
              {rowActions && (
                <div
                  className="mt-s3 flex flex-wrap items-center gap-s2 border-t border-border pt-s3"
                  onClick={(e) => e.stopPropagation()}
                >
                  {rowActions(row)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
