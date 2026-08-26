// ── Module: Medicine Categories
// ── Role: Routes + Validation

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('./categories.controller');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

const router = express.Router();
router.use(authenticate);

// ── Validation rules
const uuidParam = [param('id').isUUID().withMessage('Invalid category ID')];

const createRules = [
  body('name')
    .trim().notEmpty().withMessage('Category name is required')
    .isLength({ min: 2, max: 50 }).withMessage('Name must be 2–50 characters'),
  body('description')
    .optional({ nullable: true }).trim()
    .isLength({ max: 200 }).withMessage('Description max 200 characters'),
  body('color')
    .optional({ nullable: true })
    .matches(/^#([0-9A-Fa-f]{6})$/).withMessage('Color must be a valid hex code e.g. #3B82F6'),
];

const updateRules = [
  body('name')
    .optional().trim()
    .isLength({ min: 2, max: 50 }).withMessage('Name must be 2–50 characters'),
  body('description')
    .optional({ nullable: true }).trim()
    .isLength({ max: 200 }).withMessage('Description max 200 characters'),
  body('color')
    .optional({ nullable: true })
    .matches(/^#([0-9A-Fa-f]{6})$/).withMessage('Color must be a valid hex code'),
];

const reorderRules = [
  body('orderedIds')
    .isArray({ min: 1 }).withMessage('orderedIds must be a non-empty array')
    .custom(ids => ids.every(id => /^[0-9a-f-]{36}$/.test(id)))
    .withMessage('All IDs must be valid UUIDs'),
];

// ── Routes

// Both roles: list (staff gets active only; owner can pass ?includeInactive=true)
router.get('/', controller.list);

// Both roles: get one
router.get('/:id', uuidParam, validate, controller.getOne);

// Owner only: create, update, reorder, deactivate, reactivate
router.post('/',
  authorize('owner'), createRules, validate, controller.create);

router.patch('/reorder',
  authorize('owner'), reorderRules, validate, controller.reorder);

router.patch('/:id',
  authorize('owner'), uuidParam, updateRules, validate, controller.update);

router.patch('/:id/deactivate',
  authorize('owner'), uuidParam, validate, controller.deactivate);

router.patch('/:id/reactivate',
  authorize('owner'), uuidParam, validate, controller.reactivate);

module.exports = router;
