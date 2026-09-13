// ── Module 23: Supplier Invoices
// ── Role: Routes + Validation + Upload handling

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
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

// ── Upload guards ─────────────────────────────────────────
//
// Every accepted upload is a paid Gemini call, and the whole file sits in
// memory, and again as base64, for as long as the read takes. The API-wide
// limiter in app.js (900 requests per 15 minutes) bounds neither.
//
// Keyed on the USER, not the IP: the whole pharmacy shares one shop IP, which
// is exactly why app.js had to raise its login limiter to 40. Keyed on the IP,
// one busy morning of deliveries would lock every account out at once.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: config.invoices.uploadsPerHour,
  keyGenerator: (req) => req.user.id,
  message: {
    error: 'RATE_LIMITED',
    message: `No more than ${config.invoices.uploadsPerHour} invoice uploads an hour. Try again a little later.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// A cap on reads in progress across the whole process: the memory half of the
// problem, which a per-user count cannot bound. An upload that arrives while the
// cap is reached is told to wait rather than queued, because a queued upload is
// exactly the buffer this exists not to hold.
//
// 'finish' and 'close' can both fire for one response, so the slot is released
// once. It is released on 'close' as well because a client that hangs up never
// produces a 'finish', and a slot that is never freed would refuse every later
// upload until a restart. The price: after a hang-up the abandoned read carries
// on server-side while a new one may start, so the cap can briefly be exceeded.
// That is the better of the two failures.
let extractionsInFlight = 0;
const extractionSlot = (req, res, next) => {
  if (extractionsInFlight >= config.invoices.maxConcurrentExtractions) {
    return next(new AppError(
      'Another invoice is being read right now. Upload this one when it finishes.',
      429, 'EXTRACTION_BUSY'
    ));
  }
  extractionsInFlight += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    extractionsInFlight -= 1;
  };
  res.once('finish', release);
  res.once('close', release);
  return next();
};

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

/** Money that may legitimately be NEGATIVE. Only round_off and
 *  adjustment_amount qualify — a round-off is more often down than up, and a
 *  non-negative rule here would reject the ordinary case. */
const nullableSignedMoney = (field) =>
  body(field).optional({ nullable: true }).custom((v) => v === null || v === '' || Number.isFinite(Number(v)))
    .withMessage(`${field} must be a number`);

const nullableTime = (field) =>
  body(field).optional({ nullable: true }).custom((v) => v === null || v === '' || /^\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp][Mm])?$/.test(String(v)))
    .withMessage(`${field} must be a time such as 14:35 or 02:35 PM`);

const nullableText = (field, max) =>
  body(field).optional({ nullable: true }).isString().isLength({ max })
    .withMessage(`${field} must be text of at most ${max} characters`);

const nullableCount = (field) =>
  body(field).optional({ nullable: true }).custom((v) => v === null || v === '' || (Number.isInteger(Number(v)) && Number(v) >= 1))
    .withMessage(`${field} must be a whole number of at least 1`);

const INVOICE_TYPES = ['TAX_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'];
const PAYMENT_TYPES = ['CASH', 'CREDIT'];

/**
 * The tax summary, validated as a whole array.
 *
 * Two rules the column CHECKs cannot express, and both matter:
 *   · every row needs a rate, because the rate is the row's identity;
 *   · no two rows may share one, because the table's unique index would
 *     otherwise reject the batch AFTER the delete half of the replace has
 *     already run.
 */
const taxSummaryRule = body('tax_summary')
  .optional({ nullable: true })
  .custom((rows) => {
    if (rows === null) return true;
    if (!Array.isArray(rows)) throw new Error('tax_summary must be an array of rate bands');
    if (rows.length > 20) throw new Error('tax_summary cannot have more than 20 rate bands');

    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error('each tax_summary entry must be an object');

      const rate = Number(row.tax_rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        throw new Error('each tax_summary entry needs a tax_rate between 0 and 100');
      }
      if (seen.has(rate)) throw new Error(`tax_summary has two entries for ${rate}%`);
      seen.add(rate);

      for (const field of [
        'basic_amount', 'discount_amount', 'taxable_amount',
        'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'total_tax',
      ]) {
        const v = row[field];
        if (v === undefined || v === null || v === '') continue;
        if (!Number.isFinite(Number(v)) || Number(v) < 0) {
          throw new Error(`tax_summary ${field} must be 0 or more`);
        }
      }
    }
    return true;
  });

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

  // ── Document type and payment terms: two axes, never one.
  // invoice_type is NOT NULL in the schema, so unlike everything else here it
  // may not be cleared — there is no such thing as a document with no type.
  body('invoice_type').optional().isIn(INVOICE_TYPES)
    .withMessage(`invoice_type must be one of: ${INVOICE_TYPES.join(', ')}`),
  body('payment_type').optional({ nullable: true })
    .custom((v) => v === null || v === '' || PAYMENT_TYPES.includes(v))
    .withMessage(`payment_type must be one of: ${PAYMENT_TYPES.join(', ')}`),

  // ── Document references
  nullableTime('invoice_time'),
  nullableDate('due_date'),
  nullableDate('transaction_date'),
  nullableText('order_number', 60),
  nullableDate('order_date'),
  nullableText('lr_number', 60),
  nullableDate('lr_date'),
  nullableCount('page_number'),
  nullableCount('total_pages'),
  nullableText('sales_executive', 120),

  // ── Party snapshots
  nullableText('supplier_address', 400),
  nullableText('supplier_pan', 20),
  nullableText('supplier_email', 120),
  nullableText('supplier_state', 60),
  nullableText('supplier_state_code', 2),
  nullableText('buyer_name', 200),
  nullableText('buyer_address', 400),
  nullableText('buyer_gstin', 20),
  nullableText('buyer_pan', 20),
  nullableText('buyer_dl_no', 100),
  nullableText('buyer_phone', 30),
  nullableText('buyer_state', 60),
  nullableText('buyer_state_code', 2),

  // ── Printed money
  nullableMoney('subtotal'),
  nullableMoney('total_discount'),
  nullableMoney('total_cgst'),
  nullableMoney('total_sgst'),
  nullableMoney('total_igst'),
  nullableMoney('total_cess'),
  nullableMoney('invoice_total'),
  nullableMoney('additional_amount'),
  nullableMoney('deduction_amount'),
  // Signed — see nullableSignedMoney.
  nullableSignedMoney('adjustment_amount'),
  nullableSignedMoney('round_off'),

  taxSummaryRule,

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
  // A THIRD price, not a synonym for either. See schema-37 §37.2.
  nullableMoney('trade_price'),
  nullablePercent('discount_pct'),
  nullableMoney('discount_amount'),
  nullablePercent('gst_pct'),
  nullableMoney('unit_cost'),
  nullableMoney('mrp'),
  nullableMoney('selling_price'),
  nullableMoney('line_total'),
  body('is_excluded').optional().isBoolean(),

  // ── schema-37 line tax. Every component is independently nullable: a line
  // carries CGST+SGST or IGST, never both, so requiring any of them together
  // would reject one of the two legitimate shapes.
  nullableText('hsn_code', 20),
  nullableMoney('taxable_amount'),
  nullablePercent('cgst_pct'),
  nullableMoney('cgst_amount'),
  nullablePercent('sgst_pct'),
  nullableMoney('sgst_amount'),
  nullablePercent('igst_pct'),
  nullableMoney('igst_amount'),
  nullablePercent('cess_pct'),
  nullableMoney('cess_amount'),
  nullableMoney('net_amount'),
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

// Guards before multer, so an upload that will be refused is never buffered.
router.post('/',                         uploadLimiter, extractionSlot, acceptUpload, controller.upload);

router.patch('/:id',                     uid(), updateInvoiceRules, validate, controller.update);
router.patch('/:id/items/:itemId',       [...uid(), ...uid('itemId')], updateItemRules, validate, controller.updateItem);
router.post('/:id/items/:itemId/medicine', authorize('owner'), [...uid(), ...uid('itemId')], quickAddRules, validate, controller.createMedicineForItem);

router.post('/:id/approve',              authorize('owner'), uid(), validate, controller.approve);
router.post('/:id/reject',               uid(), [body('reason').optional({ nullable: true }).isString().isLength({ max: 300 })], validate, controller.reject);

module.exports = router;
