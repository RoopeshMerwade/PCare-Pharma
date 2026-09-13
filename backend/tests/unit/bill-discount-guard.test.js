/**
 * createBill refuses a discount larger than the bill. Pure: the repository,
 * the FEFO source, the adherence check and the audit writer are stubbed; the
 * allocation itself is the real fefo.js.
 *
 * bills_with_totals computes total = subtotal − discount with no floor, so the
 * route's only rule (discount >= 0) let any account that can bill store a
 * negative sale.
 */

jest.mock('../../src/modules/billing/billing.repository', () => ({
  createBillAtomic: jest.fn(async () => 'bill-1'),
  getBillWithTotals: jest.fn(async () => ({ id: 'bill-1', bill_number: 'BILL-2026-0001', created_by: 'u1' })),
  getBillItems: jest.fn(async () => []),
  getMedicineName: jest.fn(async () => 'Dolo 650'),
}));
jest.mock('../../src/modules/inventory/inventory.service', () => ({ getAvailableBatchesFEFO: jest.fn() }));
jest.mock('../../src/modules/chronic-care/chronic-care.service', () => ({
  checkAdherenceWarnings: jest.fn(async () => []),
  recordAcknowledgments: jest.fn(),
}));
jest.mock('../../src/utils/audit', () => ({ logAudit: jest.fn() }));

const billing = require('../../src/modules/billing/billing.service');
const repo = require('../../src/modules/billing/billing.repository');
const { getAvailableBatchesFEFO } = require('../../src/modules/inventory/inventory.service');

// m1: strips at ₹18.50, so two of them come to ₹37.00.
const STRIPS = [{ id: 'b1', exp_date: '2027-01-31', selling_price: '18.50', mrp: '20.00', stock_qty: 10 }];
// m2: a ₹10.00 strip of 7 tablets, sold loose at ₹1.43 each.
const TABLETS = [{
  id: 'b2', exp_date: '2027-01-31', selling_price: '10.00', mrp: '10.00',
  stock_qty: 3, sealed_qty: 3, loose_qty: 0, effective_content_quantity: 7, loose_sale_supported: true,
}];

const bill = (overrides) => ({ payment_mode: 'cash', items: [{ medicine_id: 'm1', qty: 2 }], ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  getAvailableBatchesFEFO.mockImplementation(async (medicineId) => (medicineId === 'm2' ? TABLETS : STRIPS));
});

test('a discount larger than the bill is refused before anything is written', async () => {
  await expect(billing.createBill(bill({ discount_amount: 37.01 }), 'u1'))
    .rejects.toMatchObject({ statusCode: 422, code: 'DISCOUNT_EXCEEDS_TOTAL' });
  expect(repo.createBillAtomic).not.toHaveBeenCalled();
});

test('the refusal names both amounts', async () => {
  await expect(billing.createBill(bill({ discount_amount: 50 }), 'u1'))
    .rejects.toThrow('The discount (₹50.00) cannot be more than the bill total (₹37.00).');
});

test.each([
  ['no discount', undefined],
  ['a partial discount', 5],
  ['a discount equal to the bill (a free sale, total ₹0)', 37],
])('%s is accepted', async (_label, discount) => {
  await billing.createBill(bill({ discount_amount: discount }), 'u1');
  expect(repo.createBillAtomic).toHaveBeenCalledTimes(1);
});

test('loose lines count at their per-unit price, compared to the paisa', async () => {
  // Seven tablets at ₹1.43 come to ₹10.01, a sum floating point spells
  // 10.009999999999998. Compared in paise, ₹10.01 fits and ₹10.02 does not.
  const tablets = { items: [{ medicine_id: 'm2', qty: 0, loose_qty: 7 }] };

  await billing.createBill(bill({ ...tablets, discount_amount: 10.01 }), 'u1');
  expect(repo.createBillAtomic).toHaveBeenCalledTimes(1);

  await expect(billing.createBill(bill({ ...tablets, discount_amount: 10.02 }), 'u1'))
    .rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_TOTAL' });
});
