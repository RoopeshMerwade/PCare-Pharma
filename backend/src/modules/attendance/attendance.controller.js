// ── Module 26: Staff Attendance
// ── Role: Controller (thin — validation in middleware, logic in service)

const attendanceService = require('./attendance.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const today = asyncHandler(async (req, res) => {
  const { rows, summary } = await attendanceService.getTodayAttendance(req.user);
  return ApiResponse.success(res, { attendance: rows, summary });
});

const history = asyncHandler(async (req, res) => {
  const { records, pagination } = await attendanceService.getStaffAttendanceHistory({
    userId:   req.query.userId,
    dateFrom: req.query.dateFrom,
    dateTo:   req.query.dateTo,
    page:     parseInt(req.query.page, 10) || 1,
    limit:    parseInt(req.query.limit, 10) || 50,
  }, req.user);
  return ApiResponse.success(res, { records, pagination });
});

// §5: the confirmation echoes the button's own words. An owner recording it
// for someone else needs to see WHO — a bare "Checked in." after clicking the
// wrong row is a mistake nobody notices.
const checkIn = asyncHandler(async (req, res) => {
  const attendance = await attendanceService.checkIn(
    { userId: req.body.user_id, notes: req.body.notes }, req.user
  );
  const self = attendance.user_id === req.user.id;
  return ApiResponse.success(res, { attendance }, self ? 'Checked in.' : `Checked in ${attendance.staff_name}.`);
});

const checkOut = asyncHandler(async (req, res) => {
  const attendance = await attendanceService.checkOut(
    { userId: req.body.user_id, notes: req.body.notes }, req.user
  );
  const self = attendance.user_id === req.user.id;
  return ApiResponse.success(res, { attendance }, self ? 'Checked out.' : `Checked out ${attendance.staff_name}.`);
});

module.exports = { today, history, checkIn, checkOut };
