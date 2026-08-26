// ── Module 20: Audit Logs
// ── Role: Controller

const svc = require('./audit-logs.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const { action, userId, dateFrom, dateTo, page, limit } = req.query;
  const result = await svc.listAuditLogs({
    action,
    userId,
    dateFrom,
    dateTo,
    page: parseInt(page) || 1,
    limit: Math.min(parseInt(limit) || 50, 100),
  });
  return ApiResponse.success(res, result);
});

module.exports = { list };
