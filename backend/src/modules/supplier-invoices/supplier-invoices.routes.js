// ── Module 23: Supplier Invoices
// ── Role: Routes + Validation + Upload handling

const express = require('express');
const multer = require('multer');
const { body, param, query } = require('express-validator');
const controller = require('./supplier-invoices.controller');
const config = require('../../config/env');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { AppError } = require('../../utils/AppError');
const { UNITS, CONTENT_UNITS } = require('../medicines/medicines.service');

// ── Upload ────────────────────────────────────────────────
//
// memoryStorage on purpose. The buffer goes straight to Supabase Storage and
// straight to Gemini; writing it to this server's disk first would create a
// third copy of a distributor's invoice on a box that has no lifecycle policy
// for it, and would need cleanup on every error path. Fewer than 20 files a
// month at ≤12MB is not a memory concern.
const ACCEPTED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const uploadHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.invoices.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_MIME.has(file.mimetype)) {
      cb(new AppError(
        'Upload the invoice as a PDF, JPG, PNG or WebP.',
        422, 'UNSUPPORTED_FILE_TYPE'
      ));
      return;
    }
    cb(null, true);
  },
}).single('file');

/** Multer throws MulterError, which is not an AppError — errorHandler would
 *  report it as a generic 500 and the person would be told to "try again" for
 *  a file that will never be small enough. Translated here instead. */
const acceptUpload = (req, res, next) => uploadHandler(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    const mb = Math.round(config.invoices.maxUploadBytes / (1024 * 1024));
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(
        `That file is larger than ${mb}MB. Re-scan it at a lower resolution, or split a long invoice into parts.`,
        413, 'FILE_TOO_LARGE'
      ));
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError('Upload one invoice at a time, in a field named "file".', 422, 'UNEXPECTED_FILE'));
    }
    return next(new AppError('The upload could not be read.', 422, 'UPLOAD_FAILED'));
  }
  return next(err);
});

// ── Validation ────────────────────────────────────────────

const uid = (f = 'id') => [param(f).isUUID().withMessage('Invalid id')];

const listRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['NEEDS_REVIEW', 'IMPORTED', 'REJECTED']),
  query('supplierId').optional().isUUID(),
];

const nullableDate = (field) =>
  body(field).optional({ nullable: true }).custom((v) => v === null || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v))
    .withMessage(`${field} must be a YYYY-MM-DD date`);

const nullableMoney = (field) =>
  body(field).optional({ nullable: true }).custom((v) => v === null || v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0))
    .withMessage(`${field} must be 0 or more`);

const nullableInt = (field, min = 0) =>
  body(field).optional({ nullable: true }).custom((v) => v === null || v === '' || (Number.isInteger(Number(v)) && Number(v) >= min))
    .withMessage(`${field} must be a whole number of at least ${min}`);

const nullablePercent = (field) =>
  body(field).optional({ nullable: true }).custom((v) => v === null || v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100))
    .withMessage(`${field} must be between 0 and 100`);

const updateInvoiceRules = [
  body('supplier_id').optional({ nullable: true }).custom((v) => v === null || v === '' || /^[0-9a-fA-F-]{36}$/.test(v))
    .withMessage('supplier_id must be a valid id'),
  body('invoice_no').optional({ nullable: true }).isString().isLength({ max: 60 }),
  body('supplier_gstin').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('supplier_dl_no').optional({ nullable: true }).isString().isLength({ max: 100 }),
  body('supplier_phone').optional({ nullable: true }).isString().isLength({ max: 30 }),
  nullableDate('invoice_date'),
  nullableMoney('taxable_total'),
  nullableMoney('gst_total'),
  nullableMoney('net_total'),
  // status is deliberately absent: it moves only through /approve and /reject.
  body('status').not().exists().withMessage('Use /approve or /reject to change the status.'),
];

const updateItemRules = [
  body('medicine_id').optional({ nullable: true }).custom((v) => v === null || v === '' || /^[0-9a-fA-F-]{36}$/.test(v))
    .withMessage('medicine_id must be a valid id'),
  body('batch_no').optional({ nullable: true }).isString().isLength({ max: 60 }),
  nullableDate('mfg_date'),
  nullableDate('exp_date'),
  nullableInt('qty_billed', 0),
  nullableInt('qty_free', 0),
  body('pack_raw').optional({ nullable: true }).isString().isLength({ max: 40 }),
  nullableMoney('printed_rate'),
  nullableMoney('printed_mrp'),
  nullablePercent('discount_pct'),
  nullablePercent('gst_pct'),
  nullableMoney('unit_cost'),
  nullableMoney('mrp'),
  nullableMoney('selling_price'),
  nullableMoney('line_total'),
  body('is_excluded').optional().isBoolean(),
];

