// ── Module 30: Stock Requisitions
// ── Role: Controller (thin — validation in middleware, logic in service)

const service = require('./stock-requisitions.service');
const { exportFilename, buildWorkbook, buildPdf } = require('./stock-requisitions.export');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');
const { logAudit } = require('../../utils/audit');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const list = asyncHandler(async (req, res) => {
  const { requisitions, pagination } = await service.listRequisitions({
    status: req.query.status || null,
    urgency: req.query.urgency || null,
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
  }, req.user);

  return ApiResponse.success(res, { requisitions, pagination });
});

const getOne = asyncHandler(async (req, res) => {
  const requisition = await service.getRequisitionById(req.params.id, req.user);
  return ApiResponse.success(res, { requisition });
});

const vendorPrices = asyncHandler(async (req, res) => {
  // The validator's customSanitizer has already split the comma list and
  // proved every element is a UUID.
  const vendors = await service.getVendorPrices(req.query.medicine_ids, req.user);
  return ApiResponse.success(res, { vendors });
});

const lowStock = asyncHandler(async (req, res) => {
  const medicines = await service.getLowStockCandidates({
    limit: parseInt(req.query.limit, 10) || 100,
  });
  return ApiResponse.success(res, { medicines });
});

const create = asyncHandler(async (req, res) => {
  const requisition = await service.createRequisition({
    urgency: req.body.urgency || 'normal',
    note: req.body.note || null,
    items: req.body.items,
  }, req.user);

  return ApiResponse.created(
    res, { requisition },
    `${requisition.requisition_number} sent to the owner.`
  );
});

const approve = asyncHandler(async (req, res) => {
  const requisition = await service.approveRequisition(req.params.id, req.user);
  return ApiResponse.success(
    res, { requisition },
    `${requisition.requisition_number} approved. Download it to place the order.`
  );
});

const reject = asyncHandler(async (req, res) => {
  const requisition = await service.rejectRequisition(
    req.params.id, { rejection_note: req.body.rejection_note }, req.user
  );
  return ApiResponse.success(res, { requisition }, `${requisition.requisition_number} rejected.`);
});

const cancel = asyncHandler(async (req, res) => {
  const requisition = await service.cancelRequisition(req.params.id, req.user);
  return ApiResponse.success(res, { requisition }, `${requisition.requisition_number} withdrawn.`);
});

/**
 * The one endpoint in this API whose success path is not JSON.
 *
 * Everything that can fail happens in getRequisitionForExport, BEFORE a single
 * header is set: the 404, the ownership check and the 409 for an unapproved
 * request. If any of them throws, errorHandler still owns the response and the
 * client gets a readable JSON error.
 *
 * Past the setHeader below the response is a file, and nothing may query
 * anything — which is why the renderer imports no Supabase client at all. An
 * error after the first byte cannot become a 500; it becomes a truncated
 * download that the spreadsheet blames on the user.
 */
const exportOne = asyncHandler(async (req, res) => {
  const requisition = await service.getRequisitionForExport(req.params.id, req.user);
  const { format } = req.params;
  const filename = exportFilename(requisition, format);

  // Both forms: the plain one for older clients, the RFC 5987 one so a name
  // with a non-ASCII character survives. app.js exposes this header through
  // CORS — without that it is invisible to fetch() on a cross-origin API.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('Cache-Control', 'no-store');

  // Not awaited: this is the moment a priced vendor list leaves the system and
  // it is worth recording, but a slow audit insert must not hold up a download.
  logAudit(req.user.id, 'stock_requisition_exported', {
    requisitionId: requisition.id,
    requisitionNumber: requisition.requisition_number,
    format,
  }, { ip: req.ip, userAgent: req.get('user-agent') });

  if (format === 'xlsx') {
    res.setHeader('Content-Type', XLSX_MIME);
    const workbook = await buildWorkbook(requisition);
    await workbook.xlsx.write(res);
    return res.end();
  }

  res.setHeader('Content-Type', 'application/pdf');
  const doc = buildPdf(requisition);
  doc.pipe(res);
  return doc.end();
});

module.exports = { list, getOne, vendorPrices, lowStock, create, approve, reject, cancel, exportOne };
