// ── Module 14: Expiry Management
// ── Role: Controller

const svc = require('./expiry.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/postgrest');

const dashboard = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, await svc.getExpiryDashboard());
});

// Rows for one bucket, paged. The summary lives on /dashboard.
const batches = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: 30, maxLimit: 100 });
  return ApiResponse.success(res, await svc.getExpiryBatches({ urgency: req.query.urgency, page, limit }));
});

const byUrgency = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, await svc.getBatchesByUrgency(req.params.urgency));
});

const writeOff = asyncHandler(async (req, res) => {
  const result = await svc.writeOffBatch(req.params.batchId, req.user.id);
  return ApiResponse.success(res, result, 'Batch written off.');
});

const bulkWriteOff = asyncHandler(async (req, res) => {
  const result = await svc.bulkWriteOffExpired(req.user.id);
  return ApiResponse.success(
    res,
    result,
    `${result.written_off} expired batch${result.written_off !== 1 ? 'es' : ''} written off. Total: ₹${result.total_value.toFixed(2)}.`
  );
});

const report = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { report: await svc.getExpiryReport() });
});

module.exports = { dashboard, batches, byUrgency, writeOff, bulkWriteOff, report };
