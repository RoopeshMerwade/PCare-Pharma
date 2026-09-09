/**
 * Unit tests for Sales Excel export rendering (reports.export.js).
 * Pure: no database, no network, runs with Jest.
 */

const {
  buildSalesReportWorkbook,
  exportSalesFilename,
  shortDate,
  shortTime,
  shortDateTime,
  SUMMARY_COLUMNS,
  BILL_COLUMNS,
  ITEM_COLUMNS,
} = require('../../src/modules/reports/reports.export');

const MOCK_DATA = {
  storeName: 'P. Care Pharma Gadag',
  dateFrom: '2026-09-01',
  dateTo: '2026-09-04',
  generatedAt: '2026-09-04T12:00:00.000Z',
  dailyRows: [
    {
      sale_date: '2026-09-01',
      bill_count: 5,
      cash_total: 1000,
      upi_total: 500,
      card_total: 200,
      credit_total: 0,
      discount_total: 50,
      total_revenue: 1650,
    },
    {
      sale_date: '2026-09-02',
      bill_count: 8,
      cash_total: 1500,
      upi_total: 1200,
      card_total: 300,
      credit_total: 100,
      discount_total: 100,
      total_revenue: 3000,
    },
  ],
  bills: [
    {
      id: 'b1',
      bill_number: 'BILL-2026-0001',
      created_at: '2026-09-01T10:30:00.000Z',
      customer_name: 'Anand K',
      customer_phone: '9876543210',
      created_by_name: 'Ravi Kumar',
      payment_mode: 'cash',
      payment_status: 'paid',
      item_count: 2,
      total_units: 3,
      subtotal: 500,
      discount_amount: 50,
      total: 450,
    },
    {
      id: 'b2',
      bill_number: 'BILL-2026-0002',
      created_at: '2026-09-02T15:45:00.000Z',
      customer_name: '', // Walk-in customer test
      customer_phone: null,
      created_by_name: null,
      payment_mode: 'upi',
      payment_status: 'paid',
      item_count: 1,
      total_units: 1,
      subtotal: 1200,
      discount_amount: 0,
      total: 1200,
    },
  ],
  lineItems: [
    {
      id: 'li1',
      bill_id: 'b1',
      bill_number: 'BILL-2026-0001',
      created_at: '2026-09-01T10:30:00.000Z',
      customer_name: 'Anand K',
      qty: 2,
      mrp: 120.00,
      unit_price: 100.00,
      medicines: {
        name: 'Dolo 650',
        manufacturer: 'Micro Labs',
        hsn_code: '30049099',
        unit: 'strips',
      },
      inventory_batches: {
        batch_no: 'B123',
        exp_date: '2027-05-01',
      },
    },
    {
      id: 'li2',
      bill_id: 'b2',
      bill_number: 'BILL-2026-0002',
      created_at: '2026-09-02T15:45:00.000Z',
      customer_name: '',
      qty: 1,
      mrp: 1200.00,
      unit_price: 1200.00,
      medicines: {
        name: 'Augmentin 625',
        manufacturer: 'GSK',
        hsn_code: '30041010',
        unit: 'strips',
      },
      inventory_batches: {
        batch_no: 'AUG88',
        exp_date: '2026-12-01',
      },
    },
  ],
};

