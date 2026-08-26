// ── Module 15: Reports
// ── Role: Controller

const svc = require('./reports.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const sales = asyncHandler(async (req, res) => {
  const report = await svc.getSalesReport({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    groupBy: req.query.groupBy || 'day',
  });
  return ApiResponse.success(res, { report });
});

const margins = asyncHandler(async (req, res) => {
  const report = await svc.getMarginReport({
    categoryId: req.query.categoryId,
    limit: parseInt(req.query.limit) || 50,
  });
  return ApiResponse.success(res, { report });
});

const purchases = asyncHandler(async (req, res) => {
  const report = await svc.getPurchaseReport({
    supplierId: req.query.supplierId,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  });
  return ApiResponse.success(res, { report });
});

const inventory = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { report: await svc.getInventoryReport() });
});

const top = asyncHandler(async (req, res) => {
  const medicines = await svc.getTopMedicines({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    limit: parseInt(req.query.limit) || 10,
  });
  return ApiResponse.success(res, { medicines });
});

module.exports = { sales, margins, purchases, inventory, top };
