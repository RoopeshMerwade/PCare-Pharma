// ── Module 15: Reports
// ── Role: Routes + Validation

const express = require('express');
const { query } = require('express-validator');
const controller = require('./reports.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

const dateQuery = [query('dateFrom').optional().isDate(), query('dateTo').optional().isDate()];

const router = express.Router();
router.use(authenticate);
router.use(authorize('owner'));
router.get('/sales',        dateQuery, validate, controller.sales);
router.get('/margins',      controller.margins);
router.get('/purchases',    dateQuery, validate, controller.purchases);
router.get('/inventory',    controller.inventory);
router.get('/top-medicines', dateQuery, validate, controller.top);

module.exports = router;
