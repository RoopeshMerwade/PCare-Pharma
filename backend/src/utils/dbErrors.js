// ── Translates database errors into operational AppErrors.
// The atomic RPCs raise exceptions as 'CODE: human message'; Postgres also
// surfaces well-known SQLSTATE codes (23505 unique_violation). Raw database
// messages must never reach clients — everything is mapped here.

const { AppError } = require('./AppError');

// code → [httpStatus, apiCode, clientMessage]
const RPC_ERROR_MAP = {
  INSUFFICIENT_STOCK: [409, 'INSUFFICIENT_STOCK', 'Insufficient stock for one of the items.'],
  INVALID_STATUS:     [409, 'INVALID_STATUS', 'This record is not in a valid state for that operation.'],
  NO_ITEMS:           [422, 'NO_ITEMS', 'At least one item is required.'],
  PRICE_EXCEEDS_MRP:  [422, 'PRICE_EXCEEDS_MRP', 'Selling price cannot exceed MRP (Indian pharmacy law).'],
  QTY_EXCEEDS_SOLD:   [422, 'QTY_EXCEEDS_SOLD', 'Total returned quantity cannot exceed quantity sold on the bill.'],
  ITEM_NOT_FOUND:     [404, 'ITEM_NOT_FOUND', 'Item not found on this order.'],
  PURCHASE_NOT_FOUND: [404, 'PURCHASE_NOT_FOUND', 'Purchase order not found.'],
  LEDGER_IMMUTABLE:   [409, 'LEDGER_IMMUTABLE', 'Stock ledger entries can never be modified.'],

  // ── Module 27: loose units. Both are raised by loose_unit_ledger's trigger
  // inside create_bill_atomic, and reaching them means the API's own check was
  // raced — another till opened or sold the same tablets between the FEFO read
  // and the commit. The whole bill rolls back, which is the correct outcome.
  INSUFFICIENT_LOOSE_STOCK: [409, 'INSUFFICIENT_LOOSE_STOCK', 'Not enough loose units for one of the items.'],
  NOT_SPLITTABLE:           [422, 'NOT_SPLITTABLE', 'That batch has no recorded pack contents, so it cannot be sold in single units.'],

  // ── Module 23: commit_supplier_invoice.
  // Every one of these is also checked by the API before the RPC is called, so
  // reaching this table means the check was raced or bypassed. The messages
  // still have to make sense to whoever is standing at the counter.
  INVOICE_NOT_FOUND:     [404, 'INVOICE_NOT_FOUND', 'Supplier invoice not found.'],
  SUPPLIER_REQUIRED:     [422, 'SUPPLIER_REQUIRED', 'Link the invoice to a supplier before importing it.'],
  INVOICE_NO_REQUIRED:   [422, 'INVOICE_NO_REQUIRED', 'The invoice number is required before importing.'],
  UNMAPPED_ITEM:         [422, 'UNMAPPED_ITEM', 'A line is not linked to a catalogue medicine. Nothing was imported.'],
  MISSING_BATCH:         [422, 'MISSING_BATCH', 'A line has no batch number. Nothing was imported.'],
  MISSING_EXPIRY:        [422, 'MISSING_EXPIRY', 'A line has no expiry date. Nothing was imported.'],
  EXPIRED_ITEM:          [422, 'EXPIRED_ITEM', 'A line has already expired and cannot be taken into stock.'],
  INVALID_DATES:         [422, 'INVALID_DATES', 'A line is manufactured on or after its expiry date.'],
  MISSING_MRP:           [422, 'MISSING_MRP', 'A line has no MRP. Nothing was imported.'],
  MISSING_COST:          [422, 'MISSING_COST', 'A line has no purchase cost. Nothing was imported.'],
  MISSING_SELLING_PRICE: [422, 'MISSING_SELLING_PRICE', 'A line has no selling price. Nothing was imported.'],
  MISSING_QTY:           [422, 'MISSING_QTY', 'A line has no quantity. Nothing was imported.'],
  COST_EXCEEDS_MRP:      [422, 'COST_EXCEEDS_MRP', 'A line costs more than its MRP. Check the pack size and rate.'],

  // ── schema-37. The API blocks this before the RPC is reached
  // (INVOICE_TYPE_NOT_IMPORTABLE is a document-level error, so can_import is
  // already false), so arriving here means the check was raced or bypassed.
  // A credit note is not a broken invoice — it is a document describing stock
  // going the other way, which is what Supplier Returns is for, and the
  // message has to say that rather than imply a scanning fault.
  NOT_A_TAX_INVOICE:     [422, 'NOT_A_TAX_INVOICE', 'Only a tax invoice can be taken into stock. Record a credit or debit note under Supplier Returns instead.'],

  // ── schema-38: owner bill deletion. The service checks ownership, the reason
  // and blocking returns before calling the RPC, so reaching these means the
  // check was raced (a return raised, or a bill rung up inside the range, while
  // the owner was confirming) or bypassed. The RPC is the final word.
  FORBIDDEN:          [403, 'FORBIDDEN', 'Only an active owner can delete bills.'],
  REASON_REQUIRED:    [422, 'REASON_REQUIRED', 'Give a reason of at least 5 characters for deleting.'],
  BILL_NOT_FOUND:     [404, 'BILL_NOT_FOUND', 'That bill no longer exists.'],
  BILL_HAS_RETURNS:   [409, 'BILL_HAS_RETURNS', 'A bill with a pending or approved customer return cannot be deleted.'],
  INVALID_DATE_RANGE: [422, 'INVALID_DATE_RANGE', 'The start date must be on or before the end date.'],
  NO_BILLS_IN_RANGE:  [404, 'NO_BILLS_IN_RANGE', 'There are no bills in that date range.'],
  RANGE_CHANGED:      [409, 'RANGE_CHANGED', 'The bills in that range changed since you previewed them. Preview again.'],
  RANGE_TOO_LARGE:    [422, 'RANGE_TOO_LARGE', 'Delete at most 1000 bills at once. Choose a shorter date range.'],
};

