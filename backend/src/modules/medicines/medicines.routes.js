// ── Module: Medicines
// ── Role: Routes + Validation

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('./medicines.controller');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { UNITS, CONTENT_UNITS } = require('./medicines.service');

const router = express.Router();
router.use(authenticate);

// ── Validation
const uuidParam = [param('id').isUUID().withMessage('Invalid medicine ID')];

/* Pack contents — what is inside ONE `unit` (10 for a 10-tablet strip).
   Optional everywhere: a catalogue that has never recorded it keeps working
   exactly as before, and the only feature that needs it (loose single-unit
   sales, Module 27) simply stays unavailable for that medicine.

   The upper bound of 1000 is a typo guard, not a policy — a "10000'S" pack
   does not exist, and the number divides a price, so a slipped zero makes
   every tablet a tenth of its real value. */
const packContentRules = [
  body('pack_content_quantity')
    .optional({ nullable: true })
    .isInt({ min: 1, max: 1000 }).withMessage('Pack contents must be between 1 and 1000'),
  body('pack_content_unit')
    .optional({ nullable: true })
    .isIn(CONTENT_UNITS).withMessage(`Pack content unit must be one of: ${CONTENT_UNITS.join(', ')}`),
];

const createRules = [
  body('name')
    .trim().notEmpty().withMessage('Medicine name is required')
    .isLength({ min: 2, max: 150 }).withMessage('Name must be 2–150 characters'),
  body('generic_name')
    .optional({ nullable: true }).trim()
    .isLength({ max: 150 }).withMessage('Generic name max 150 characters'),
  body('manufacturer')
    .optional({ nullable: true }).trim()
    .isLength({ max: 100 }).withMessage('Manufacturer max 100 characters'),
  body('category_id')
    .isUUID().withMessage('Valid category ID is required'),
  body('unit')
    .isIn(UNITS).withMessage(`Unit must be one of: ${UNITS.join(', ')}`),
  body('default_selling_price')
    .isFloat({ min: 0.01 }).withMessage('Selling price must be greater than 0'),
  body('low_stock_threshold')
    .optional()
    .isInt({ min: 0 }).withMessage('Low stock threshold must be 0 or more'),
  body('hsn_code')
    .optional({ nullable: true }).trim()
    .isLength({ max: 20 }).withMessage('HSN code max 20 characters'),
  body('description')
    .optional({ nullable: true }).trim()
    .isLength({ max: 500 }).withMessage('Description max 500 characters'),
  ...packContentRules,
];

const updateRules = [
  body('name')
    .optional().trim()
    .isLength({ min: 2, max: 150 }).withMessage('Name must be 2–150 characters'),
  body('generic_name')
    .optional({ nullable: true }).trim()
    .isLength({ max: 150 }),
  body('manufacturer')
    .optional({ nullable: true }).trim()
    .isLength({ max: 100 }),
  body('category_id')
    .optional().isUUID().withMessage('Valid category ID required'),
  body('unit')
    .optional().isIn(UNITS).withMessage(`Unit must be one of: ${UNITS.join(', ')}`),
  body('default_selling_price')
    .optional().isFloat({ min: 0.01 }).withMessage('Price must be greater than 0'),
  body('low_stock_threshold')
    .optional().isInt({ min: 0 }),
  body('hsn_code')
    .optional({ nullable: true }).trim().isLength({ max: 20 }),
  body('description')
    .optional({ nullable: true }).trim().isLength({ max: 500 }),
  ...packContentRules,
  // Prevent status manipulation via this endpoint
  body('is_active').not().exists().withMessage('Use /deactivate or /reactivate instead'),
];

const searchQuery = [
  query('q').notEmpty().withMessage('Search query is required').isLength({ max: 100 }),
];

const listQuery = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('categoryId').optional().isUUID(),
  query('stock').optional().isIn(['low', 'out', 'ok']),
];

// ── Routes (order matters: /search before /:id to avoid collision)
router.get('/search',          searchQuery, validate, controller.search);
router.get('/alerts/low-stock', authorize('owner'), controller.lowStockAlerts);
router.get('/alerts/near-expiry', authorize('owner'), controller.nearExpiryAlerts);
router.get('/',                listQuery, validate, controller.list);
router.get('/:id/alternatives', uuidParam, validate, controller.getAlternatives);
router.get('/:id',             uuidParam, validate, controller.getOne);

router.post('/',               authorize('owner'), createRules, validate, controller.create);
router.patch('/:id',           authorize('owner'), uuidParam, updateRules, validate, controller.update);
router.patch('/:id/deactivate', authorize('owner'), uuidParam, validate, controller.deactivate);
router.patch('/:id/reactivate', authorize('owner'), uuidParam, validate, controller.reactivate);

module.exports = router;