// Mirrors medicines.routes.js createRules — the Quick Add form is the same
// create, so it must not be able to make a medicine the Medicines page could
// not have made.
const quickAddRules = [
  body('name').trim().notEmpty().withMessage('Medicine name is required')
    .isLength({ min: 2, max: 150 }).withMessage('Name must be 2–150 characters'),
  body('generic_name').optional({ nullable: true }).trim().isLength({ max: 150 }),
  body('manufacturer').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('category_id').isUUID().withMessage('Valid category ID is required'),
  body('unit').isIn(UNITS).withMessage(`Unit must be one of: ${UNITS.join(', ')}`),
  body('default_selling_price').isFloat({ min: 0.01 }).withMessage('Selling price must be greater than 0'),
  body('low_stock_threshold').optional().isInt({ min: 0 }),
  body('hsn_code').optional({ nullable: true }).trim().isLength({ max: 20 }),
  body('pack_content_quantity')
    .optional({ nullable: true })
    .custom((val, { req }) => {
      const hasQty = val !== null && val !== undefined && val !== '';
      const hasUnit = req.body.pack_content_unit !== null && req.body.pack_content_unit !== undefined && req.body.pack_content_unit !== '';
      if (!hasQty && hasUnit) {
        throw new Error('Pack content quantity is required when pack content unit is set');
      }
      if (hasQty) {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          throw new Error('Pack contents must be an integer between 1 and 1000');
        }
        if (!hasUnit) {
          throw new Error('Pack content unit is required when pack content quantity is set');
        }
      }
      return true;
    }),
  body('pack_content_unit')
    .optional({ nullable: true })
    .custom((val, { req }) => {
      const hasUnit = val !== null && val !== undefined && val !== '';
      const hasQty = req.body.pack_content_quantity !== null && req.body.pack_content_quantity !== undefined && req.body.pack_content_quantity !== '';
      if (!hasUnit && hasQty) {
        throw new Error('Pack content unit is required when pack content quantity is set');
      }
      if (hasUnit) {
        if (!CONTENT_UNITS.includes(val)) {
          throw new Error(`Pack content unit must be one of: ${CONTENT_UNITS.join(', ')}`);
        }
        if (!hasQty) {
          throw new Error('Pack content quantity is required when pack content unit is set');
        }
      }
      return true;
    }),
];


// ── Routes ────────────────────────────────────────────────
//
// Role split, and the reason for it:
//   Staff  upload and correct drafts. They are the ones at the goods-inward
//          desk holding the carton, and nothing they do here becomes stock.
//   Owner  approves. Approval is the write — it creates batches, ledger rows
//          and a purchase record — so it is the owner's alone, exactly like
//          every other purchase route in this app.
//
// Note this module necessarily shows purchase cost to Staff, which criterion
// A9 otherwise keeps out of Staff responses. That is inherent to the task:
// checking a distributor's rate against the invoice in your hand is the job.
// It is a deliberate, scoped exception, not an oversight — see the A9 note in
// docs/UI-GUIDELINES-IMPLEMENTATION.md.

const router = express.Router();
router.use(authenticate);

router.get('/',                          listRules, validate, controller.list);
router.get('/match/medicines',           [query('q').trim().notEmpty().isLength({ max: 200 })], validate, controller.matchMedicines);
router.get('/:id',                       uid(), validate, controller.getOne);
router.get('/:id/document',              uid(), validate, controller.document);

router.post('/',                         acceptUpload, controller.upload);

router.patch('/:id',                     uid(), updateInvoiceRules, validate, controller.update);
router.patch('/:id/items/:itemId',       [...uid(), ...uid('itemId')], updateItemRules, validate, controller.updateItem);
router.post('/:id/items/:itemId/medicine', authorize('owner'), [...uid(), ...uid('itemId')], quickAddRules, validate, controller.createMedicineForItem);

router.post('/:id/approve',              authorize('owner'), uid(), validate, controller.approve);
router.post('/:id/reject',               uid(), [body('reason').optional({ nullable: true }).isString().isLength({ max: 300 })], validate, controller.reject);

module.exports = router;
