// ── Module 06: Suppliers
// ── Role: Controller

const svc = require('./suppliers.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const includeInactive = req.user.role === 'owner' && req.query.includeInactive === 'true';
  const suppliers = await svc.listSuppliers({ includeInactive });
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

module.exports = { list, getOne, create, update, deactivate, reactivate };
