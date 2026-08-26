// ── Modules 09+10: Billing — controller (HTTP only).
// Extracts request data, invokes the service, shapes the response.

const svc = require('./billing.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/postgrest');

const list = asyncHandler(async (req, res) => {
  const { search, paymentMode, dateFrom, dateTo } = req.query;
  const { page, limit } = parsePagination(req.query, { defaultLimit: 30 });
  const isOwner = req.user.role === 'owner';
  const r = await svc.listBills({
    search, paymentMode, dateFrom, dateTo,
    createdBy: isOwner ? undefined : req.user.id, // staff see only their own bills
    page, limit,
  });
  return ApiResponse.success(res, r);
});

// req.user comes from `authenticate` (verified JWT), never from the request
// body or query — the service refuses to run without it.
const getOne = asyncHandler(async (req, res) =>
  ApiResponse.success(res, { bill: await svc.getBillById(req.params.id, req.user) }));

const create = asyncHandler(async (req, res) => {
  const bill = await svc.createBill(req.body, req.user.id);
  return ApiResponse.created(res, { bill }, `${bill.bill_number} created. Total: ₹${bill.total}`);
});

const totals = asyncHandler(async (req, res) => {
  const summary = await svc.getSalesTotals(req.query.dateFrom, req.query.dateTo);
  return ApiResponse.success(res, { summary });
});

module.exports = { list, getOne, create, totals };
