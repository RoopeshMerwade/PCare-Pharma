// ── Module 16: Notifications
// ── Role: Controller

const svc = require('./notifications.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const list = asyncHandler(async (req, res) => {
  const notifications = await svc.getNotifications(req.user.id, { unreadOnly: req.query.unreadOnly === 'true' });
  return ApiResponse.success(res, { notifications });
});

const count = asyncHandler(async (req, res) => {
  const unreadCount = await svc.getUnreadCount(req.user.id);
  return ApiResponse.success(res, { unread_count: unreadCount });
});

const read = asyncHandler(async (req, res) => {
  await svc.markRead(req.params.id, req.user.id);
  return ApiResponse.success(res, null, 'Marked as read.');
});

const readAll = asyncHandler(async (req, res) => {
  await svc.markAllRead(req.user.id);
  return ApiResponse.success(res, null, 'All marked as read.');
});

module.exports = { list, count, read, readAll };
