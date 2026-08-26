// ── Module 23: Supplier Invoices
// ── Role: Controller — HTTP only. No business logic, no Supabase.

const svc = require('./supplier-invoices.service');
const medicinesSvc = require('../medicines/medicines.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/postgrest');

const list = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const result = await svc.listInvoices({
    status: req.query.status,
    supplierId: req.query.supplierId,
    page,
    limit,
  });
  return ApiResponse.success(res, result);
});

const getOne = asyncHandler(async (req, res) => {
  const invoice = await svc.getInvoiceById(req.params.id);
  return ApiResponse.success(res, { invoice });
});

const document = asyncHandler(async (req, res) => {
  const doc = await svc.getDocumentUrl(req.params.id);
  return ApiResponse.success(res, doc);
});

// created_by comes from the JWT, never from the body (CLAUDE.md).
const upload = asyncHandler(async (req, res) => {
  const invoice = await svc.ingestInvoice(req.file, { supplier_id: req.body?.supplier_id || null }, req.user.id);
  return ApiResponse.created(res, { invoice }, 'Invoice read. Check the lines before importing.');
});

const update = asyncHandler(async (req, res) => {
  const invoice = await svc.updateInvoice(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, { invoice }, 'Saved.');
});

const updateItem = asyncHandler(async (req, res) => {
  const invoice = await svc.updateItem(req.params.id, req.params.itemId, req.body, req.user.id);
  return ApiResponse.success(res, { invoice }, 'Line saved.');
});

/**
 * Quick Add to Catalogue: create the medicine and link the line in one round
 * trip, so a reviewer never ends up with a new catalogue entry and a line still
 * pointing at nothing. Owner-only — creating medicines is an owner action
 * everywhere else in the app and this is not the place to make an exception.
 */
const createMedicineForItem = asyncHandler(async (req, res) => {
  const medicine = await medicinesSvc.createMedicine(req.body, req.user.id);
  const invoice = await svc.linkCreatedMedicine(req.params.id, req.params.itemId, medicine.id, req.user.id);
  return ApiResponse.created(res, { invoice, medicine }, `${medicine.name} added to the catalogue and linked.`);
});

const matchMedicines = asyncHandler(async (req, res) => {
  const medicines = await svc.matchMedicines(req.query.q, 8);
  return ApiResponse.success(res, { medicines });
});

const approve = asyncHandler(async (req, res) => {
  const invoice = await svc.approveInvoice(req.params.id, req.user.id);
  return ApiResponse.success(res, { invoice }, 'Invoice imported. Stock updated.');
});

const reject = asyncHandler(async (req, res) => {
  const invoice = await svc.rejectInvoice(req.params.id, req.body?.reason, req.user.id);
  return ApiResponse.success(res, { invoice }, 'Invoice rejected.');
});

module.exports = {
  list, getOne, document, upload, update, updateItem,
  createMedicineForItem, matchMedicines, approve, reject,
};
