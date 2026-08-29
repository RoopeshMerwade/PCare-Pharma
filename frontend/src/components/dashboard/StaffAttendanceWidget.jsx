import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../hooks/useAuth';
import { duration, minutesSince, time } from '../../lib/format';
import Card, { CardBody } from '../../ui/Card';
import Button from '../../ui/Button';
import Skeleton, { SkeletonRegion } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { AttendanceBadge } from '../../domain/StatusBadge';
import { ClockIcon } from '../../ui/icons';

/* ═══════════════════════════════════════════════════════════════════════════
   The counter's own check-in (Module 26).

   `GET /attendance/today` is role-scoped server-side: a staff member gets
   their own row and nothing else, so this widget reads `attendance[0]` rather
   than searching a list it was never sent. The owner-side board — every staff
   member, with the administrative override — is StaffAttendanceCard.

   The elapsed figure ticks on an interval and is derived from a `now` held in
   state. Reading the clock during render would make the render impure and the
   number would then only be as fresh as the last unrelated re-render.
   ═══════════════════════════════════════════════════════════════════════════ */

const TICK_MS = 60_000; // a shift is measured in minutes; a per-second clock would be noise

export default function StaffAttendanceWidget() {
  const { user } = useAuth();
  const toast = useToast();
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await api.get('/attendance/today');
      const rows = res.data.attendance || [];
      setRow(rows.find((r) => r.user_id === user?.id) || null);
    } catch {
      // A dead attendance endpoint must not take the counter dashboard down
      // with it — the widget simply doesn't render. Billing is the job here.
      setRow(null);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const isPresent = row?.status === 'present';

  useEffect(() => {
    if (!isPresent) return undefined;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [isPresent]);

  const act = useCallback(async (kind) => {
    setBusy(true);
    try {
      // No user_id: the API reads "me" from the token. A widget that posted
      // its own idea of who is logged in would be one bug away from checking
      // in the wrong person.
      const res = await api.post(`/attendance/${kind}`, {});
      toast.success(res.message);
      setNow(Date.now());
      await load();
    } catch (err) {
      toast.error(err.message);
      await load();
    } finally {
      setBusy(false);
    }
  }, [toast, load]);

  // Shaped like the card below — icon, status over its detail line, and the
  // check-in button at the end of the row. A bare block would let the button
  // jump sideways the moment the row lands, under a thumb already moving.
  if (loading) {
    return (
      <SkeletonRegion label="Loading your check-in…">
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-s3">
            <div className="flex min-w-0 items-center gap-s3">
              <Skeleton className="h-9 w-9 shrink-0 rounded-pill" />
              <div className="flex min-w-0 flex-col gap-s1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
            </div>
            <Skeleton className="h-target w-40 rounded-pill" />
          </CardBody>
        </Card>
      </SkeletonRegion>
    );
  }

  // The board is a counter-staff roster, so the API refuses attendance for an
  // owner account. An owner who lands on /staff gets told that rather than a
  // button that always fails.
  if (!row) {
    if (user?.role === 'owner') {
      return (
        <Card>
          <CardBody>
            <p className="text-base font-bold text-foreground">Attendance is recorded for counter staff</p>
            <p className="mt-s1 text-base text-muted-foreground">
              The full board, with check-in on anyone&rsquo;s behalf, is on your dashboard.
            </p>
          </CardBody>
        </Card>
      );
    }
    return null;
  }

  const isOut = row.status === 'checked_out';
  const elapsed = isPresent ? minutesSince(row.check_in_time, now) : row.worked_minutes;

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-s3">
        <div className="flex min-w-0 items-center gap-s3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-accent/10 text-accent">
            <ClockIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-s2">
              <span className="text-base font-bold text-foreground">
                {isPresent && 'On the counter'}
                {isOut && 'Shift finished'}
                {!isPresent && !isOut && 'Not checked in yet'}
              </span>
              <AttendanceBadge status={row.status} />
            </div>
            <span className="block text-base text-muted-foreground">
              {isPresent && `Since ${time(row.check_in_time)}${elapsed != null ? ` · ${duration(elapsed)} so far` : ''}`}
              {isOut && `${time(row.check_in_time)} → ${time(row.check_out_time)}${elapsed != null ? ` · ${duration(elapsed)}` : ''}`}
              {!isPresent && !isOut && 'Let the owner know you have arrived.'}
            </span>
          </div>
        </div>

        {isPresent ? (
          <Button variant="secondary" loading={busy} onClick={() => act('check-out')}>
            Check out
          </Button>
        ) : (
          <Button variant={isOut ? 'secondary' : 'primary'} loading={busy} onClick={() => act('check-in')}>
            {/* Coming back after a break reopens today's record rather than
                opening a second one, so the label says "again" — it is not a
                fresh arrival and the board will still show the original time. */}
            {isOut ? 'Check in again' : "I've arrived — check in"}
          </Button>
        )}
      </CardBody>
    </Card>
  );
}
