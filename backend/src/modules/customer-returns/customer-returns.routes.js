// ── Module 12: Customer Returns
// ── Role: Routes + Validation

const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./customer-returns.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

// ── Validation
const uid = (f='id') => [param(f).isUUID()];
const createRules = [
  body('bill_id').isUUID().withMessage('Valid bill ID required'),
  body('reason').trim().notEmpty().withMessage('Return reason is required').isLength({ min:5, max:500 }),
  body('refund_mode').isIn(['cash','upi','credit_note']).withMessage('Refund mode: cash, upi, or credit_note'),
  body('items').isArray({ min:1 }).withMessage('At least one return item required'),
  body('items.*.bill_item_id').isUUID(),
  body('items.*.qty_returned').isInt({ min:1 }),
];

// ── Routes
const router = express.Router();
router.use(authenticate);

router.get('/',          controller.list);
router.get('/:id',       uid(), validate, controller.getOne);
router.post('/',         createRules, validate, controller.create);
router.patch('/:id/approve', authorize('owner'), uid(), validate, controller.approve);
router.patch('/:id/reject',  authorize('owner'), uid(), [body('rejection_note').optional().trim().isLength({ max:500 })], validate, controller.reject);

module.exports = router;
