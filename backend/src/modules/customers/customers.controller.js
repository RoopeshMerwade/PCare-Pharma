// ── Module 11: Customers
// ── Role: Controller

const svc = require('./customers.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const { search, page, limit, includeInactive } = req.query;
  const result = await svc.listCustomers({
    search,
    page: parseInt(page) || 1,
    limit: Math.min(parseInt(limit) || 50, 100),
    includeInactive: req.user.role === 'owner' && includeInactive === 'true',
  });
  return ApiResponse.success(res, result);
});

const search = asyncHandler(async (req, res) => {
  const result = await svc.listCustomers({ search: req.query.q, limit: 10 });
  return ApiResponse.success(res, { customers: result.customers });
});

const getOne = asyncHandler(async (req, res) => {
  const customer = await svc.getCustomerById(req.params.id);
  return ApiResponse.success(res, { customer });
});

const history = asyncHandler(async (req, res) => {
  const result = await svc.getCustomerPurchaseHistory(req.params.id, {
    page: parseInt(req.query.page) || 1,
    limit: parseInt(req.query.limit) || 20,
  });
  return ApiResponse.success(res, result);
});

const create = asyncHandler(async (req, res) => {
  const customer = await svc.createCustomer(req.body, req.user.id);
  return ApiResponse.created(res, { customer }, `${customer.name} registered.`);
});

const update = asyncHandler(async (req, res) => {
  const customer = await svc.updateCustomer(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, { customer }, 'Customer updated.');
});

const deactivate = asyncHandler(async (req, res) => {
  const customer = await svc.setCustomerStatus(req.params.id, false, req.user.id);
  return ApiResponse.success(res, { customer }, 'Customer deactivated.');
});

const reactivate = asyncHandler(async (req, res) => {
  const customer = await svc.setCustomerStatus(req.params.id, true, req.user.id);
  return ApiResponse.success(res, { customer }, 'Customer reactivated.');
});

module.exports = { list, search, getOne, history, create, update, deactivate, reactivate };
