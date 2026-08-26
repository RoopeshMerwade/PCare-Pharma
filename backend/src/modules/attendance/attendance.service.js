// ── Module 26: Staff Attendance
// ── Role: Service (business logic only — no HTTP knowledge)
//
// The whole permission model of this module is two sentences:
//   · anyone may record their own arrival and departure;
//   · only the owner may record someone else's.
// `resolveTarget` is the single place that decides it, so no endpoint can be
// added later that quietly forgets one half.

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { mapDbError } = require('../../utils/dbErrors');
const { logAudit } = require('../../utils/audit');
const { createNotification } = require('../notifications/notifications.service');

// Columns of today_staff_attendance. Named rather than `*` so a later column
// on public.users cannot silently start reaching the counter.
const BOARD_COLUMNS =
  'user_id, full_name, phone, role, avatar_url, is_active, ' +
  'attendance_date, attendance_id, check_in_time, check_out_time, status, notes';

const RECORD_COLUMNS =
  'id, user_id, attendance_date, check_in_time, check_out_time, status, notes, created_by, created_at, updated_at';

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

/**
 * Minutes on the counter. Derived on read, never stored — same rule as stock
 * and margins. Note this is a check-in board, not a payroll clock: a shift
 * that was reopened after a break counts the break, because the row keeps the
 * ORIGINAL arrival time (see checkIn).
 */
function workedMinutes(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60000) : null;
}

function summarise(rows) {
  const summary = { total: rows.length, present: 0, checked_out: 0, absent: 0 };
  rows.forEach((r) => { if (summary[r.status] !== undefined) summary[r.status] += 1; });
  return summary;
}

