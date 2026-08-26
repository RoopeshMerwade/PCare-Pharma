// ── Modules 07+08: Purchases & Purchase Items
// ── Role: Controller

const svc = require('./purchases.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const result = await svc.listPurchases({
    supplierId: req.query.supplierId,
    status: req.query.status,
    page: parseInt(req.query.page) || 1,
    limit: parseInt(req.query.limit) || 30,
  });
  return ApiResponse.success(res, result);
});

const getOne = asyncHandler(async (req, res) => {
  const purchase = await svc.getPurchaseById(req.params.id);
  return ApiResponse.success(res, { purchase });
});

const create = asyncHandler(async (req, res) => {
  const purchase = await svc.createPurchase(req.body, req.user.id);
  return ApiResponse.created(res, { purchase }, `${purchase.purchase_number} created.`);
});

const update = asyncHandler(async (req, res) => {
  const purchase = await svc.updatePurchase(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, { purchase }, 'Updated.');
});

const send = asyncHandler(async (req, res) => {
  const purchase = await svc.sendPurchase(req.params.id, req.user.id);
  return ApiResponse.success(res, { purchase }, 'Order sent to supplier.');
});

const cancel = asyncHandler(async (req, res) => {
  const purchase = await svc.cancelPurchase(req.params.id, req.user.id);
  return ApiResponse.success(res, { purchase }, 'Order cancelled.');
});

const receive = asyncHandler(async (req, res) => {
  const purchase = await svc.receivePurchase(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, { purchase }, 'Goods received. Stock updated.');
});

const addItem = asyncHandler(async (req, res) => {
  const item = await svc.addItem(req.params.id, req.body, req.user.id);
  return ApiResponse.created(res, { item }, 'Item added.');
});

const removeItem = asyncHandler(async (req, res) => {
  await svc.removeItem(req.params.id, req.params.itemId, req.user.id);
  return ApiResponse.success(res, null, 'Item removed.');
});

module.exports = { list, getOne, create, update, send, cancel, receive, addItem, removeItem };
