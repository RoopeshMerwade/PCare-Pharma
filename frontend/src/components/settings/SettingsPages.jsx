import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { count, dateTime } from '../../lib/format';
import useResource from '../../hooks/useResource';
import { useTheme } from '../../hooks/useTheme';
import PageHeader from '../../patterns/PageHeader';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Card, { CardBody, CardHeader, CardTitle } from '../../ui/Card';
import Field from '../../ui/Field';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Pagination from '../../ui/Pagination';
import EmptyState from '../../ui/EmptyState';
import ErrorState from '../../ui/ErrorState';
import Skeleton, { SkeletonCard, SkeletonFields, SkeletonRegion, SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { notificationMeta } from '../../domain/notifications';

/* ══════════════════════════════ NOTIFICATIONS ══════════════════════════════ */

export function NotificationsPage() {
  const toast = useToast();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/notifications');
      setNotifications(res.data.notifications);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const unread = notifications.filter((n) => !n.is_read).length;

  const markRead = async (id) => {
    setNotifications((ns) => ns.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    try {
      // Encoded because a derived alert's id is an `alert:TYPE:entity:tier` key,
      // not a UUID. Colons are legal in a path segment, but encoding is correct.
      await api.patch(`/notifications/${encodeURIComponent(id)}/read`);
    } catch (err) {
      // Put it back — pretending it worked would hide a real alert.
      setNotifications((ns) => ns.map((n) => (n.id === id ? { ...n, is_read: false } : n)));
      toast.error(err.message);
    }
  };

  const markAll = async () => {
    try {
      await api.patch('/notifications/read-all');
      setNotifications((ns) => ns.map((n) => ({ ...n, is_read: true })));
      toast.success('All notifications marked as read.');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle={unread > 0 ? `${count(unread)} unread` : 'Everything here has been read'}
        actions={
          <Button
            variant="secondary"
            onClick={markAll}
            blockedReason={unread === 0 ? 'Nothing to mark — every notification has already been read.' : null}
          >
            Mark all as read
          </Button>
        }
      />

      {error ? (
        <ErrorState title="Couldn't load notifications" message={error.message} onRetry={fetchNotifications} />
      ) : loading ? (
        // `leading` for the type icon every notification row carries.
        <SkeletonRegion label="Loading notifications…">
          <SkeletonRows count={5} leading trailing={false} />
        </SkeletonRegion>
      ) : notifications.length === 0 ? (
        <EmptyState
          title="Nothing needs your attention"
          body="Low stock, expiring batches and pending returns all raise a notification here. A quiet list means none of those are outstanding."
        />
      ) : (
        <ul className="flex flex-col gap-s2">
          {notifications.map((n) => {
            const Icon = notificationMeta(n.type).icon;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => !n.is_read && markRead(n.id)}
                  className={cn(
                    'flex w-full min-h-target items-start gap-s3 rounded-card border p-s3 text-left',
                    'transition-colors duration-instant hover:bg-muted',
                    n.is_read ? 'border-border bg-card' : 'border-accent bg-card'
                  )}
                >
                  <Icon className={cn('mt-s1 h-5 w-5 shrink-0', n.is_read ? 'text-muted-foreground' : 'text-accent')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-s2">
                      {/* Unread is marked by weight and a word, never by the
                          dot alone — a bare colour dot fails A4. */}
                      <span className={cn('text-base', n.is_read ? 'font-normal text-muted-foreground' : 'font-bold text-foreground')}>
                        {n.title}
                      </span>
                      {!n.is_read && <Badge tone="flag">Unread</Badge>}
                    </span>
                    <span className="mt-s1 block text-base text-muted-foreground">{n.message}</span>
                    {/* Derived alerts say their condition ("Expires in 12 days")
                        rather than a timestamp — see NotificationBell. */}
                    <span className="mt-s1 block text-base text-muted-foreground">
                      {n.context || dateTime(n.created_at)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ═══════════════════════════════ SETTINGS ═══════════════════════════════ */

const SECTIONS = [
  {
    title: 'Pharmacy details',
    fields: [
      { key: 'pharmacy_name', label: 'Pharmacy name' },
      { key: 'pharmacy_address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'pincode', label: 'PIN code', inputMode: 'numeric' },
    ],
  },
  {
    title: 'Licensing',
    fields: [
      { key: 'drug_license_no', label: 'Drug licence number', mono: true },
      { key: 'gst_no', label: 'GST number', mono: true },
    ],
  },
  {
    title: 'Contact',
    fields: [
      { key: 'owner_name', label: 'Owner name' },
      { key: 'phone', label: 'Phone', type: 'tel', inputMode: 'numeric' },
      { key: 'email', label: 'Email', type: 'email' },
    ],
  },
  {
    title: 'Defaults for new records',
    fields: [
      { key: 'default_low_stock_threshold', label: 'Low stock alert at', hint: 'units', inputMode: 'numeric' },
      { key: 'default_credit_terms_days', label: 'Supplier credit terms', hint: 'days', inputMode: 'numeric' },
      { key: 'financial_year_start', label: 'Financial year starts', month: true },
    ],
  },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ThemeSkeleton() {
  return (
    <div className="flex h-full w-full flex-col justify-between gap-s1.5">
      <div className="flex h-5 w-full items-center rounded-pill bg-card px-s2 shadow-1">
        <div className="h-1.5 w-3/5 rounded-pill bg-muted" />
      </div>
      <div className="flex h-5 w-full items-center gap-s2 rounded-pill bg-card px-s2 shadow-1">
        <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted" />
        <div className="h-1.5 w-4/5 rounded-pill bg-muted" />
      </div>
      <div className="flex h-5 w-full items-center gap-s2 rounded-pill bg-card px-s2 shadow-1">
        <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted" />
        <div className="h-1.5 w-4/5 rounded-pill bg-muted" />
      </div>
    </div>
  );
}

function ThemePreviewCard({ variant }) {
  if (variant === 'system') {
    return (
      <div className="relative h-24 w-full overflow-hidden rounded-card border-2 border-border">
        {/* Light half (top-left) */}
        <div
          className="absolute inset-0 flex flex-col justify-between bg-background p-s2"
          data-theme="light"
        >
          <ThemeSkeleton />
        </div>
        {/* Dark half (bottom-right) */}
        <div
          className="absolute inset-0 flex flex-col justify-between bg-background p-s2 [clip-path:polygon(100%_0,0_100%,100%_100%)]"
          data-theme="dark"
        >
          <ThemeSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-24 w-full flex-col justify-between rounded-card border-2 border-border bg-background p-s2"
      data-theme={variant}
    >
      <ThemeSkeleton />
    </div>
  );
}

export function AppearanceCard() {
  const { theme, setTheme } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <p className="text-base text-muted-foreground">Applies to this device only.</p>
      </CardHeader>
      <CardBody className="pt-s3">
        <fieldset>
          <legend className="mb-s3 text-base font-bold text-foreground">Theme</legend>
          <div className="grid max-w-lg grid-cols-3 gap-s3">
            {[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ].map((opt) => {
              const isSelected = theme === opt.value;
              return (
                <label
                  key={opt.value}
                  className="group flex cursor-pointer flex-col items-center gap-s2"
                >
                  <div
                    className={cn(
                      'w-full rounded-card p-s1 transition-all duration-instant',
                      isSelected
                        ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                        : 'group-hover:ring-1 group-hover:ring-border-strong'
                    )}
                  >
                    <ThemePreviewCard variant={opt.value} />
                  </div>
                  <div className="flex items-center gap-s1">
                    <input
                      type="radio"
                      name="theme"
                      value={opt.value}
                      checked={isSelected}
                      onChange={() => setTheme(opt.value)}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        'text-base',
                        isSelected ? 'font-bold text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                      )}
                    >
                      {opt.label}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>
      </CardBody>
    </Card>
  );
}

export function SettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/settings');
      setForm(res.data.settings || {});
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.patch('/settings', form);
      toast.success('Settings saved.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div>
        <PageHeader title="Settings" />
        <div className="flex flex-col gap-s4">
          <AppearanceCard />
          <ErrorState title="Couldn't load settings" message={error.message} onRetry={fetchSettings} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Details that appear on bills and drive default values" />

      <div className="flex flex-col gap-s4">
        {/* Device-only appearance settings rendered above the shop-wide config form */}
        <AppearanceCard />

        {loading ? (
          // One card per section, each holding the field count that section
          // actually has — the form is a known shape even before its values
          // arrive, so there is no excuse for it to land somewhere else.
          <SkeletonRegion label="Loading your pharmacy details…" className="flex flex-col gap-s4">
            {SECTIONS.map((section) => (
              <SkeletonCard key={section.title}>
                <SkeletonFields count={section.fields.length} className="sm:grid sm:grid-cols-2" />
              </SkeletonCard>
            ))}
            <div className="flex justify-end">
              <Skeleton className="h-target w-40 rounded-pill" />
            </div>
          </SkeletonRegion>
        ) : (
          <>
            {SECTIONS.map((section) => (
              <Card key={section.title}>
                <CardHeader>
                  <CardTitle>{section.title}</CardTitle>
                </CardHeader>
                <CardBody className="grid gap-s4 sm:grid-cols-2">
                  {section.fields.map((field) => (
                    <Field key={field.key} label={field.label} hint={field.hint}>
                      {field.month ? (
                        <Select
                          value={form[field.key] || ''}
                          onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                        >
                          <option value="">Select a month…</option>
                          {MONTHS.map((month, i) => (
                            <option key={month} value={String(i + 1)}>{month}</option>
                          ))}
                        </Select>
                      ) : (
                        <Input
                          type={field.type || 'text'}
                          inputMode={field.inputMode}
                          value={form[field.key] || ''}
                          onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                          className={field.mono ? 'font-mono' : undefined}
                        />
                      )}
                    </Field>
                  ))}
                </CardBody>
              </Card>
            ))}

            <div className="flex justify-end">
              <Button variant="primary" loading={saving} onClick={handleSave}>
                Save settings
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════ AUDIT LOG ═══════════════════════════════ */

export function AuditLogsPage() {
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
    <div>
      <PageHeader title="Audit Log" subtitle="Every change, who made it and when" />

      <div className="mb-s4 grid gap-s3 sm:grid-cols-3 sm:max-w-[42rem]">
        <Field label="Action">
          <Select value={resource.filters.action} onChange={(e) => resource.setFilter('action', e.target.value)}>
            <option value="">All actions</option>
            {actionTypes.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </Field>
        <Field label="From date">
          <Input type="date" value={resource.filters.dateFrom} onChange={(e) => resource.setFilter('dateFrom', e.target.value)} />
        </Field>
        <Field label="To date">
          <Input type="date" value={resource.filters.dateTo} onChange={(e) => resource.setFilter('dateTo', e.target.value)} />
        </Field>
      </div>

      {resource.error ? (
        <ErrorState title="Couldn't load the audit log" message={resource.error.message} onRetry={resource.reload} />
      ) : resource.loading ? (
        <SkeletonRegion label="Loading the audit log…">
          <SkeletonRows count={8} className="gap-s1" />
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
        <>
          <ul className="flex flex-col gap-s1">
            {resource.rows.map((log) => {
              const isOpen = expanded === log.id;
              const hasDetail = log.metadata && Object.keys(log.metadata).length > 0;
              return (
                <li key={log.id} className="overflow-hidden rounded-card border border-border bg-card">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : log.id)}
                    aria-expanded={isOpen}
                    disabled={!hasDetail}
                    className="flex w-full min-h-target items-center gap-s3 px-s3 py-s2 text-left transition-colors duration-instant hover:bg-muted disabled:cursor-default disabled:opacity-100"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-s2">
                        <span className="text-base font-bold text-foreground">{log.action_label}</span>
                        <Badge tone="neutral">{log.user_role}</Badge>
                      </span>
                      <span className="block text-base text-muted-foreground">
                        {log.user_name} · {dateTime(log.created_at)}
                      </span>
                    </span>
                    {hasDetail && (
                      <span className="shrink-0 text-base text-muted-foreground">{isOpen ? 'Hide details' : 'Details'}</span>
                    )}
                  </button>
                  {isOpen && hasDetail && (
                    <div className="border-t border-border px-s3 py-s2">
                      <pre className="overflow-x-auto rounded-control bg-muted p-s2 font-mono text-base text-foreground">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <Pagination
            page={resource.pagination.page}
            pages={resource.pagination.pages}
            total={resource.pagination.total}
            limit={resource.pagination.limit}
            onPageChange={resource.goToPage}
            itemNoun="entries"
          />
        </>
      )}
    </div>
  );
}
