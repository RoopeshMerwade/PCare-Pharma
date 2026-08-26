// ── Module: Medicine Categories
// ── Role: Controller

const svc = require('./categories.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const includeInactive = req.user.role === 'owner' && req.query.includeInactive === 'true';
  const categories = await svc.listCategories({ includeInactive });
  return ApiResponse.success(res, { categories, total: categories.length });
});

const getOne = asyncHandler(async (req, res) => {
  const category = await svc.getCategoryById(req.params.id);
  return ApiResponse.success(res, { category });
});

const create = asyncHandler(async (req, res) => {
  const { name, description, color } = req.body;
  const category = await svc.createCategory({ name, description, color }, req.user.id);
  return ApiResponse.created(res, { category }, `Category "${category.name}" created.`);
});

const update = asyncHandler(async (req, res) => {
  const { name, description, color } = req.body;
  const category = await svc.updateCategory(req.params.id, { name, description, color }, req.user.id);
  return ApiResponse.success(res, { category }, 'Category updated.');
});

const reorder = asyncHandler(async (req, res) => {
  const categories = await svc.reorderCategories(req.body.orderedIds, req.user.id);
  return ApiResponse.success(res, { categories }, 'Categories reordered.');
});

const deactivate = asyncHandler(async (req, res) => {
  const category = await svc.deactivateCategory(req.params.id, req.user.id);
  return ApiResponse.success(res, { category }, 'Category deactivated.');
});

const reactivate = asyncHandler(async (req, res) => {
  const category = await svc.reactivateCategory(req.params.id, req.user.id);
  return ApiResponse.success(res, { category }, 'Category reactivated.');
});

module.exports = { list, getOne, create, update, reorder, deactivate, reactivate };
