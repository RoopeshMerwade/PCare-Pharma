/**
 * Unit tests — RPC/Postgres error mapping. Pure, no database.
 */

const { mapDbError } = require('../../src/utils/dbErrors');

describe('mapDbError', () => {
  test('maps RPC-raised INSUFFICIENT_STOCK to a 409 AppError', () => {
    const err = mapDbError({ message: 'INSUFFICIENT_STOCK: Batch would go below 0 (current: 2, requested: 5)' });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.isOperational).toBe(true);
  });

  test('maps INVALID_STATUS claim failures to 409', () => {
    const err = mapDbError({ message: 'INVALID_STATUS: only pending returns can be approved' });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('INVALID_STATUS');
  });

  test('maps QTY_EXCEEDS_SOLD over-return errors to 422', () => {
    const err = mapDbError({ message: 'QTY_EXCEEDS_SOLD: total returned quantity exceeds quantity sold on the bill' });
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('QTY_EXCEEDS_SOLD');
    expect(err.message).toBe('Total returned quantity cannot exceed quantity sold on the bill.');
  });

  test('maps unique violations with caller-supplied context', () => {
    const err = mapDbError({ code: '23505', message: 'duplicate key value' },
      { duplicateMessage: 'Batch already exists.', duplicateCode: 'DUPLICATE_BATCH' });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('DUPLICATE_BATCH');
    expect(err.message).toBe('Batch already exists.');
  });

  test('maps missing RPC (migration not run) to MIGRATION_REQUIRED', () => {
    const err = mapDbError({ code: 'PGRST202', message: 'function not found' });
    expect(err.code).toBe('MIGRATION_REQUIRED');
  });

  // The same fault one level down, and the one that actually happened: a
  // database still at schema-23 rejects Module 23's ingest because the header
  // carries schema-24's printed_item_count. Reported as a bare DB_ERROR it says
  // nothing about what to do; the operator action is "run the migration".
  test('maps missing COLUMN (migration not run) to MIGRATION_REQUIRED', () => {
    const err = mapDbError({
      code: 'PGRST204',
      message: "Could not find the 'printed_item_count' column of 'supplier_invoices' in the schema cache",
    });
    expect(err.code).toBe('MIGRATION_REQUIRED');
    expect(err.statusCode).toBe(500);
    // The column name is for the log, never the client.
    expect(err.message).not.toMatch(/printed_item_count/);
  });

  test('never leaks raw database messages: unknown errors return null', () => {
    expect(mapDbError({ message: 'connection reset by peer' })).toBeNull();
    expect(mapDbError(null)).toBeNull();
  });
});
