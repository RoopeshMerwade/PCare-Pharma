// ── Module: User Management
// ── Role: Controller (thin — validation in middleware, logic in service)

const usersService = require('./users.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const users = await usersService.listUsers();
  return ApiResponse.success(res, { users });
});

const getOne = asyncHandler(async (req, res) => {
  const user = await usersService.getUserById(req.params.id);
  return ApiResponse.success(res, { user });
});

const getMe = asyncHandler(async (req, res) => {
  const user = await usersService.getUserById(req.user.id);
  return ApiResponse.success(res, { user });
});

const create = asyncHandler(async (req, res) => {
  const { full_name, email, phone } = req.body;
  const user = await usersService.createUser({ full_name, email, phone }, req.user.id);
  return ApiResponse.created(res, { user }, 'Staff account created. Password setup email sent.');
});

const update = asyncHandler(async (req, res) => {
  const user = await usersService.updateUser(req.params.id, req.body, req.user);
  return ApiResponse.success(res, { user }, 'Profile updated.');
});

const activate = asyncHandler(async (req, res) => {
  const user = await usersService.setActiveStatus(req.params.id, true, req.user);
  return ApiResponse.success(res, { user }, 'Account activated.');
});

const deactivate = asyncHandler(async (req, res) => {
  const user = await usersService.setActiveStatus(req.params.id, false, req.user);
  return ApiResponse.success(res, { user }, 'Account deactivated. Staff will be logged out on next request.');
});

const resetPassword = asyncHandler(async (req, res) => {
  await usersService.sendPasswordReset(req.params.id, req.user);
  return ApiResponse.success(res, null, 'Password reset email sent.');
});

module.exports = { list, getOne, getMe, create, update, activate, deactivate, resetPassword };
