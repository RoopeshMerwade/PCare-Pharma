// ── Module 13: Supplier Returns
// ── Role: Routes + Validation

const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./supplier-returns.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

const uid = (f='id') => [param(f).isUUID()];
const createRules = [
  body('supplier_id').isUUID().withMessage('Supplier ID required'),
  body('reason').trim().notEmpty().withMessage('Return reason required').isLength({ min:5, max:500 }),
  body('items').isArray({ min:1 }).withMessage('At least one item required'),
  body('items.*.batch_id').isUUID(),
  body('items.*.qty_returned').isInt({ min:1 }),
];

const router = express.Router();
router.use(authenticate);
router.use(authorize('owner'));  // all supplier return operations are owner-only

router.get('/',                    controller.list);
router.get('/:id',                 uid(), validate, controller.getOne);
router.post('/',                   createRules, validate, controller.create);
router.patch('/:id/send',          uid(), validate, controller.send);
router.patch('/:id/acknowledge',   uid(), validate, controller.acknowledge);

module.exports = router;
