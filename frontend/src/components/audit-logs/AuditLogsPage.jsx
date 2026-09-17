/* Hallmark · pre-emit critique: P5 H5 E4 S5 R4 V4
 * Hallmark · component: AuditLogsPage · genre: modern-minimal · theme: Cobalt
 * states: default · hover · focus · active · disabled · loading · error · empty
 * contrast: pass
 */
import { useState } from 'react';
import useResource from '../../hooks/useResource';
import { dateTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import PageHeader from '../../patterns/PageHeader';
import Field from '../../ui/Field';
import Select from '../../ui/Select';
import Input from '../../ui/Input';
import Pagination from '../../ui/Pagination';
import EmptyState from '../../ui/EmptyState';
import ErrorState from '../../ui/ErrorState';
import { SkeletonRegion, SkeletonRows } from '../../ui/Skeleton';
import Badge from '../../ui/Badge';

const actionTone = (action) => {
  if (action?.includes('failed') || action?.includes('blocked')) return 'critical';
  if (action?.includes('deactivated') || action?.includes('deleted')) return 'warning';
  if (action?.includes('login') || action?.includes('created')) return 'success';
  return 'neutral';
};

const initials = (name) => (name || 'System')
  .split(' ')
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0])
  .join('')
  .toUpperCase();

export default function AuditLogsPage() {
  const [actionTypes, setActionTypes] = useState([]);
  const [expanded, setExpanded] = useState(null);

  const resource = useResource({
    endpoint: '/audit-logs',
    initialFilters: { action: '', dateFrom: '', dateTo: '' },
    select: (res) => {
      if (res.data.action_types?.length) setActionTypes(res.data.action_types);
      return { rows: res.data.logs, pagination: res.data.pagination };
    },
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Audit Log" subtitle="An immutable record of system changes and staff activity" />

      <div className="mb-s5 grid gap-s3 sm:grid-cols-3">
        <Field label="Action">
          <Select 
            value={resource.filters.action} 
            onChange={(e) => resource.setFilter('action', e.target.value)}
            className="bg-card"
          >
            <option value="">All actions</option>
            {actionTypes.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </Field>
        <Field label="From date">
          <Input 
            type="date" 
            value={resource.filters.dateFrom} 
            onChange={(e) => resource.setFilter('dateFrom', e.target.value)} 
            className="bg-card"
          />
        </Field>
        <Field label="To date">
          <Input 
            type="date" 
            value={resource.filters.dateTo} 
            onChange={(e) => resource.setFilter('dateTo', e.target.value)} 
            className="bg-card"
          />
        </Field>
      </div>

      {resource.error ? (
        <ErrorState title="Couldn't load the audit log" message={resource.error.message} onRetry={resource.reload} />
      ) : resource.loading ? (
        <SkeletonRegion label="Loading the audit log…">
          <SkeletonRows count={8} className="gap-s2" />
        </SkeletonRegion>
      ) : resource.rows.length === 0 ? (
        <EmptyState
          title={resource.isFiltered ? 'No entries match those filters' : 'No log entries yet'}
          body={
            resource.isFiltered
              ? 'Try a wider date range, or clear the action filter.'
              : 'The audit log records every change to stock, prices, staff and settings. It fills up as the shop is used.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-card shadow-1" data-state="success">
          <div className="flex flex-col gap-s3 border-b border-border bg-muted px-s4 py-s3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-lg font-bold text-foreground">Activity stream</p>
              <p className="text-base text-muted-foreground">
                {resource.pagination.total} recorded {resource.pagination.total === 1 ? 'event' : 'events'}
              </p>
            </div>
            <Badge tone="success">Live record</Badge>
          </div>
          <ul className="flex flex-col divide-y divide-border">
            {resource.rows.map((log) => {
              const isOpen = expanded === log.id;
              const hasDetail = log.metadata && Object.keys(log.metadata).length > 0;
              return (
                <li key={log.id} className="group transition-colors duration-instant hover:bg-muted">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : log.id)}
                    aria-expanded={isOpen}
                    disabled={!hasDetail}
                    className="flex min-h-target w-full items-start gap-s3 px-s3 py-s3 text-left disabled:cursor-default disabled:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:items-center sm:gap-s4 sm:px-s4"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-primary text-sm font-bold text-primary-foreground">
                      {initials(log.user_name)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-s1 sm:flex-row sm:items-center sm:gap-s4">
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-s2">
                          <span className="text-base font-bold text-foreground">{log.action_label}</span>
                          <Badge tone={actionTone(log.action)}>{log.user_role}</Badge>
                        </span>
                        <span className="block truncate text-base text-muted-foreground">{log.user_name}</span>
                      </span>
                      <span className="shrink-0 text-sm text-muted-foreground sm:text-right">{dateTime(log.created_at)}</span>
                      {hasDetail && (
                        <span className={cn(
                          'shrink-0 text-sm font-bold transition-colors duration-instant',
                          isOpen ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                        )}>
                          {isOpen ? 'Hide' : 'Details'}
                        </span>
                      )}
                    </span>
                  </button>
                  {isOpen && hasDetail && (
                    <div className="border-t border-border bg-background px-s4 py-s3 sm:pl-20">
                      <pre className="overflow-x-auto rounded-control border border-border bg-muted p-s3 font-mono text-sm text-foreground">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!resource.loading && !resource.error && resource.rows.length > 0 && (
        <div className="mt-s5">
          <Pagination
            page={resource.pagination.page}
            pages={resource.pagination.pages}
            total={resource.pagination.total}
            limit={resource.pagination.limit}
            onPageChange={resource.goToPage}
          />
        </div>
      )}
    </div>
  );
}
