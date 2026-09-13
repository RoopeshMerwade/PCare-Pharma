// ── Module: Inventory
// ── Role: Controller

const svc = require('./inventory.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/postgrest');

// Overview. `total` used to be `inventory.length` — the length of an unbounded
// fetch. It now lives in `pagination.total` as a real DB count, and the
// catalogue-wide figures the page actually renders are in `stats`.
const overview = asyncHandler(async (req, res) => {
  const { search, categoryId, stock } = req.query;
  const { page, limit } = parsePagination(req.query, { defaultLimit: 30, maxLimit: 100 });
  const result = await svc.getInventoryOverview({ search, categoryId, stockFilter: stock, page, limit });
  return ApiResponse.success(res, result);
});

// Batches for a medicine. The actor decides the columns: staff get no cost or
// supplier fields (A9).
const batchesForMedicine = asyncHandler(async (req, res) => {
  const includeExpired = req.user.role === 'owner' && req.query.includeExpired === 'true';
  const batches = await svc.listBatchesForMedicine(req.params.medicineId, req.user, { includeExpired });
  return ApiResponse.success(res, { batches });
});

// FEFO — for Billing module
const availableBatches = asyncHandler(async (req, res) => {
  const batches = await svc.getAvailableBatchesFEFO(req.params.medicineId);
  return ApiResponse.success(res, { batches });
});

// Single batch
const getBatch = asyncHandler(async (req, res) => {
  const batch = await svc.getBatchById(req.params.batchId);
  return ApiResponse.success(res, { batch });
});

// Expired batches (owner)
const expiredBatches = asyncHandler(async (req, res) => {
  const batches = await svc.getExpiredBatches();
  return ApiResponse.success(res, { batches, total: batches.length });
});

// Add batch + opening stock
const addBatch = asyncHandler(async (req, res) => {
  const reason = req.body.reason || 'purchase_receipt';
  const batch = await svc.addBatch(req.body, req.user.id, reason);
  return ApiResponse.created(res, { batch }, `Batch ${batch.batch_no} added.`);
});

// Adjust stock (owner)
const adjust = asyncHandler(async (req, res) => {
  const entry = await svc.adjustStock(req.body, req.user.id);
  return ApiResponse.success(res, { entry }, 'Stock adjusted.');
});

// Write-off expired (owner)
const writeOff = asyncHandler(async (req, res) => {
  const result = await svc.writeOffExpiredBatch(req.params.batchId, req.user.id);
  return ApiResponse.success(res, result, `Expired batch written off.`);
});

// Ledger movements (owner)
const movements = asyncHandler(async (req, res) => {
  const { batchId, medicineId, reason, page, limit } = req.query;
  const result = await svc.getLedgerMovements({ batchId, medicineId, reason, page: parseInt(page) || 1, limit: Math.min(parseInt(limit) || 50, 100) });
  return ApiResponse.success(res, result);
});

module.exports = { overview, batchesForMedicine, availableBatches, getBatch, expiredBatches, addBatch, adjust, writeOff, movements };
