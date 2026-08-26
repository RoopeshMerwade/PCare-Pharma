// ── Module 26: Staff Attendance
// ── Role: Routes + Validation
//
// No `authorize('owner')` appears below, and that is deliberate. Every route
// here is legitimately reachable by staff — for THEMSELVES. The owner's
// administrative override is a wider scope on the same endpoint, not a
// different one, so the role check lives in the service where it can see who
// the action is aimed at. A route-level guard could only express "owner only",
// which would lock staff out of their own check-in button.

const express = require('express');
const { body, query } = require('express-validator');
const controller = require('./attendance.controller');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');

const router = express.Router();

router.use(authenticate);

// ── Validation rules

// `user_id` omitted means "me". `optional({ values: 'falsy' })` rather than a
// bare `.optional()` because the widget sends user_id: '' for self-service —
// the same trap users.routes.js hit with a blank phone field.
const checkRules = [
  body('user_id').optional({ values: 'falsy' }).isUUID().withMessage('Invalid staff ID format'),
  body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 300 })
    .withMessage('Notes must be 300 characters or fewer'),
];

const historyRules = [
  query('userId').optional({ values: 'falsy' }).isUUID().withMessage('Invalid staff ID format'),
  query('dateFrom').optional({ values: 'falsy' }).isDate({ format: 'YYYY-MM-DD' })
    .withMessage('dateFrom must be YYYY-MM-DD'),
  query('dateTo').optional({ values: 'falsy' }).isDate({ format: 'YYYY-MM-DD' })
    .withMessage('dateTo must be YYYY-MM-DD'),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

// ── Routes

// Today's board. Owner sees every active staff member; staff see their own row
// — scoped in the service, so the restriction is in the payload, not the DOM.
router.get('/today', controller.today);

// History. Owner may pass any `userId`; staff may only ever read their own.
router.get('/history', historyRules, validate, controller.history);

// Self-service, or an owner override via `user_id`.
router.post('/check-in',  checkRules, validate, controller.checkIn);
router.post('/check-out', checkRules, validate, controller.checkOut);

module.exports = router;
