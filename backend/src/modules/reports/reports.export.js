// ── Module 15: Reports — Sales Excel Export Rendering (pure ExcelJS)
// Kept free of Supabase, Express, and I/O following the pattern in stock-requisitions.export.js.

const ExcelJS = require('exceljs');

const XLSX_MONEY_FMT = '"₹"#,##0.00';
const XLSX_QTY_FMT = '#,##0';
const XLSX_PERCENT_FMT = '0.00%';

/**
 * Format date as "DD MMM YYYY" in Asia/Kolkata timezone.
 */
function shortDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Format time as "HH:mm" in Asia/Kolkata timezone.
 */
function shortTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Format datetime as "DD MMM YYYY, HH:mm" in Asia/Kolkata timezone.
 */
function shortDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${shortDate(value)}, ${shortTime(value)}`;
}

/**
 * Capitalize first letter (e.g. 'cash' -> 'Cash')
 */
function capitalize(str) {
  if (!str) return '—';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generates file name based on date range.
 * Single day: Sales_Report_2026-09-04.xlsx
 * Range: Sales_Report_2026-09-01_to_2026-09-04.xlsx
 */
function exportSalesFilename(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return 'Sales_Report.xlsx';
  if (dateFrom === dateTo) return `Sales_Report_${dateFrom}.xlsx`;
  return `Sales_Report_${dateFrom}_to_${dateTo}.xlsx`;
}

/**
 * Standard styling for report header blocks on each sheet.
 */
function writeReportHeader(sheet, { storeName, reportName, dateFrom, dateTo, generatedAt }) {
  const periodText = dateFrom === dateTo
    ? shortDate(dateFrom)
    : `${shortDate(dateFrom)} to ${shortDate(dateTo)}`;

  const r1 = sheet.addRow([storeName || 'P. Care Pharma']);
  r1.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF1F2937' } };

  const r2 = sheet.addRow([reportName]);
  r2.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF4B5563' } };

  const r3 = sheet.addRow(['Period:', periodText]);
  r3.getCell(1).font = { bold: true };

  const r4 = sheet.addRow(['Generated At:', shortDateTime(generatedAt || new Date())]);
  r4.getCell(1).font = { bold: true };

  sheet.addRow([]); // Blank spacer
}

/**
 * Style header cells: bold font, subtle background fill, bottom border.
 */
function styleHeaderRow(row) {
  row.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF111827' } };
  row.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF3F4F6' },
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      bottom: { style: 'medium', color: { argb: 'FF9CA3AF' } },
      left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    };
  });
}

/**
 * Style summary / total row: bold font, top thin border, bottom double border.
 */
function styleTotalRow(row) {
  row.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF111827' } };
  row.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF111827' } },
      bottom: { style: 'double', color: { argb: 'FF111827' } },
    };
  });
}

// ── SHEET 1: Sales Summary ─────────────────────────────────────────

const SUMMARY_COLUMNS = [
  { header: 'Date',            key: 'sale_date',     width: 15 },
  { header: 'Total Bills',     key: 'bill_count',    width: 13, numFmt: XLSX_QTY_FMT,   numeric: true },
  { header: 'Cash Sales',      key: 'cash_total',    width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'UPI Sales',       key: 'upi_total',     width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Card Sales',      key: 'card_total',    width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Credit Sales',    key: 'credit_total',  width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Total Discounts', key: 'discount_total',width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Taxable Sales',   key: 'taxable_sales', width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'GST',             key: 'gst_total',     width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Total Revenue',   key: 'total_revenue', width: 18, numFmt: XLSX_MONEY_FMT, numeric: true },
];

function buildSheet1SalesSummary(sheet, { storeName, dateFrom, dateTo, generatedAt, dailyRows }) {
  writeReportHeader(sheet, {
    storeName,
    reportName: 'Sales Summary (Daily Overview)',
    dateFrom,
    dateTo,
    generatedAt,
  });

  const headerRowNumber = 6;
  const headerRow = sheet.addRow(SUMMARY_COLUMNS.map((c) => c.header));
  styleHeaderRow(headerRow);

  SUMMARY_COLUMNS.forEach((col, i) => {
    sheet.getColumn(i + 1).width = col.width;
  });

  const rows = dailyRows || [];
  const startRow = headerRowNumber + 1;

  rows.forEach((r) => {
    const row = sheet.addRow([
      shortDate(r.sale_date),
      Number(r.bill_count || 0),
      Number(r.cash_total || 0),
      Number(r.upi_total || 0),
      Number(r.card_total || 0),
      Number(r.credit_total || 0),
      Number(r.discount_total || 0),
      Number(r.total_revenue || 0), // Taxable sales (selling price is tax-inclusive)
      0.00,                        // GST
      Number(r.total_revenue || 0),
    ]);

    SUMMARY_COLUMNS.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (col.numeric) cell.alignment = { horizontal: 'right' };
    });
  });

  const lastDataRow = startRow + rows.length - 1;

  if (rows.length > 0) {
    const totalRow = sheet.addRow([
      'Total',
      { formula: `SUM(B${startRow}:B${lastDataRow})` },
      { formula: `SUM(C${startRow}:C${lastDataRow})` },
      { formula: `SUM(D${startRow}:D${lastDataRow})` },
      { formula: `SUM(E${startRow}:E${lastDataRow})` },
      { formula: `SUM(F${startRow}:F${lastDataRow})` },
      { formula: `SUM(G${startRow}:G${lastDataRow})` },
      { formula: `SUM(H${startRow}:H${lastDataRow})` },
      { formula: `SUM(I${startRow}:I${lastDataRow})` },
      { formula: `SUM(J${startRow}:J${lastDataRow})` },
    ]);

    styleTotalRow(totalRow);
    SUMMARY_COLUMNS.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1);
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (col.numeric) cell.alignment = { horizontal: 'right' };
    });

    sheet.autoFilter = `A${headerRowNumber}:J${lastDataRow}`;
  } else {
    const emptyRow = sheet.addRow(['No sales in this period', '', '', '', '', '', '', '', '', '']);
    emptyRow.font = { italic: true, color: { argb: 'FF6B7280' } };
  }

  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber, xSplit: 0 }];
}

// ── SHEET 2: Bill Transactions ─────────────────────────────────────

const BILL_COLUMNS = [
  { header: 'Bill Number',     key: 'bill_number',     width: 18 },
  { header: 'Bill Date',       key: 'bill_date',       width: 14 },
  { header: 'Bill Time',       key: 'bill_time',       width: 12 },
  { header: 'Customer Name',   key: 'customer_name',   width: 24 },
  { header: 'Customer Phone',  key: 'customer_phone',  width: 16 },
  { header: 'Dispensed By / Pharmacist', key: 'pharmacist', width: 24 },
  { header: 'Payment Mode',    key: 'payment_mode',    width: 15 },
  { header: 'Payment Status',  key: 'payment_status',  width: 15 },
  { header: 'Line Items',      key: 'line_items',      width: 12, numFmt: XLSX_QTY_FMT,   numeric: true },
  { header: 'Total Units',     key: 'total_units',     width: 12, numFmt: XLSX_QTY_FMT,   numeric: true },
  { header: 'Subtotal',        key: 'subtotal',        width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Discount Amount', key: 'discount_amount', width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Taxable Amount',  key: 'taxable_amount',  width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'CGST',            key: 'cgst',            width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'SGST',            key: 'sgst',            width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'GST Amount',      key: 'gst_amount',      width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Net Total',       key: 'net_total',       width: 18, numFmt: XLSX_MONEY_FMT, numeric: true },
];

function buildSheet2BillTransactions(sheet, { storeName, dateFrom, dateTo, generatedAt, bills }) {
  writeReportHeader(sheet, {
    storeName,
    reportName: 'Bill Transactions (Invoice Level)',
    dateFrom,
    dateTo,
    generatedAt,
  });

  const headerRowNumber = 6;
  const headerRow = sheet.addRow(BILL_COLUMNS.map((c) => c.header));
  styleHeaderRow(headerRow);

  BILL_COLUMNS.forEach((col, i) => {
    sheet.getColumn(i + 1).width = col.width;
  });

  const rows = bills || [];
  const startRow = headerRowNumber + 1;

  rows.forEach((b) => {
    const customerName = b.customer_name && b.customer_name.trim() !== ''
      ? b.customer_name.trim()
      : 'Walk-in Customer';

    const subtotal = Number(b.subtotal || 0);
    const discount = Number(b.discount_amount || 0);
    const netTotal = Number(b.total !== undefined ? b.total : (subtotal - discount));

    const row = sheet.addRow([
      b.bill_number,
      shortDate(b.created_at),
      shortTime(b.created_at),
      customerName,
      b.customer_phone || '—',
      b.created_by_name || 'Staff / Pharmacist',
      capitalize(b.payment_mode),
      capitalize(b.payment_status || 'paid'),
      Number(b.item_count || 0),
      Number(b.total_units || b.item_count || 0),
      subtotal,
      discount,
      netTotal, // Taxable amount
      0.00,     // CGST
      0.00,     // SGST
      0.00,     // GST Amount
      netTotal,
    ]);

    BILL_COLUMNS.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (col.numeric) cell.alignment = { horizontal: 'right' };
    });
  });

  const lastDataRow = startRow + rows.length - 1;

  if (rows.length > 0) {
    const totalRow = sheet.addRow([
      'Total', '', '', '', '', '', '', '',
      { formula: `SUM(I${startRow}:I${lastDataRow})` },
      { formula: `SUM(J${startRow}:J${lastDataRow})` },
      { formula: `SUM(K${startRow}:K${lastDataRow})` },
      { formula: `SUM(L${startRow}:L${lastDataRow})` },
      { formula: `SUM(M${startRow}:M${lastDataRow})` },
      { formula: `SUM(N${startRow}:N${lastDataRow})` },
      { formula: `SUM(O${startRow}:O${lastDataRow})` },
      { formula: `SUM(P${startRow}:P${lastDataRow})` },
      { formula: `SUM(Q${startRow}:Q${lastDataRow})` },
    ]);

    styleTotalRow(totalRow);
    BILL_COLUMNS.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1);
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (col.numeric) cell.alignment = { horizontal: 'right' };
    });

    sheet.autoFilter = `A${headerRowNumber}:Q${lastDataRow}`;
  } else {
    const emptyRow = sheet.addRow(['No bills in this period', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    emptyRow.font = { italic: true, color: { argb: 'FF6B7280' } };
  }

  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber, xSplit: 0 }];
}

// ── SHEET 3: Sale Line Items ───────────────────────────────────────

const ITEM_COLUMNS = [
  { header: 'Bill Number',            key: 'bill_number',     width: 18 },
  { header: 'Bill Date & Time',       key: 'bill_date_time',  width: 20 },
  { header: 'Customer Name',          key: 'customer_name',   width: 24 },
  { header: 'Medicine Name',          key: 'medicine_name',   width: 32 },
  { header: 'Medicine Code',          key: 'medicine_code',   width: 16 },
  { header: 'HSN Code',               key: 'hsn_code',        width: 14 },
  { header: 'Batch Number',           key: 'batch_no',        width: 16 },
  { header: 'Expiry Date',            key: 'exp_date',        width: 14 },
  { header: 'Manufacturer / Company', key: 'manufacturer',    width: 26 },
  { header: 'Quantity',               key: 'qty',             width: 12, numFmt: XLSX_QTY_FMT,   numeric: true },
  { header: 'MRP',                    key: 'mrp',             width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Unit Selling Price',     key: 'unit_price',      width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Discount',               key: 'line_discount',   width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Taxable Amount',         key: 'taxable_amount',  width: 16, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'GST %',                  key: 'gst_pct',         width: 12, numFmt: XLSX_PERCENT_FMT, numeric: true },
  { header: 'CGST',                   key: 'cgst',            width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'SGST',                   key: 'sgst',            width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'GST Amount',             key: 'gst_amount',      width: 14, numFmt: XLSX_MONEY_FMT, numeric: true },
  { header: 'Line Total',             key: 'line_total',      width: 18, numFmt: XLSX_MONEY_FMT, numeric: true },
];

function buildSheet3LineItems(sheet, { storeName, dateFrom, dateTo, generatedAt, lineItems }) {
  writeReportHeader(sheet, {
    storeName,
    reportName: 'Sale Line Items (Batch & Product Details)',
    dateFrom,
    dateTo,
    generatedAt,
  });

  const headerRowNumber = 6;
  const headerRow = sheet.addRow(ITEM_COLUMNS.map((c) => c.header));
  styleHeaderRow(headerRow);

  ITEM_COLUMNS.forEach((col, i) => {
    sheet.getColumn(i + 1).width = col.width;
  });

  const rows = lineItems || [];
  const startRow = headerRowNumber + 1;

  rows.forEach((it) => {
    const customerName = it.customer_name && it.customer_name.trim() !== ''
      ? it.customer_name.trim()
      : 'Walk-in Customer';

    const qty = Number(it.qty || 0);
    const mrp = Number(it.mrp || 0);
    const unitPrice = Number(it.unit_price || 0);
    const lineTotal = Number((unitPrice * qty).toFixed(2));
    const discount = (mrp > unitPrice) ? Number(((mrp - unitPrice) * qty).toFixed(2)) : 0;

    const row = sheet.addRow([
      it.bill_number || '—',
      shortDateTime(it.created_at),
      customerName,
      it.medicines?.name || it.medicine_name || '—',
      '—', // Medicine code does not exist in schema
      it.medicines?.hsn_code || it.hsn_code || '—',
      it.inventory_batches?.batch_no || it.batch_no || '—',
      it.inventory_batches?.exp_date ? shortDate(it.inventory_batches.exp_date) : (it.exp_date ? shortDate(it.exp_date) : '—'),
      it.medicines?.manufacturer || it.manufacturer || '—',
      qty,
      mrp,
      unitPrice,
      discount,
      lineTotal, // Taxable amount
      0.00,      // GST %
      0.00,      // CGST
      0.00,      // SGST
      0.00,      // GST Amount
      lineTotal,
    ]);

    ITEM_COLUMNS.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (col.numeric) cell.alignment = { horizontal: 'right' };
    });
  });

  const lastDataRow = startRow + rows.length - 1;

  if (rows.length > 0) {
    const totalRow = sheet.addRow([
      'Total', '', '', '', '', '', '', '', '',
      { formula: `SUM(J${startRow}:J${lastDataRow})` },
      '', '',
      { formula: `SUM(M${startRow}:M${lastDataRow})` },
      { formula: `SUM(N${startRow}:N${lastDataRow})` },
      '',
      { formula: `SUM(P${startRow}:P${lastDataRow})` },
      { formula: `SUM(Q${startRow}:Q${lastDataRow})` },
      { formula: `SUM(R${startRow}:R${lastDataRow})` },
      { formula: `SUM(S${startRow}:S${lastDataRow})` },
    ]);

    styleTotalRow(totalRow);
    ITEM_COLUMNS.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1);
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (col.numeric) cell.alignment = { horizontal: 'right' };
    });

    sheet.autoFilter = `A${headerRowNumber}:S${lastDataRow}`;
  } else {
    const emptyRow = sheet.addRow(['No line items in this period', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    emptyRow.font = { italic: true, color: { argb: 'FF6B7280' } };
  }

  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber, xSplit: 0 }];
}

/**
 * Builds the complete 3-sheet Sales Excel Workbook.
 * Pure rendering function.
 */
async function buildSalesReportWorkbook(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = data.storeName || 'P. Care Pharma';
  workbook.created = new Date();

  // Sheet 1: Sales Summary
  const sheet1 = workbook.addWorksheet('Sales Summary', {
    properties: { tabColor: { argb: 'FF2563EB' } },
  });
  buildSheet1SalesSummary(sheet1, data);

  // Sheet 2: Bill Transactions
  const sheet2 = workbook.addWorksheet('Bill Transactions', {
    properties: { tabColor: { argb: 'FF059669' } },
  });
  buildSheet2BillTransactions(sheet2, data);

  // Sheet 3: Sale Line Items
  const sheet3 = workbook.addWorksheet('Sale Line Items', {
    properties: { tabColor: { argb: 'FFD97706' } },
  });
  buildSheet3LineItems(sheet3, data);

  return workbook;
}

module.exports = {
  buildSalesReportWorkbook,
  exportSalesFilename,
  shortDate,
  shortTime,
  shortDateTime,
  SUMMARY_COLUMNS,
  BILL_COLUMNS,
  ITEM_COLUMNS,
};
