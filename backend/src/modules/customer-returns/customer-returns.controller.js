// ── Module 12: Customer Returns
// ── Role: Controller

const svc = require('./customer-returns.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const isOwner = req.user.role === 'owner';
  const result = await svc.listReturns({
    createdBy: isOwner ? undefined : req.user.id,
    status: req.query.status,
    page: parseInt(req.query.page) || 1,
    limit: parseInt(req.query.limit) || 30,
  });
  return ApiResponse.success(res, result);
});

// req.user is server-derived (verified JWT); the service refuses to run without it.
const getOne = asyncHandler(async (req, res) => {
  const ret = await svc.getReturnById(req.params.id, req.user);
  return ApiResponse.success(res, { return: ret });
});

const create = asyncHandler(async (req, res) => {
  const ret = await svc.createReturn(req.body, req.user.id);
  return ApiResponse.created(res, { return: ret }, `${ret.return_number} created. Awaiting owner approval.`);
});

const approve = asyncHandler(async (req, res) => {
  const ret = await svc.approveReturn(req.params.id, req.user.id);
  return ApiResponse.success(res, { return: ret }, `Return approved. Refund: ₹${ret.refund_amount} via ${ret.refund_mode}.`);
});

const reject = asyncHandler(async (req, res) => {
  const ret = await svc.rejectReturn(req.params.id, req.body.rejection_note, req.user.id);
  return ApiResponse.success(res, { return: ret }, 'Return rejected.');
});

module.exports = { list, getOne, create, approve, reject };
