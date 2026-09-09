// ── Module 16: Notifications
// ── Role: Controller

const svc = require('./notifications.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

// The service takes the whole `req.user`, not just the id: since Module 36 the
// payload includes derived expiry/low-stock alerts, which are owner-only and
// filtered server-side rather than hidden in the DOM (A9).

const list = asyncHandler(async (req, res) => {
  const notifications = await svc.getNotifications(req.user, { unreadOnly: req.query.unreadOnly === 'true' });
  return ApiResponse.success(res, { notifications });
});

const count = asyncHandler(async (req, res) => {
  const unreadCount = await svc.getUnreadCount(req.user);
  // NOTE: `unread_count`, not `count` — useNotifications.js reads this exact key.
  return ApiResponse.success(res, { unread_count: unreadCount });
});

const read = asyncHandler(async (req, res) => {
  await svc.markRead(req.params.id, req.user);
  return ApiResponse.success(res, null, 'Marked as read.');
});

const readAll = asyncHandler(async (req, res) => {
  await svc.markAllRead(req.user);
  return ApiResponse.success(res, null, 'All marked as read.');
});

module.exports = { list, count, read, readAll };
