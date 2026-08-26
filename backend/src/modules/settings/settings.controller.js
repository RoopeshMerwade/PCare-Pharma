// ── Module 19: Settings
// ── Role: Controller

const svc = require('./settings.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const getAll = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, await svc.getAllSettings());
});

const update = asyncHandler(async (req, res) => {
  const result = await svc.updateSettings(req.body, req.user.id);
  return ApiResponse.success(res, result, 'Settings updated.');
});

module.exports = { getAll, update };