/** "9:15 am" in the pharmacy's own timezone — notification text, not data. */
function localTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('en-IN', {
    hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

// ────────────────────────────────────────────────
// READ
// ────────────────────────────────────────────────

/** Every active staff member with today's record — the owner's full board. */
async function getTodayBoard() {
  const { data, error } = await supabase
    .from('today_staff_attendance')
    .select(BOARD_COLUMNS)
    .order('full_name', { ascending: true });

  if (error) throw new AppError('Failed to fetch attendance.', 500, 'DB_ERROR');
  const rows = (data || []).map((r) => ({
    ...r,
    worked_minutes: workedMinutes(r.check_in_time, r.check_out_time),
  }));
  return { rows, summary: summarise(rows) };
}

/**
 * The board as this caller is entitled to see it.
 *
 * Staff get their own row and nothing else — the same scope RLS grants them
 * on the underlying table. Scoping here rather than in the component means
 * the restriction is in the PAYLOAD, not merely unrendered, which is the
 * standard criterion A9 asks for and the one the older modules still owe.
 */
async function getTodayAttendance(requestingUser) {
  const board = await getTodayBoard();
  if (requestingUser.role === 'owner') return board;

  const rows = board.rows.filter((r) => r.user_id === requestingUser.id);
  return { rows, summary: summarise(rows) };
}

/**
 * Paginated history, for a staff profile or an owner's roster review.
 * A staff member asking for someone else's history is refused rather than
 * silently rewritten to their own — a filter that is quietly ignored is
 * worse than one that says no.
 */
async function getStaffAttendanceHistory(
  { userId = null, dateFrom = null, dateTo = null, page = 1, limit = 50 } = {},
  requestingUser
) {
  const isOwner = requestingUser.role === 'owner';
  if (!isOwner && userId && userId !== requestingUser.id) {
    throw new AppError('You can only view your own attendance history.', 403, 'FORBIDDEN');
  }
  const targetId = isOwner ? userId : requestingUser.id;

  const offset = (page - 1) * limit;
  let q = supabase
    .from('staff_attendance')
    .select(`${RECORD_COLUMNS}, users:user_id (full_name, role)`, { count: 'exact' })
    .order('attendance_date', { ascending: false })
    .order('check_in_time', { ascending: false })
    .range(offset, offset + limit - 1);

  if (targetId) q = q.eq('user_id', targetId);
  if (dateFrom) q = q.gte('attendance_date', dateFrom);
  if (dateTo)   q = q.lte('attendance_date', dateTo);

  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch attendance history.', 500, 'DB_ERROR');

  const records = (data || []).map(({ users, ...row }) => ({
    ...row,
    staff_name: users?.full_name || null,
    worked_minutes: workedMinutes(row.check_in_time, row.check_out_time),
  }));

  return {
    records,
    pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
  };
}

// ────────────────────────────────────────────────
// WRITE
// ────────────────────────────────────────────────

/**
 * Who the action is for, and proof the caller may act on them.
 *
 * The role check is deliberately narrower than "an active user": the board is
 * a counter-staff roster, so a row for the owner would be written and then be
 * invisible on every screen that exists. Refusing it is the honest answer.
 */
async function resolveTarget(targetUserId, requestingUser) {
  const userId = targetUserId || requestingUser.id;

  if (userId !== requestingUser.id && requestingUser.role !== 'owner') {
    throw new AppError('Only the owner can record attendance for someone else.', 403, 'FORBIDDEN');
  }

  const { data: target, error } = await supabase
    .from('users')
    .select('id, full_name, role, is_active')
    .eq('id', userId)
    .single();

  if (error || !target) throw new AppError('Staff member not found.', 404, 'USER_NOT_FOUND');
  if (!target.is_active) {
    throw new AppError('That account is deactivated. Reactivate it before recording attendance.', 409, 'ACCOUNT_INACTIVE');
  }
  if (target.role !== 'staff') {
    throw new AppError('Attendance is recorded for counter staff only.', 422, 'NOT_STAFF');
  }
  return target;
}

/** Today's row for one staff member, or null — read through the view so the
 *  definition of "today" is the database's, not this process's clock. */
async function findTodayRow(userId) {
  const { data, error } = await supabase
    .from('today_staff_attendance')
    .select(BOARD_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new AppError("Failed to read today's attendance.", 500, 'DB_ERROR');
  return data;
}

async function readRecord(id) {
  const { data, error } = await supabase
    .from('staff_attendance').select(RECORD_COLUMNS).eq('id', id).single();
  if (error || !data) throw new AppError('Attendance record not found.', 404, 'ATTENDANCE_NOT_FOUND');
  return data;
}

/** The single owner account, or null if there somehow isn't one. */
async function getOwnerId() {
  const { data } = await supabase
    .from('users').select('id').eq('role', 'owner').eq('is_active', true).limit(1).maybeSingle();
  return data?.id || null;
}

/**
 * Audit entry + owner notification for one check-in or check-out.
 *
 * Both writers are fire-and-forget by design (see utils/audit.js and
 * notifications.service.js): a failed audit or notification must never undo
 * an arrival that actually happened.
 */
async function recordEvent(kind, { target, record, requestingUser, supersededCheckOut = null }) {
  const isSelf = target.id === requestingUser.id;
  const at = kind === 'in' ? record.check_in_time : record.check_out_time;
  const verb = kind === 'in' ? 'checked in' : 'checked out';

  await logAudit(requestingUser.id, kind === 'in' ? 'staff_check_in' : 'staff_check_out', {
    targetUserId: target.id,
    staffName: target.full_name,
    attendanceId: record.id,
    attendanceDate: record.attendance_date,
    at,
    onBehalf: !isSelf,
    // A reopened shift drops its previous checkout from the row; it is kept
    // here instead, so the append-only trail still has the full day.
    ...(supersededCheckOut ? { supersededCheckOut } : {}),
  });

  const ownerId = await getOwnerId();
  if (!ownerId) return;

  await createNotification({
    user_id: ownerId,
    type: kind === 'in' ? 'STAFF_CHECK_IN' : 'STAFF_CHECK_OUT',
    title: `${target.full_name} ${verb}`,
    message: isSelf
      ? `${target.full_name} ${verb} at ${localTime(at)}.`
      : `${requestingUser.full_name} recorded ${target.full_name} as ${verb} at ${localTime(at)}.`,
    metadata: {
      user_id: target.id,
      attendance_id: record.id,
      attendance_date: record.attendance_date,
      at,
      recorded_by: requestingUser.id,
      on_behalf: !isSelf,
    },
  });
}

/** Shapes a record the way both write endpoints return it. */
function present(record, target) {
  return {
    ...record,
    staff_name: target.full_name,
    worked_minutes: workedMinutes(record.check_in_time, record.check_out_time),
  };
}

async function checkIn({ userId = null, notes = null } = {}, requestingUser) {
  const target = await resolveTarget(userId, requestingUser);
  const existing = await findTodayRow(target.id);

  if (existing?.attendance_id && !existing.check_out_time) {
    throw new AppError(`${target.full_name} is already checked in today.`, 409, 'ALREADY_CHECKED_IN');
  }

  let record;
  let supersededCheckOut = null;

  if (existing?.attendance_id) {
    // Back at the counter after checking out. The table is one row per person
    // per day, so the row is REOPENED rather than duplicated: check_out_time
    // clears and the generated `status` follows it back to 'present'.
    //
    // check_in_time is deliberately NOT overwritten. The board's job is to say
    // when someone arrived; rewriting 09:15 to 14:00 because they took a lunch
    // break would make the one figure it displays wrong. The checkout being
    // superseded goes into the audit entry, so nothing is actually lost.
    supersededCheckOut = existing.check_out_time;
    const { data, error } = await supabase
      .from('staff_attendance')
      .update({ check_out_time: null, ...(notes !== null ? { notes } : {}) })
      .eq('id', existing.attendance_id)
      .select(RECORD_COLUMNS)
      .single();
    if (error) throw new AppError('Failed to record the check-in.', 500, 'DB_ERROR');
    record = data;
  } else {
    // attendance_date is left to the column default so the date comes from
    // pharmacy_today() — the same expression the view joins on. Setting it
    // from this process's clock is how the two would drift apart.
    const { data, error } = await supabase
      .from('staff_attendance')
      .insert({ user_id: target.id, notes, created_by: requestingUser.id })
      .select(RECORD_COLUMNS)
      .single();

    if (error) {
      // Two check-ins racing collide on the unique constraint. One of them
      // won; telling the loser they are already checked in is the truth.
      const mapped = mapDbError(error, {
        duplicateMessage: `${target.full_name} is already checked in today.`,
        duplicateCode: 'ALREADY_CHECKED_IN',
      });
      throw mapped || new AppError('Failed to record the check-in.', 500, 'DB_ERROR');
    }
    record = data;
  }

  await recordEvent('in', { target, record, requestingUser, supersededCheckOut });
  return present(record, target);
}

async function checkOut({ userId = null, notes = null } = {}, requestingUser) {
  const target = await resolveTarget(userId, requestingUser);
  const existing = await findTodayRow(target.id);

  if (!existing?.attendance_id) {
    throw new AppError(`${target.full_name} has not checked in today.`, 409, 'NOT_CHECKED_IN');
  }
  if (existing.check_out_time) {
    throw new AppError(`${target.full_name} has already checked out today.`, 409, 'ALREADY_CHECKED_OUT');
  }

  const { data, error } = await supabase
    .from('staff_attendance')
    .update({ check_out_time: new Date().toISOString(), ...(notes !== null ? { notes } : {}) })
    .eq('id', existing.attendance_id)
    .select(RECORD_COLUMNS)
    .single();

  if (error) throw new AppError('Failed to record the check-out.', 500, 'DB_ERROR');

  const record = data || await readRecord(existing.attendance_id);
  await recordEvent('out', { target, record, requestingUser });
  return present(record, target);
}

module.exports = {
  getTodayBoard,
  getTodayAttendance,
  getStaffAttendanceHistory,
  checkIn,
  checkOut,
  // exported for the dashboard's summary tile and for unit testing
  workedMinutes,
  summarise,
};
