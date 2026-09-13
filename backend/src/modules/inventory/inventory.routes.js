// ── Module: Inventory
// ── Role: Routes + Validation

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('./inventory.controller');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { CONTENT_UNITS } = require('../medicines/medicines.service');

const router = express.Router();
router.use(authenticate);

const uuidParam = (field = 'id') => [param(field).isUUID().withMessage(`Invalid ${field}`)];

// ── Validation rules
const addBatchRules = [
  body('medicine_id').isUUID().withMessage('Valid medicine ID is required'),
  body('batch_no').trim().notEmpty().withMessage('Batch number is required').isLength({ max: 50 }),
  body('exp_date').isDate({ format: 'YYYY-MM-DD' }).withMessage('Expiry date required (YYYY-MM-DD)'),
  body('mfg_date').optional({ nullable: true }).isDate({ format: 'YYYY-MM-DD' }),
  body('unit_cost').isFloat({ min: 0 }).withMessage('Unit cost must be 0 or more'),
  body('mrp').isFloat({ min: 0.01 }).withMessage('MRP must be greater than 0'),
  body('selling_price').isFloat({ min: 0.01 }).withMessage('Selling price must be greater than 0'),
  body('opening_qty').isInt({ min: 0 }).withMessage('Opening quantity must be 0 or more'),
  body('reason').optional().isIn(['purchase_receipt','opening_stock'])
    .withMessage('Reason must be purchase_receipt or opening_stock'),
  // Who this batch came from. addBatch has always accepted and stored it, but
  // no rule declared it and no form sent it — so inventory_batches.supplier_id
  // was null on every hand-entered batch. Module 30's vendor-price view reads
  // that column, and it is the ONLY source of prices on a database where PO
  // receipt is broken (see the receive_purchase_atomic arity defect), so an
  // unrecorded supplier here is a blank vendor dropdown at the counter.
  body('supplier_id').optional({ values: 'falsy' }).isUUID()
    .withMessage('Invalid distributor selection'),
  // What is inside one unit of this particular batch, when it differs from the
  // medicine's standard pack. Omitted, the catalogue's value applies.
  body('content_quantity').optional({ nullable: true }).isInt({ min: 1, max: 1000 })
    .withMessage('Pack contents must be between 1 and 1000'),
  body('content_unit').optional({ nullable: true }).isIn(CONTENT_UNITS)
    .withMessage(`Pack content unit must be one of: ${CONTENT_UNITS.join(', ')}`),
];

const adjustRules = [
  body('batch_id').isUUID().withMessage('Valid batch ID is required'),
  body('adjustment_qty').isInt().not().equals(0).withMessage('Adjustment quantity must be a non-zero integer'),
  body('note').trim().notEmpty().withMessage('Adjustment note is required')
    .isLength({ min: 5, max: 500 }).withMessage('Note must be 5–500 characters'),
  // Which pool to correct. Defaults to sealed, so every existing request body
  // means exactly what it meant before.
  body('denomination').optional().isIn(['sealed','loose'])
    .withMessage('Denomination must be sealed or loose'),
];

// Mirrors medicines.routes.js's listQuery. `stock` omits 'ok' — unlike
// medicines, whose validator allows a value its service silently ignores.
const overviewQuery = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('categoryId').optional().isUUID(),
  query('stock').optional({ values: 'falsy' }).isIn(['low', 'out', 'near_expiry']),
  query('search').optional().isLength({ max: 100 }),
];

const movementsQuery = [
  query('batchId').optional().isUUID(),
  query('medicineId').optional().isUUID(),
  query('reason').optional().isIn(['purchase_receipt','opening_stock','sale','return_inward','return_outward','adjustment','expiry_writeoff','strip_opened']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

// ── Routes

// Both roles: inventory overview and batch reads. The batch list is shaped by
// role in the service — a staff session gets no cost or supplier columns (A9).
router.get('/', overviewQuery, validate, controller.overview);
router.get('/:medicineId/batches', uuidParam('medicineId'), validate, controller.batchesForMedicine);
router.get('/:medicineId/available-batches', uuidParam('medicineId'), validate, controller.availableBatches);

// Owner only: one batch is the whole inventory_batches row, unit_cost and
// supplier_id included, and no staff screen reads it.
router.get('/batch/:batchId', authorize('owner'), uuidParam('batchId'), validate, controller.getBatch);

// Both roles: adding a batch (staff do the unboxing)
router.post('/batches', addBatchRules, validate, controller.addBatch);

// Owner only: adjustments, write-offs, ledger history, expired view
router.get('/expired',            authorize('owner'), controller.expiredBatches);
router.get('/movements',          authorize('owner'), movementsQuery, validate, controller.movements);
router.post('/adjust',            authorize('owner'), adjustRules, validate, controller.adjust);
router.patch('/batch/:batchId/writeoff', authorize('owner'), uuidParam('batchId'), validate, controller.writeOff);

module.exports = router;
