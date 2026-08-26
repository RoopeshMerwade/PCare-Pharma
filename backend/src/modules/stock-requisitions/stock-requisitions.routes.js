// ── Module 30: Stock Requisitions
// ── Role: Routes + Validation
//
// Two guards live here, and one deliberately does not.
//
// `authorize('owner')` is on approve, reject and both exports, because those
// are genuinely owner-only ACTIONS rather than a wider scope on a shared one.
// It is NOT on list, get-by-id or cancel: staff legitimately reach all three
// for their own rows, and a route-level guard could only say "owner only",
// which would lock them out of the feature. That scoping lives in the service,
// in one place, the way attendance's resolveTarget() is one place.
//
// ── THE A9 EXCEPTION LIVES ON ONE ROUTE ──────────────────────────────────────
// GET /vendor-prices shows Staff what the pharmacy last paid each distributor.
// That is the second deliberate, scoped exception to criterion A9 (the first is
// Module 23's goods-inward screen); see docs/UI-GUIDELINES-IMPLEMENTATION.md.
// It is a purpose-built endpoint over a purpose-built six-column view — NOT a
// relaxation of /purchases, /purchase-items or /suppliers, which stay
// owner-only and unchanged. Do not widen it, and do not move it onto
// /medicines: hanging it off the catalogue would make it look like a general
// capability and invite reuse that widens the exception without anyone
// deciding to.
//
// ── ROUTE ORDER IS LOAD-BEARING ──────────────────────────────────────────────
// '/vendor-prices' and '/low-stock' are registered BEFORE '/:id'. Express
// matches in order, so the other way round the literal path binds to :id, fails
// isUUID and answers 422 about a malformed identifier — a routing bug wearing a
// validation bug's clothes. There is a test for exactly this.

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('./stock-requisitions.controller');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { MAX_ITEMS } = require('./stock-requisitions.service');

const router = express.Router();

router.use(authenticate);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Validation rules

const listRules = [
  query('status').optional({ values: 'falsy' })
    .isIn(['pending', 'approved', 'rejected', 'cancelled'])
    .withMessage('Status must be pending, approved, rejected or cancelled'),
  query('urgency').optional({ values: 'falsy' }).isIn(['normal', 'urgent'])
    .withMessage('Urgency must be normal or urgent'),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

// A comma list rather than repeated params: it is what a URL built from an
// array looks like, and it keeps the cap checkable in one rule.
const vendorPriceRules = [
  query('medicine_ids').notEmpty()
    .withMessage('Name at least one medicine to price').bail()
    .customSanitizer((v) => String(v).split(',').map((s) => s.trim()).filter(Boolean))
    .isArray({ min: 1, max: MAX_ITEMS })
    .withMessage(`Ask for between 1 and ${MAX_ITEMS} medicines at a time`).bail()
    .custom((ids) => ids.every((id) => UUID_RE.test(id)))
    .withMessage('Every medicine id must be a valid identifier'),
];

const lowStockRules = [
  query('limit').optional().isInt({ min: 1, max: 200 })
    .withMessage('Limit must be between 1 and 200'),
];

// The client sends WHAT it wants and WHO from. It never sends a price, a
// distributor's name, or anything else derived — see snapshotVendors() in the
// service, which reads all of that from the database. A `supplier_id` of null
// is a legitimate line ("nobody obvious to order this from"), not an omission.
const createRules = [
  body('urgency').optional({ values: 'falsy' }).isIn(['normal', 'urgent'])
    .withMessage('Urgency must be normal or urgent'),
  body('note').optional({ values: 'falsy' }).trim().isLength({ max: 500 })
    .withMessage('The note must be 500 characters or fewer'),
  body('items').isArray({ min: 1, max: MAX_ITEMS })
    .withMessage(`A request needs between 1 and ${MAX_ITEMS} lines`),
  body('items.*.medicine_id').isUUID().withMessage('Every line needs a valid medicine'),
  body('items.*.qty').isInt({ min: 1, max: 100000 })
    .withMessage('Every line needs a quantity of at least 1'),
  body('items.*.supplier_id').optional({ values: 'falsy' }).isUUID()
    .withMessage('Invalid distributor selection'),
  body('items.*.note').optional({ values: 'falsy' }).trim().isLength({ max: 200 })
    .withMessage('A line note must be 200 characters or fewer'),
];

// A rejection with no reason is useless to the person who raised it — they
// cannot fix what they were not told about. Required, not optional.
const rejectRules = [
  param('id').isUUID().withMessage('Invalid request identifier'),
  body('rejection_note').trim().notEmpty()
    .withMessage('Say why, so the request can be corrected and sent again').bail()
    .isLength({ min: 5, max: 500 })
    .withMessage('The reason must be between 5 and 500 characters'),
];

const exportRules = [
  param('id').isUUID().withMessage('Invalid request identifier'),
  param('format').isIn(['xlsx', 'pdf']).withMessage('Download as xlsx or pdf'),
];

const uid = () => [param('id').isUUID().withMessage('Invalid request identifier')];

// ── Routes

router.get('/',              listRules, validate, controller.list);
router.get('/vendor-prices', vendorPriceRules, validate, controller.vendorPrices);
router.get('/low-stock',     lowStockRules, validate, controller.lowStock);
router.get('/:id',           uid(), validate, controller.getOne);
router.post('/',             createRules, validate, controller.create);

router.patch('/:id/approve', authorize('owner'), uid(), validate, controller.approve);
router.patch('/:id/reject',  authorize('owner'), rejectRules, validate, controller.reject);
router.patch('/:id/cancel',  uid(), validate, controller.cancel);

router.get('/:id/export/:format', authorize('owner'), exportRules, validate, controller.exportOne);

module.exports = router;
