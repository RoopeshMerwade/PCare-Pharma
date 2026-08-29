import PageHeader from './PageHeader';
import FilterBar from './FilterBar';
import Table from '../ui/Table';
import Pagination from '../ui/Pagination';
import ErrorState from '../ui/ErrorState';

/* ═══════════════════════════════════════════════════════════════════════════
   ResourcePage — header + filters + table + pager, with the loading, empty and
   error branches already wired.

   This is where most of the deleted duplication went. A list page used to be
   ~150 lines of fetch loop, skeleton markup, empty block and pager; it is now
   a column definition and a call to useResource.

   The empty state takes TWO sets of copy, because "nothing matches your
   filters" and "there is nothing here yet" are different situations needing
   different actions (§5). Passing one message for both is the mistake this
   signature is shaped to prevent.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function ResourcePage({
  title,
  subtitle,
  actions,
  resource,
  columns,
  keyField = 'id',
  onRowClick,
  rowActions,
  isRowMuted,
  sort,
  onSortChange,
  search,
  searchPlaceholder,
  filters = [],
  emptyTitle,
  emptyBody,
  emptyAction,
  filteredEmptyTitle,
  filteredEmptyBody,
  itemNoun = 'items',
  caption,
  allowHorizontalScroll = false,
  children,
}) {
  const { rows, pagination, loading, error, isFiltered, goToPage } = resource;

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />

      {children}

      {(search || filters.length > 0) && (
        <FilterBar
          search={search?.value}
          onSearchChange={search?.onChange}
          searchPlaceholder={searchPlaceholder}
          searchLabel={search?.label}
          filters={filters}
        />
      )}

      {error ? (
        <ErrorState
          title={`Couldn't load ${itemNoun}`}
          message={error.message}
          onRetry={resource.reload}
        />
      ) : (
        <>
          <Table
            columns={columns}
            rows={rows}
            keyField={keyField}
            loading={loading}
            itemNoun={itemNoun}
            onRowClick={onRowClick}
            rowActions={rowActions}
            isRowMuted={isRowMuted}
            sort={sort}
            onSortChange={onSortChange}
            caption={caption}
            allowHorizontalScroll={allowHorizontalScroll}
            emptyTitle={isFiltered ? (filteredEmptyTitle || emptyTitle) : emptyTitle}
            emptyBody={isFiltered ? (filteredEmptyBody || emptyBody) : emptyBody}
            emptyAction={isFiltered ? undefined : emptyAction}
          />

          {!loading && (
            <Pagination
              page={pagination.page}
              pages={pagination.pages}
              total={pagination.total}
              limit={pagination.limit}
              onPageChange={goToPage}
              itemNoun={itemNoun}
            />
          )}
        </>
      )}
    </div>
  );
}