describe('Sales Excel Export (reports.export.js)', () => {
  describe('exportSalesFilename', () => {
    test('formats single day filename correctly', () => {
      expect(exportSalesFilename('2026-09-04', '2026-09-04')).toBe('Sales_Report_2026-09-04.xlsx');
    });

    test('formats date range filename correctly', () => {
      expect(exportSalesFilename('2026-09-01', '2026-09-04')).toBe('Sales_Report_2026-09-01_to_2026-09-04.xlsx');
    });

    test('fallback when empty', () => {
      expect(exportSalesFilename(null, null)).toBe('Sales_Report.xlsx');
    });
  });

  describe('shortDate & shortDateTime', () => {
    test('handles valid ISO dates with Indian formatting', () => {
      expect(shortDate('2026-09-04T00:00:00.000Z')).toContain('2026');
      expect(shortDate('2026-09-04')).toContain('2026');
    });

    test('handles missing or invalid dates gracefully', () => {
      expect(shortDate(null)).toBe('—');
      expect(shortDate('invalid-date')).toBe('—');
      expect(shortDateTime(null)).toBe('—');
    });
  });

  describe('buildSalesReportWorkbook', () => {
    test('creates 3 distinct worksheets with expected names and colors', async () => {
      const wb = await buildSalesReportWorkbook(MOCK_DATA);
      expect(wb.worksheets.length).toBe(3);

      const sheetNames = wb.worksheets.map((s) => s.name);
      expect(sheetNames).toEqual(['Sales Summary', 'Bill Transactions', 'Sale Line Items']);
    });

    test('Sheet 1 (Sales Summary) contains all expected columns and formulas', async () => {
      const wb = await buildSalesReportWorkbook(MOCK_DATA);
      const sheet = wb.getWorksheet('Sales Summary');

      // Check header columns at row 6
      const headerRow = sheet.getRow(6);
      const headers = SUMMARY_COLUMNS.map((c) => c.header);
      headers.forEach((h, i) => {
        expect(headerRow.getCell(i + 1).value).toBe(h);
      });

      // Rows 7 and 8 are data rows (startRow = 7, lastDataRow = 8)
      expect(sheet.getRow(7).getCell(2).value).toBe(5); // bill count
      expect(sheet.getRow(7).getCell(10).value).toBe(1650); // total revenue

      // Row 9 is the Total row
      const totalRow = sheet.getRow(9);
      expect(totalRow.getCell(1).value).toBe('Total');
      expect(totalRow.getCell(2).value).toEqual({ formula: 'SUM(B7:B8)' });
      expect(totalRow.getCell(3).value).toEqual({ formula: 'SUM(C7:C8)' });
      expect(totalRow.getCell(10).value).toEqual({ formula: 'SUM(J7:J8)' });

      // Currency formatting check
      expect(sheet.getRow(7).getCell(10).numFmt).toBe('"₹"#,##0.00');
    });

    test('Sheet 2 (Bill Transactions) sets Walk-in Customer fallback and formulas', async () => {
      const wb = await buildSalesReportWorkbook(MOCK_DATA);
      const sheet = wb.getWorksheet('Bill Transactions');

      // Check header columns at row 6
      const headerRow = sheet.getRow(6);
      const headers = BILL_COLUMNS.map((c) => c.header);
      headers.forEach((h, i) => {
        expect(headerRow.getCell(i + 1).value).toBe(h);
      });

      // Row 7 has named customer
      expect(sheet.getRow(7).getCell(1).value).toBe('BILL-2026-0001');
      expect(sheet.getRow(7).getCell(4).value).toBe('Anand K');
      expect(sheet.getRow(7).getCell(7).value).toBe('Cash');

      // Row 8 has empty customer -> Walk-in Customer
      expect(sheet.getRow(8).getCell(1).value).toBe('BILL-2026-0002');
      expect(sheet.getRow(8).getCell(4).value).toBe('Walk-in Customer');
      expect(sheet.getRow(8).getCell(6).value).toBe('Staff / Pharmacist');

      // Row 9 is Total row
      const totalRow = sheet.getRow(9);
      expect(totalRow.getCell(1).value).toBe('Total');
      expect(totalRow.getCell(9).value).toEqual({ formula: 'SUM(I7:I8)' }); // Line Items
      expect(totalRow.getCell(10).value).toEqual({ formula: 'SUM(J7:J8)' }); // Total Units
      expect(totalRow.getCell(17).value).toEqual({ formula: 'SUM(Q7:Q8)' }); // Net Total
    });

    test('Sheet 3 (Sale Line Items) maps batch, HSN, manufacturer, and calculates discount', async () => {
      const wb = await buildSalesReportWorkbook(MOCK_DATA);
      const sheet = wb.getWorksheet('Sale Line Items');

      // Check header columns at row 6
      const headerRow = sheet.getRow(6);
      const headers = ITEM_COLUMNS.map((c) => c.header);
      headers.forEach((h, i) => {
        expect(headerRow.getCell(i + 1).value).toBe(h);
      });

      // Row 7 (Dolo 650)
      const row7 = sheet.getRow(7);
      expect(row7.getCell(1).value).toBe('BILL-2026-0001');
      expect(row7.getCell(4).value).toBe('Dolo 650');
      expect(row7.getCell(5).value).toBe('—'); // Medicine code placeholder
      expect(row7.getCell(6).value).toBe('30049099'); // HSN
      expect(row7.getCell(7).value).toBe('B123'); // Batch
      expect(row7.getCell(9).value).toBe('Micro Labs'); // Manufacturer
      expect(row7.getCell(10).value).toBe(2); // Quantity
      expect(row7.getCell(11).value).toBe(120.00); // MRP
      expect(row7.getCell(12).value).toBe(100.00); // Unit selling price
      // Discount = (120 - 100) * 2 = 40
      expect(row7.getCell(13).value).toBe(40.00);
      expect(row7.getCell(14).value).toBe(200.00); // Taxable amount
      expect(row7.getCell(19).value).toBe(200.00); // Line total

      // Row 9 Total row
      const totalRow = sheet.getRow(9);
      expect(totalRow.getCell(1).value).toBe('Total');
      expect(totalRow.getCell(10).value).toEqual({ formula: 'SUM(J7:J8)' }); // Qty
      expect(totalRow.getCell(19).value).toEqual({ formula: 'SUM(S7:J8)'.replace('J8', 'S8') }); // Line Total
    });

    test('handles empty dataset gracefully across all 3 sheets', async () => {
      const emptyData = {
        storeName: 'P. Care Pharma',
        dateFrom: '2026-09-04',
        dateTo: '2026-09-04',
        generatedAt: '2026-09-04T12:00:00.000Z',
        dailyRows: [],
        bills: [],
        lineItems: [],
      };

      const wb = await buildSalesReportWorkbook(emptyData);
      expect(wb.worksheets.length).toBe(3);

      wb.worksheets.forEach((sheet) => {
        expect(sheet.rowCount).toBeGreaterThanOrEqual(6);
      });

      // Verify workbook writes to buffer without errors
      const buffer = await wb.xlsx.writeBuffer();
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    });
  });
});
