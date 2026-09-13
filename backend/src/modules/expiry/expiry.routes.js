// ── Module 14: Expiry Management
// ── Role: Routes + Validation

const express = require('express');
const { param, query } = require('express-validator');
const controller = require('./expiry.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { URGENCIES } = require('./expiry.service');

const router = express.Router();
router.use(authenticate);
router.use(authorize('owner'));  // all expiry operations are owner-only

// `urgency` is required here, unlike the :urgency route where the path
// supplies it. 'ok' is not an option on either — the dashboard is about stock
// that needs a decision.
const batchesQuery = [
  query('urgency').isIn(URGENCIES).withMessage(`Urgency must be one of: ${URGENCIES.join(', ')}`),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

router.get('/dashboard',               controller.dashboard);
router.get('/report',                  controller.report);
router.get('/batches',                 batchesQuery, validate, controller.batches);
router.get('/urgency/:urgency',        [param('urgency').isIn(URGENCIES)], validate, controller.byUrgency);
router.patch('/batch/:batchId/writeoff', [param('batchId').isUUID()], validate, controller.writeOff);
router.post('/bulk-writeoff',          controller.bulkWriteOff);

module.exports = router;
