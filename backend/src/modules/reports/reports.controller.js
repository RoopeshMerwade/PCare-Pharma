// ── Module 15: Reports
// ── Role: Controller

const svc = require('./reports.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const { buildSalesReportWorkbook, exportSalesFilename } = require('./reports.export');
const { logAudit } = require('../../utils/audit');

const sales = asyncHandler(async (req, res) => {
  const report = await svc.getSalesReport({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    groupBy: req.query.groupBy || 'day',
  });
  return ApiResponse.success(res, { report });
});

const exportSales = asyncHandler(async (req, res) => {
  const data = await svc.getSalesExportData({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  });

  const filename = exportSalesFilename(data.dateFrom, data.dateTo);

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  logAudit(req.user.id, 'sales_report_exported', {
    dateFrom: data.dateFrom,
    dateTo: data.dateTo,
    billCount: data.bills?.length || 0,
  }, { ip: req.ip, userAgent: req.get('user-agent') });

  const workbook = await buildSalesReportWorkbook(data);
  await workbook.xlsx.write(res);
  return res.end();
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

module.exports = { sales, exportSales, margins, purchases, inventory, top };
