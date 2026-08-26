import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { count, duration, initials, plural, time } from '../../lib/format';
import Card, { CardBody } from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import { useToast } from '../../ui/Toast';
import { AttendanceBadge } from '../../domain/StatusBadge';
import { UsersIcon } from '../../ui/icons';

/* ═══════════════════════════════════════════════════════════════════════════
   Staff attendance — today. The owner's board (Module 26).

   Three things worth knowing before changing this:

   1. A staff member who has not arrived has NO ROW in staff_attendance. The
      `today_staff_attendance` view left-joins them back in as 'absent', which
      is why the board can show the people it most needs to show. Never filter
      this list down to rows the attendance table actually holds.

   2. The buttons are not optimistic. They spin (Button's own `loading` state)
      until the server answers, then the returned record is merged in. A check-in
      can legitimately fail — already checked in, the account was just
      deactivated, someone else got there first — and painting a green "Present"
      that then rolls back is worse at a counter than a 200ms spinner.

   3. There is no "warning" button variant and check-out does not need one.
      Leaving at the end of a shift is routine, not destructive and not blocked,
      so it takes `secondary`. `destructive` is the loss-and-failure ramp.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Derived from rows on every render, never held in state beside them.
 *
 *  The dashboard payload carries its own `summary` and the API returns one
 *  too, but both are just a count of these same rows — so keeping a second
 *  copy in state would only create something that can disagree with the list
 *  it sits above after a check-in. Same rule the backend applies to stock. */
function summarise(rows) {
  const s = { total: rows.length, present: 0, checked_out: 0, absent: 0 };
  rows.forEach((r) => { if (s[r.status] !== undefined) s[r.status] += 1; });
  return s;
}

/** Folds a check-in/check-out response back onto the row it came from. */
function mergeRecord(rows, record) {
  return rows.map((r) => (r.user_id === record.user_id
    ? {
      ...r,
      attendance_id:  record.id,
      check_in_time:  record.check_in_time,
      check_out_time: record.check_out_time,
      status:         record.status,
      notes:          record.notes,
      worked_minutes: record.worked_minutes,
    }
    : r));
}

/* Module scope, not inside the card. A component defined in a component body
   gets a new identity every render — see ui/Field.jsx and the lint rule. */
function AttendanceRow({ row, busy, onCheckIn, onCheckOut }) {
  const isPresent = row.status === 'present';
  const isOut = row.status === 'checked_out';

  return (
    <li className="flex min-h-target flex-wrap items-center gap-s3 px-s4 py-s3 transition-colors hover:bg-muted/40">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-accent/10 text-base font-bold text-accent"
      >
        {initials(row.full_name)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-bold text-foreground">{row.full_name}</span>
        {/* The phone number, not the role — every row on this board is staff by
            definition, and a column that says the same word all the way down
            is noise where a number you can actually ring is not. */}
        <span className="block truncate text-base text-muted-foreground">
          {row.phone || 'No phone on file'}
        </span>
      </span>

      {/* "9:15 am → 6:40 pm", or "→ —" while the shift is still open. §5: the
          unit is always stated, so the arrow carries the meaning rather than
          two bare numbers side by side. */}
      <span className="tabular shrink-0 whitespace-nowrap text-base text-muted-foreground">
        {row.check_in_time ? (
          <>
            {time(row.check_in_time)} <span aria-hidden="true">→</span> {time(row.check_out_time)}
            {isOut && row.worked_minutes != null && (
              <span className="ml-s2 text-base text-muted-foreground">({duration(row.worked_minutes)})</span>
            )}
          </>
        ) : (
          <span>Not recorded</span>
        )}
      </span>

      <AttendanceBadge status={row.status} />

      <span className="shrink-0">
        {isPresent ? (
          <Button
            variant="secondary"
            size="compact"
            loading={busy}
            onClick={() => onCheckOut(row)}
          >
            Check out
          </Button>
        ) : (
          <Button
            variant={isOut ? 'secondary' : 'primary'}
            size="compact"
            loading={busy}
            onClick={() => onCheckIn(row)}
          >
            {/* Back after a break reopens today's row rather than starting a
                second one — so the label says so instead of pretending this is
                a fresh arrival. */}
            {isOut ? 'Check in again' : 'Check in'}
          </Button>
        )}
      </span>
    </li>
  );
}

/* `initialRows` deliberately has NO default value. A `= []` default mints a
   fresh array on every parent render, which the effect below would then see as
   a changed dependency, reset state from, and re-render on — forever. Passing
   the payload's own reference straight through (undefined and all) keeps the
   dependency stable in both cases. */
export default function StaffAttendanceCard({ initialRows }) {
  const toast = useToast();
  const [rows, setRows] = useState(() => initialRows || []);
  const [busyId, setBusyId] = useState(null);

  const summary = useMemo(() => summarise(rows), [rows]);

  // The dashboard payload ships today's board with it, so this card paints on
  // first render with no round trip of its own. A later dashboard refetch
  // (retry, remount) has to land here too, or the board silently freezes at
  // whatever it held when it mounted.
  useEffect(() => {
    if (initialRows) setRows(initialRows);
  }, [initialRows]);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/attendance/today');
      setRows(res.data.attendance || []);
    } catch {
      // The row merge below already applied the authoritative record from the
      // write itself; a failed background refresh means the board may be one
      // colleague's action out of date, which is not worth an error toast on
      // top of the success one the user just read.
    }
  }, []);

  const act = useCallback(async (row, kind) => {
    setBusyId(row.user_id);
    try {
      const res = await api.post(`/attendance/${kind}`, { user_id: row.user_id });
      const record = res.data.attendance;
      setRows((current) => mergeRecord(current, record));
      toast.success(res.message);
      refresh();
    } catch (err) {
      // 409s here are readable sentences from the service ("Ravi is already
      // checked in today.") — surface them as-is rather than a generic failure.
      toast.error(err.message);
      refresh();
    } finally {
      setBusyId(null);
    }
  }, [toast, refresh]);

  const checkIn  = useCallback((row) => act(row, 'check-in'), [act]);
  const checkOut = useCallback((row) => act(row, 'check-out'), [act]);

  return (
    <section aria-labelledby="staff-attendance">
      <div className="mb-s2 flex items-center justify-between gap-s3">
        <h2 id="staff-attendance" className="text-sm font-bold text-foreground">Staff attendance — today</h2>
        {summary.total > 0 && (
          <span className="text-base text-muted-foreground">
            {count(summary.present)} of {plural(summary.total, 'person', 'people')} on the counter
          </span>
        )}
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <CardBody>
            <p className="text-base font-bold text-foreground">No staff accounts yet</p>
            <p className="mt-s1 text-base text-muted-foreground">
              Add a staff member under Staff and they will appear here to check in and out.
            </p>
          </CardBody>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-s2 border-b border-border px-s4 py-s3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-accent/10 text-accent">
                <UsersIcon className="h-4 w-4" />
              </span>
              {/* Counts, not a colour key: A4 — every one of these carries its
                  own word, so the board is readable with the hues stripped out. */}
              <Badge tone="ok">{count(summary.present)} present</Badge>
              <Badge tone="info">{count(summary.checked_out)} checked out</Badge>
              <Badge tone="neutral">{count(summary.absent)} not in yet</Badge>
            </div>

            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <AttendanceRow
                  key={row.user_id}
                  row={row}
                  busy={busyId === row.user_id}
                  onCheckIn={checkIn}
                  onCheckOut={checkOut}
                />
              ))}
            </ul>
          </>
        )}
      </Card>
    </section>
  );
}
