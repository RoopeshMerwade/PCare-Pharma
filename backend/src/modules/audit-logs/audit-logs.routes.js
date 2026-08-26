// ── Module 20: Audit Logs
// ── Role: Routes + Validation

const express = require('express');
const { query } = require('express-validator');
const controller = require('./audit-logs.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

const dateQuery = [query('dateFrom').optional().isDate(), query('dateTo').optional().isDate()];

const router = express.Router();
router.use(authenticate);
router.use(authorize('owner'));
router.get('/', dateQuery, validate, controller.list);

module.exports = router;
