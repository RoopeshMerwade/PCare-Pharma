// ── Module 06: Suppliers
// ── Role: Controller

const svc = require('./suppliers.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/postgrest');

const list = asyncHandler(async (req, res) => {
  const includeInactive = req.user.role === 'owner' && req.query.includeInactive === 'true';
  const { page, limit } = parsePagination(req.query, { defaultLimit: 30, maxLimit: 100 });
  const result = await svc.listSuppliers({ search: req.query.search, includeInactive, page, limit });
  return ApiResponse.success(res, result);
});

// Dropdown fodder. Same `suppliers` key as the list endpoint, so each caller
// changes by one word and nothing downstream of `res.data.suppliers` moves.
const options = asyncHandler(async (req, res) => {
  const suppliers = await svc.listSupplierOptions();
  return ApiResponse.success(res, { suppliers });
});

const getOne = asyncHandler(async (req, res) => {
  const supplier = await svc.getSupplierById(req.params.id);
  return ApiResponse.success(res, { supplier });
});

const create = asyncHandler(async (req, res) => {
  const supplier = await svc.createSupplier(req.body, req.user.id);
  return ApiResponse.created(res, { supplier }, `Supplier "${supplier.name}" added.`);
});

const update = asyncHandler(async (req, res) => {
  const supplier = await svc.updateSupplier(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, { supplier }, 'Supplier updated.');
});

const deactivate = asyncHandler(async (req, res) => {
  const supplier = await svc.setSupplierStatus(req.params.id, false, req.user.id);
  return ApiResponse.success(res, { supplier }, 'Supplier deactivated.');
});

const reactivate = asyncHandler(async (req, res) => {
  const supplier = await svc.setSupplierStatus(req.params.id, true, req.user.id);
  return ApiResponse.success(res, { supplier }, 'Supplier reactivated.');
});

module.exports = { list, options, getOne, create, update, deactivate, reactivate };
