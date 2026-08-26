// ── Module 06: Suppliers
// ── Role: Routes + Validation

const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./suppliers.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

// ── Routes
const router = express.Router();
router.use(authenticate);

const uid = [param('id').isUUID()];
const createRules = [
  body('name').trim().notEmpty().withMessage('Supplier name is required').isLength({ min: 2, max: 150 }),
  body('phone').optional().isMobilePhone('en-IN').withMessage('Valid Indian phone number required'),
  body('email').optional({ nullable: true }).isEmail().normalizeEmail(),
  body('credit_terms_days').optional().isInt({ min: 1, max: 365 }),
  body('gst_no').optional({ nullable: true }).trim().isLength({ max: 20 }),
];

router.get('/',               controller.list);
router.get('/:id',            uid, validate, controller.getOne);
router.post('/',              authorize('owner'), createRules, validate, controller.create);
router.patch('/:id',          authorize('owner'), uid, validate, controller.update);
router.patch('/:id/deactivate', authorize('owner'), uid, validate, controller.deactivate);
router.patch('/:id/reactivate', authorize('owner'), uid, validate, controller.reactivate);

module.exports = router;
