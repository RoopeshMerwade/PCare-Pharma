// ── Modules 17+18: Dashboard
// ── Role: Controller

const svc = require('./dashboard.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const ownerDash = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { dashboard: await svc.getOwnerDashboard(req.user.id) });
});

const staffDash = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { dashboard: await svc.getStaffDashboard(req.user.id) });
});

module.exports = { ownerDash, staffDash };
