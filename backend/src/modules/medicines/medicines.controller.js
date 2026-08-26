// ── Module: Medicines
// ── Role: Controller

const svc = require('./medicines.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const { categoryId, stock, search, page, limit, includeInactive } = req.query;
  const isOwner = req.user.role === 'owner';

  const result = await svc.listMedicines({
    categoryId,
    stockFilter: stock,
    search,
    page: parseInt(page) || 1,
    limit: Math.min(parseInt(limit) || 50, 100), // max 100 per page
    includeInactive: isOwner && includeInactive === 'true'
  });

  return ApiResponse.success(res, result);
});

const search = asyncHandler(async (req, res) => {
  const medicines = await svc.searchMedicines(req.query.q, { activeOnly: true });
  return ApiResponse.success(res, { medicines });
});

const getOne = asyncHandler(async (req, res) => {
  const medicine = await svc.getMedicineById(req.params.id);
  return ApiResponse.success(res, { medicine });
});

const create = asyncHandler(async (req, res) => {
  const medicine = await svc.createMedicine(req.body, req.user.id);
  return ApiResponse.created(res, { medicine }, `"${medicine.name}" added to catalog.`);
});

const update = asyncHandler(async (req, res) => {
  const medicine = await svc.updateMedicine(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, { medicine }, 'Medicine updated.');
});

const deactivate = asyncHandler(async (req, res) => {
  const medicine = await svc.setActiveStatus(req.params.id, false, req.user.id);
  return ApiResponse.success(res, { medicine }, 'Medicine deactivated.');
});

const reactivate = asyncHandler(async (req, res) => {
  const medicine = await svc.setActiveStatus(req.params.id, true, req.user.id);
  return ApiResponse.success(res, { medicine }, 'Medicine reactivated.');
});

const lowStockAlerts = asyncHandler(async (req, res) => {
  const alerts = await svc.getLowStockAlerts();
  return ApiResponse.success(res, { alerts });
});

const nearExpiryAlerts = asyncHandler(async (req, res) => {
  const alerts = await svc.getNearExpiryAlerts();
  return ApiResponse.success(res, { alerts });
});

const getAlternatives = asyncHandler(async (req, res) => {
  const result = await svc.getAlternatives(req.params.id);
  return ApiResponse.success(res, result);
});

module.exports = {
  list, search, getOne, create, update, deactivate, reactivate,
  lowStockAlerts, nearExpiryAlerts, getAlternatives
};
