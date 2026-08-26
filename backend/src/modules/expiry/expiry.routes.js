// ── Module 14: Expiry Management
// ── Role: Routes + Validation

const express = require('express');
const { param } = require('express-validator');
const controller = require('./expiry.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

const router = express.Router();
router.use(authenticate);
router.use(authorize('owner'));  // all expiry operations are owner-only

router.get('/dashboard',               controller.dashboard);
router.get('/report',                  controller.report);
router.get('/urgency/:urgency',        [param('urgency').isIn(['expired','critical','warning','watch'])], validate, controller.byUrgency);
router.patch('/batch/:batchId/writeoff', [param('batchId').isUUID()], validate, controller.writeOff);
router.post('/bulk-writeoff',          controller.bulkWriteOff);

module.exports = router;
