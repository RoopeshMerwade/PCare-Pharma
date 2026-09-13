// ── Modules 09+10: Billing — routes + validation rules.

const express = require('express');
const { body, param, query } = require('express-validator');
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

/* Owner bill deletion (schema-38). The reason travels in a body, and the
   frontend's api.delete() sends none, so these are POST actions — the same shape
   as POST /users/:id/reset-password. */
const DATE_ONLY = { format: 'YYYY-MM-DD', strictMode: true };

const reasonRule = body('reason')
  .isString().withMessage('Give a reason for deleting')
  .bail().trim().isLength({ min: 5, max: 500 }).withMessage('The reason must be 5 to 500 characters');

const rangePreviewRules = [
  query('dateFrom').isDate(DATE_ONLY).withMessage('dateFrom must be a date, YYYY-MM-DD'),
  query('dateTo').isDate(DATE_ONLY).withMessage('dateTo must be a date, YYYY-MM-DD'),
];

const rangeDeleteRules = [
  body('dateFrom').isDate(DATE_ONLY).withMessage('dateFrom must be a date, YYYY-MM-DD'),
  body('dateTo').isDate(DATE_ONLY).withMessage('dateTo must be a date, YYYY-MM-DD'),
  reasonRule,
  body('expected_count').isInt({ min: 1 }).withMessage('expected_count must be the bill count the preview showed'),
  body('expected_total').isFloat({ min: 0 }).withMessage('expected_total must be the total the preview showed'),
];

const router = express.Router();
router.use(authenticate);

// Both roles: staff create bills, owner views all
router.get('/totals', authorize('owner'), controller.totals);

// These two literal paths MUST stay above '/:id'. Registered after it,
// 'delete-preview' binds to :id, fails isUUID and answers 422 about a malformed
// identifier. tests/bill-deletion-routes.test.js guards the order.
router.get('/delete-preview', authorize('owner'), rangePreviewRules, validate, controller.previewRangeDeletion);
router.post('/delete-range',  authorize('owner'), rangeDeleteRules, validate, controller.deleteRange);

router.get('/',       controller.list);
router.get('/:id',    [param('id').isUUID()], validate, controller.getOne);
router.post('/',      createRules, validate, controller.create);

router.get('/:id/delete-preview', authorize('owner'), [param('id').isUUID()], validate, controller.previewBillDeletion);
router.post('/:id/delete',        authorize('owner'), [param('id').isUUID(), reasonRule], validate, controller.deleteBill);

// No PATCH — a bill's lines, prices and payment are never edited; corrections
// go through customer returns (Module 12). The one exception to "a bill is
// forever" is the owner deleting it outright, above, which never returns stock.

module.exports = router;
