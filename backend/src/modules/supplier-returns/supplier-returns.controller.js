// ── Module 13: Supplier Returns
// ── Role: Controller

const svc = require('./supplier-returns.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const result = await svc.listSupplierReturns({
    supplierId: req.query.supplierId,
    status: req.query.status,
    page: parseInt(req.query.page) || 1,
    limit: parseInt(req.query.limit) || 30,
  });
  return ApiResponse.success(res, result);
});

const getOne = asyncHandler(async (req, res) => {
  const ret = await svc.getSupplierReturnById(req.params.id);
  return ApiResponse.success(res, { return: ret });
});

const create = asyncHandler(async (req, res) => {
  const ret = await svc.createSupplierReturn(req.body, req.user.id);
  return ApiResponse.created(res, { return: ret }, `${ret.return_number} drafted. Review and send.`);
});

const send = asyncHandler(async (req, res) => {
  const ret = await svc.sendSupplierReturn(req.params.id, req.user.id);
  return ApiResponse.success(res, { return: ret }, 'Return sent. Stock decremented. Debit note raised.');
});

const acknowledge = asyncHandler(async (req, res) => {
  const ret = await svc.acknowledgeSupplierReturn(req.params.id, req.user.id);
  return ApiResponse.success(res, { return: ret }, 'Return acknowledged by supplier.');
});

module.exports = { list, getOne, create, send, acknowledge };