// Returns an AppError for a Supabase/Postgres error, or null if unrecognized
// (caller then throws its own contextual DB_ERROR).
function mapDbError(error, { duplicateMessage, duplicateCode = 'DUPLICATE_RESOURCE' } = {}) {
  if (!error) return null;

  if (error.code === '23505') {
    return new AppError(duplicateMessage || 'A record with these details already exists.', 409, duplicateCode);
  }

  // PGRST202: function not found — an atomic-workflow migration was not run
  // (schema-22-atomic-workflows.sql, or schema-23-supplier-invoices.sql for
  // the invoice import). docs/MIGRATION-ORDER.md lists both and their order.
  //
  // PGRST204: column not found in PostgREST's schema cache — the same fault one
  // level down. The table exists but an ALTER-only migration that adds a column
  // the API writes was skipped, so the write is rejected before it reaches
  // Postgres. That is what a database still at schema-23 does to Module 23's
  // ingest, which sends schema-24's supplier_dl_no / printed_item_count.
  // Callers must not report this as a plain DB_ERROR: the operator action is
  // "run the missing migration", and nothing in a generic message says so.
  if (error.code === 'PGRST202' || error.code === 'PGRST204') {
    return new AppError(
      'Server is missing a required database migration — see docs/MIGRATION-ORDER.md. Contact the administrator.',
      500, 'MIGRATION_REQUIRED'
    );
  }

  const match = /^([A-Z_]+):/.exec(error.message || '');
  if (match && RPC_ERROR_MAP[match[1]]) {
    const [status, apiCode, clientMessage] = RPC_ERROR_MAP[match[1]];
    return new AppError(clientMessage, status, apiCode);
  }

  return null;
}

module.exports = { mapDbError };
