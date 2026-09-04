/**
 * Hermetic unit tests for medicine duplicate detection and pack content variant handling.
 * Runner: npx jest tests/unit/medicines-duplicate.test.js --runInBand
 */

const { AppError } = require('../../src/utils/AppError');

// We test the service logic and error mapping directly
describe('Medicine Duplicate Detection Unit Tests', () => {
  let medicinesService;
  let mockSupabase;

  beforeEach(() => {
    jest.resetModules();

    mockSupabase = {
      from: jest.fn(),
    };

    jest.mock('../../src/config/supabase', () => ({
      supabase: mockSupabase,
    }));

    jest.mock('../../src/utils/logger', () => {
      const logFn = jest.fn();
      return {
        info: logFn,
        warn: logFn,
        error: logFn,
        debug: logFn,
        child: jest.fn().mockReturnValue({ info: logFn, warn: logFn, error: logFn, debug: logFn }),
      };
    });

    jest.mock('../../src/utils/audit', () => ({
      logAudit: jest.fn().mockResolvedValue(true),
    }));

    medicinesService = require('../../src/modules/medicines/medicines.service');
  });

  test('createMedicine: formats duplicate error message with pack description when 23505 occurs', async () => {
    // 1. Category check succeeds
    const selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: 'cat-1', is_active: true }, error: null }),
      }),
    });

    // 2. Insert throws 23505 (unique constraint violation)
    const insertMock = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
      }),
    });

    mockSupabase.from.mockImplementation((table) => {
      if (table === 'medicine_categories') return { select: selectMock };
      if (table === 'medicines') return { insert: insertMock };
      return {};
    });

    const payload = {
      name: 'Ragi Malt',
      generic_name: 'Malt Drink',
      manufacturer: 'Manna Foods',
      category_id: 'cat-1',
      unit: 'packs',
      default_selling_price: 150,
      pack_content_quantity: 200,
      pack_content_unit: 'GM',
    };

    await expect(medicinesService.createMedicine(payload, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DUPLICATE_MEDICINE',
      message: '"Ragi Malt" (200 GM) from Manna Foods already exists in the catalog.',
    });
  });

  test('createMedicine: formats duplicate error message without pack description for legacy medicines', async () => {
    const selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: 'cat-1', is_active: true }, error: null }),
      }),
    });

    const insertMock = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
      }),
    });

    mockSupabase.from.mockImplementation((table) => {
      if (table === 'medicine_categories') return { select: selectMock };
      if (table === 'medicines') return { insert: insertMock };
      return {};
    });

    const payload = {
      name: 'Paracetamol 500mg',
      generic_name: 'Paracetamol',
      manufacturer: 'Cipla',
      category_id: 'cat-1',
      unit: 'strips',
      default_selling_price: 20,
    };

    await expect(medicinesService.createMedicine(payload, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DUPLICATE_MEDICINE',
      message: '"Paracetamol 500mg" from Cipla already exists in the catalog.',
    });
  });

  test('createMedicine: persists pack contents correctly as a pair', async () => {
    const selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: 'cat-1', is_active: true }, error: null }),
      }),
    });

    let insertedRow = null;
    const insertMock = jest.fn().mockImplementation((row) => {
      insertedRow = row;
      return {
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: { id: 'med-new', ...row },
            error: null,
          }),
        }),
      };
    });

    mockSupabase.from.mockImplementation((table) => {
      if (table === 'medicine_categories') return { select: selectMock };
      if (table === 'medicines') return { insert: insertMock };
      return {};
    });

    const payload = {
      name: 'Ragi Malt',
      generic_name: 'Malt',
      manufacturer: 'Manna',
      category_id: 'cat-1',
      unit: 'packs',
      default_selling_price: 100,
      pack_content_quantity: 500,
      pack_content_unit: 'GM',
    };

    const res = await medicinesService.createMedicine(payload, 'user-1');
    expect(res.id).toBe('med-new');
    expect(insertedRow.pack_content_quantity).toBe(500);
    expect(insertedRow.pack_content_unit).toBe('GM');
  });

  test('createMedicine: different strengths in name (500mg vs 650mg) create distinct records', async () => {
    const selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: 'cat-1', is_active: true }, error: null }),
      }),
    });

    let insertedRow = null;
    const insertMock = jest.fn().mockImplementation((row) => {
      insertedRow = row;
      return {
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: { id: 'med-paracetamol-650', ...row },
            error: null,
          }),
        }),
      };
    });

    mockSupabase.from.mockImplementation((table) => {
      if (table === 'medicine_categories') return { select: selectMock };
      if (table === 'medicines') return { insert: insertMock };
      return {};
    });

    const payload = {
      name: 'Paracetamol 650 MG',
      generic_name: 'Paracetamol',
      manufacturer: 'Cipla',
      category_id: 'cat-1',
      unit: 'strips',
      default_selling_price: 30,
      pack_content_quantity: 10,
      pack_content_unit: 'TABLET',
    };

    const res = await medicinesService.createMedicine(payload, 'user-1');
    expect(res.id).toBe('med-paracetamol-650');
    expect(insertedRow.name).toBe('Paracetamol 650 MG');
  });

  test('updateMedicine: throws DUPLICATE_MEDICINE when 23505 occurs on update', async () => {
    const batchesMock = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          gt: jest.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    };

    const updateMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          }),
        }),
      }),
    });

    mockSupabase.from.mockImplementation((table) => {
      if (table === 'medicines_with_stock') return { select: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue({ data: [{ loose_sale_supported: true }], error: null }) }) };
      if (table === 'batches_with_stock') return batchesMock;
      if (table === 'medicines') return { update: updateMock };
      return {};
    });

    await expect(
      medicinesService.updateMedicine('med-1', { name: 'Ragi Malt', pack_content_quantity: 200 }, 'user-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DUPLICATE_MEDICINE',
    });
  });
});
