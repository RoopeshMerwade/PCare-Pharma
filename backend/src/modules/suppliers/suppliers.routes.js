// ── Module 06: Suppliers
// ── Role: Routes + Validation

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('./suppliers.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { isContactPhone, normalizeContactPhone, CONTACT_PHONE_MESSAGE } = require('../../utils/phone');

// ── Routes
const router = express.Router();
router.use(authenticate);

const uid = [param('id').isUUID()];

// A supplier's phone is a letterhead detail, not an identity — see
// utils/phone.js for why isMobilePhone('en-IN') was the wrong rule and
// rejected every landline a distributor prints.
//
// `{ values: 'falsy' }`, not a bare `.optional()`: bare optional skips only
// `undefined`, and both forms that post here send a blank phone as a value —
// SuppliersPage as `''`, Module 23's Add-and-link dialog as `null`. The field
// was labelled "(optional)" and was in practice mandatory, because clearing it
// still handed a value to isMobilePhone. Same trap users.routes.js hit.
const phoneRule = body('phone')
  .optional({ values: 'falsy' })
  .customSanitizer(normalizeContactPhone)
  .custom(isContactPhone).withMessage(CONTACT_PHONE_MESSAGE);

const createRules = [
  body('name').trim().notEmpty().withMessage('Supplier name is required').isLength({ min: 2, max: 150 }),
  phoneRule,
  // Also `{ values: 'falsy' }`, and for the same reason: `{ nullable: true }`
  // skips null but not `''`, and SuppliersPage submits `''` for an email left
  // blank. Adding a supplier with no email address answered
  // `422 email: Invalid value` — the phone bug's twin, one field down.
  body('email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  body('credit_terms_days').optional().isInt({ min: 1, max: 365 }),
  body('gst_no').optional({ nullable: true }).trim().isLength({ max: 20 }),
];

const listQuery = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isLength({ max: 100 }),
];

// `/options` MUST stay registered before `/:id`. Express matches in order; the
// other way round the literal path binds to the id param, fails isUUID and
// answers 422 about a malformed identifier — a routing bug wearing a
// validation bug's clothes. Same trap stock-requisitions documents for
// /vendor-prices, and tests/pagination-routes.test.js guards it here.
//
// No authorize('owner'): staff reach this through BatchDrawer's Add Batch form.
router.get('/options',        controller.options);
router.get('/',               listQuery, validate, controller.list);
router.get('/:id',            uid, validate, controller.getOne);
router.post('/',              authorize('owner'), createRules, validate, controller.create);
router.patch('/:id',          authorize('owner'), uid, validate, controller.update);
router.patch('/:id/deactivate', authorize('owner'), uid, validate, controller.deactivate);
router.patch('/:id/reactivate', authorize('owner'), uid, validate, controller.reactivate);

module.exports = router;
