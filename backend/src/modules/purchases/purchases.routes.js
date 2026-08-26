// ── Modules 07+08: Purchases & Purchase Items
// ── Role: Routes + Validation

const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./purchases.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

// ── Validation ────────────────────────────────────────────

const uid = (f = 'id') => [param(f).isUUID()];

const createRules = [
  body('supplier_id').isUUID().withMessage('Valid supplier ID required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('items.*.medicine_id').isUUID().withMessage('Each item needs a valid medicine ID'),
  body('items.*.qty_ordered').isInt({ min: 1 }).withMessage('Quantity must be ≥ 1'),
  body('items.*.unit_cost').isFloat({ min: 0 }).withMessage('Unit cost must be 0 or more'),
];

const receiveRules = [
  body('invoice_no').optional({ nullable: true }).isString().trim(),
  body('items').isArray({ min: 1 }).withMessage('Receipt items required'),
  body('items.*.purchase_item_id').isUUID(),
  body('items.*.batch_no').trim().notEmpty().withMessage('Batch number required'),
  body('items.*.qty_received').isInt({ min: 1 }).withMessage('Received qty must be ≥ 1'),
  body('items.*.exp_date').isDate({ format: 'YYYY-MM-DD' }).withMessage('Expiry date required'),
  body('items.*.mrp').isFloat({ min: 0.01 }).withMessage('MRP required'),
  body('items.*.selling_price').isFloat({ min: 0.01 }).withMessage('Selling price required'),
];

// ── Routes ────────────────────────────────────────────────

const router = express.Router();
router.use(authenticate);
router.use(authorize('owner')); // all purchase routes are owner-only

router.get('/',                            controller.list);
router.get('/:id',          uid(), validate, controller.getOne);
router.post('/',             createRules, validate, controller.create);
router.patch('/:id',         uid(), validate, controller.update);
router.patch('/:id/send',    uid(), validate, controller.send);
router.patch('/:id/cancel',  uid(), validate, controller.cancel);
router.post('/:id/receive',  uid(), receiveRules, validate, controller.receive);
router.post('/:id/items',    uid(), validate, controller.addItem);
router.delete('/:id/items/:itemId', [...uid(), ...uid('itemId')], validate, controller.removeItem);

module.exports = router;
