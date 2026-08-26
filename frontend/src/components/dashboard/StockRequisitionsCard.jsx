import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { date, plural } from '../../lib/format';
import { Button, Card, CardHeader, CardTitle, CardBody } from '../../ui';
import { ClipboardIcon, DownloadIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { RequisitionUrgencyBadge } from '../../domain/StatusBadge';
import { useToast } from '../../ui/Toast';

/* ═══════════════════════════════════════════════════════════════════════════
   What the counter has asked to be ordered.

   Renders NOTHING when the queue is empty — unlike the attendance board above
   it, which always shows because "no staff accounts yet" is worth saying. An
   empty request queue is not news.

   The row subcomponent sits at MODULE SCOPE. A component defined inside this
   one gets a new identity every render (see ui/Field.jsx and the lint rule).
   ═══════════════════════════════════════════════════════════════════════════ */

function RequisitionRow({ row, busy, onApprove, onDownload, onOpen }) {
  return (
    <li className="flex flex-wrap items-center gap-s3 py-s3">
      <span className="min-w-[9rem] flex-1">
        <span className="flex flex-wrap items-center gap-s2">
          <button
            type="button"
            onClick={onOpen}
            className="text-base font-bold text-foreground underline-offset-2 hover:underline"
          >
            {row.requisition_number}
          </button>
          <RequisitionUrgencyBadge urgency={row.urgency} variant="solid" />
        </span>
        <span className="block text-base text-muted-foreground">
          {row.created_by_name} · {plural(row.item_count, 'line')} · {date(row.created_at)}
        </span>
      </span>

      <Money value={row.estimated_total} whole />

      {row.status === 'pending' ? (
        <Button
          size="compact"
          variant="primary"
          loading={busy === `approve:${row.id}`}
          onClick={onApprove}
        >
          Approve
        </Button>
      ) : (
        <span className="flex gap-s1">
          <Button
            size="compact"
            variant="secondary"
            loading={busy === `xlsx:${row.id}`}
            onClick={() => onDownload('xlsx')}
          >
            <DownloadIcon className="h-4 w-4" />
            Excel
          </Button>
          <Button
            size="compact"
            variant="ghost"
            loading={busy === `pdf:${row.id}`}
            onClick={() => onDownload('pdf')}
          >
            PDF
          </Button>
        </span>
      )}
    </li>
  );
}

/* `initialRows` deliberately has NO default value — a `= []` default mints a
   fresh array on every parent render, which the effect below would see as a
   changed dependency, reset state from, and re-render on, forever. Passing the
   payload's own reference straight through keeps the dependency stable. */
export default function StockRequisitionsCard({ initialRows, onChanged }) {
  const [rows, setRows] = useState(() => initialRows || []);
  const [busy, setBusy] = useState(null);
  const toast = useToast();
  const navigate = useNavigate();

  // The dashboard payload ships the queue with it, so this card paints on first
  // render with no round trip. A later dashboard refetch has to land here too,
  // or the queue silently freezes at whatever it held when it mounted.
  useEffect(() => {
    if (initialRows) setRows(initialRows);
  }, [initialRows]);

  const urgentCount = useMemo(
    () => rows.filter((r) => r.urgency === 'urgent').length,
    [rows]
  );

  const approve = useCallback(async (row) => {
    setBusy(`approve:${row.id}`);
    try {
      const res = await api.patch(`/stock-requisitions/${row.id}/approve`);
      // Not optimistic: the row is replaced with the record the server
      // returned, so its status and reviewer are the authoritative ones.
      setRows((current) => current.map((r) => (r.id === row.id ? { ...r, ...res.data.requisition } : r)));
      toast.success(res.message);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [toast, onChanged]);

  const download = useCallback(async (row, format) => {
    setBusy(`${format}:${row.id}`);
    try {
      const name = await api.download(
        `/stock-requisitions/${row.id}/export/${format}`,
        `${row.requisition_number}.${format}`
      );
      toast.success(`${name} downloaded.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [toast]);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader
        action={(
          <Button variant="ghost" size="compact" onClick={() => navigate('/stock-requisitions')}>
            See all
          </Button>
        )}
      >
        <CardTitle>
          <span className="flex flex-wrap items-center gap-s2">
            <span className="flex h-6 w-6 items-center justify-center rounded-pill bg-warning-wash text-warning-ink">
              <ClipboardIcon className="h-3.5 w-3.5" />
            </span>
            Stock requests
            <span className="text-base font-normal text-muted-foreground">
              {plural(rows.length, 'request')} waiting
              {urgentCount > 0 && ` · ${urgentCount} urgent`}
            </span>
          </span>
        </CardTitle>
      </CardHeader>

      <CardBody>
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <RequisitionRow
              key={row.id}
              row={row}
              busy={busy}
              onApprove={() => approve(row)}
              onDownload={(format) => download(row, format)}
              onOpen={() => navigate('/stock-requisitions')}
            />
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
