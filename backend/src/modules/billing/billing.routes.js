// ── Modules 09+10: Billing — routes + validation rules.

const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./billing.controller');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

/* `qty` counts whole sealed packs; `loose_qty` counts single units out of an
   opened one. The floor on qty drops from 1 to 0 because "3 tablets and no
   whole strip" is now a legitimate line — but a line asking for nothing at all
   is not, so the pair is checked together below.

   Existing clients that only ever send `qty` are unaffected: loose_qty is
   optional and absent means zero. */
const bothZero = (qty, looseQty) => (Number(qty) || 0) <= 0 && (Number(looseQty) || 0) <= 0;

const createRules = [
  body('payment_mode').isIn(['cash', 'upi', 'credit', 'card']).withMessage('Payment mode must be cash, upi, credit, or card'),
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('items.*.medicine_id').isUUID().withMessage('Each item must have a valid medicine ID'),
  body('items.*.qty').isInt({ min: 0 }).withMessage('Item quantity must be a whole number, 0 or more'),
  body('items.*.loose_qty').optional({ nullable: true }).isInt({ min: 0 })
    .withMessage('Loose quantity must be a whole number, 0 or more'),
  body('items').custom((items) => {
    if (!Array.isArray(items)) return true;
    if (items.some((i) => bothZero(i?.qty, i?.loose_qty))) {
      throw new Error('Every item needs a quantity — packs, single units, or both');
    }
    return true;
  }),
  body('customer_phone').optional({ nullable: true }).isMobilePhone('en-IN'),
  body('discount_amount').optional().isFloat({ min: 0 }),
  body('acknowledged_warnings').optional().isArray(),
  body('acknowledged_warnings.*.schedule_id').optional().isUUID(),
];

const router = express.Router();
router.use(authenticate);

// Both roles: staff create bills, owner views all
router.get('/totals', authorize('owner'), controller.totals);
router.get('/',       controller.list);
router.get('/:id',    [param('id').isUUID()], validate, controller.getOne);
router.post('/',      createRules, validate, controller.create);

// No PATCH/DELETE — bills are immutable after creation
// Corrections via customer-returns module (Module 12)

module.exports = router;
