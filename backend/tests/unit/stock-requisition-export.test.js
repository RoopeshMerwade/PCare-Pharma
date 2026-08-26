/**
 * Unit tests — Module 30 export rendering. Pure: no database, no network, no
 * .env. These run with `npx jest tests/unit --runInBand` on a clean checkout.
 *
 * They exist to pin three decisions that are invisible at a glance and
 * expensive to get wrong: what goes into a line total, where unpriced lines
 * end up, and what Excel does to a sheet name.
 */

const {
  groupByVendor,
  vendorTotal,
  sheetName,
  exportFilename,
  presentLine,
  buildWorkbook,
  buildPdf,
  COLUMNS,
  UNSPECIFIED_VENDOR,
} = require('../../src/modules/stock-requisitions/stock-requisitions.export');

const REQUISITION = {
  id: 'r1',
  requisition_number: 'REQ-2026-0007',
  status: 'approved',
  urgency: 'urgent',
  note: 'Two customers turned away today.',
  created_by_name: 'Ravi Kumar',
  created_at: '2026-08-12T09:15:00.000Z',
  reviewed_by_name: 'Owner',
  reviewed_at: '2026-08-12T11:00:00.000Z',
  items: [
    { medicine_name: 'Dolo 650', unit: 'strips', qty: 20, supplier_id: 's2',
      supplier_name: 'Medico Agencies', unit_cost: '103.12', mrp: '120.00',
      price_as_of: '2026-08-01' },
    { medicine_name: 'Azithral 500', unit: 'strips', qty: 5, supplier_id: 's1',
      supplier_name: 'Alpha Pharma', unit_cost: '92.50', mrp: '110.00',
      price_as_of: '2026-07-19' },
    { medicine_name: 'Pan 40', unit: 'strips', qty: 10, supplier_id: 's2',
      supplier_name: 'Medico Agencies', unit_cost: '54.00', mrp: '68.00',
      price_as_of: '2026-08-01' },
    // Never bought before: a name the staff member typed, and no money.
    { medicine_name: 'Zerodol SP', unit: 'strips', qty: 8, supplier_id: null,
      supplier_name: null, unit_cost: null, mrp: null, price_as_of: null },
  ],
};

describe('vendorTotal', () => {
  test('is qty × RATE, never qty × MRP', () => {
    // The fixture is built so the two answers differ: at MRP this would be
    // 2400, at rate it is 2062.40. If anyone ever "fixes" the export to use
    // MRP, this is the test that says no.
    const lines = [{ qty: 20, unit_cost: 103.12, mrp: 120.0 }];
    expect(vendorTotal(lines)).toBeCloseTo(2062.4, 2);
    expect(vendorTotal(lines)).not.toBeCloseTo(2400, 2);
  });

  test('a line with no rate contributes nothing rather than costing zero', () => {
    const lines = [{ qty: 20, unit_cost: 103.12 }, { qty: 8, unit_cost: null }];
    expect(vendorTotal(lines)).toBeCloseTo(2062.4, 2);
  });

  test('numeric strings from the database are treated as numbers', () => {
    // Supabase returns numeric(10,2) as a string. '103.12' + '54.00' must not
    // concatenate.
    expect(vendorTotal([{ qty: 1, unit_cost: '103.12' }, { qty: 1, unit_cost: '54.00' }]))
      .toBeCloseTo(157.12, 2);
  });
});

describe('groupByVendor', () => {
  const raised = '12 Aug 2026';
  const groups = groupByVendor(REQUISITION.items.map((i) => presentLine(i, raised)));

  test('vendors are alphabetical and unpriced lines come LAST', () => {
    expect(groups.map((g) => g.supplier_name)).toEqual([
      'Alpha Pharma', 'Medico Agencies', UNSPECIFIED_VENDOR,
    ]);
  });

  test('lines for one vendor are collected into a single order', () => {
    const medico = groups.find((g) => g.supplier_name === 'Medico Agencies');
    expect(medico.lines.map((l) => l.medicine_name)).toEqual(['Dolo 650', 'Pan 40']);
    expect(medico.total).toBeCloseTo(20 * 103.12 + 10 * 54.0, 2);
  });

  test('the unspecified group carries a zero total, not a NaN', () => {
    const none = groups[groups.length - 1];
    expect(none.supplier_id).toBeNull();
    expect(none.total).toBe(0);
  });

  test('two lines naming the same unpriced distributor form one order', () => {
    // A distributor chosen from the roster with no purchase history has a name
    // and a null id. Bucketing by id would split them into two anonymous halves.
    const out = groupByVendor([
      presentLine({ medicine_name: 'A', qty: 1, supplier_id: null, supplier_name: 'New Traders' }, raised),
      presentLine({ medicine_name: 'B', qty: 2, supplier_id: null, supplier_name: 'New Traders' }, raised),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toHaveLength(2);
  });
});

describe('sheetName', () => {
  test('strips the characters Excel forbids', () => {
    expect(sheetName('A/B\\C:D?E*F[G]H', new Set())).toBe('A B C D E F G H');
  });

  test('truncates at 31 characters', () => {
    const name = sheetName('Sri Venkateshwara Pharma Distributors Gadag', new Set());
    expect(name.length).toBeLessThanOrEqual(31);
  });

  test('de-duplicates two names identical in their first 31 characters', () => {
    // The real crash: exceljs throws on a duplicate sheet name, so a perfectly
    // valid requisition 500s on download.
    const used = new Set();
    const a = sheetName('Sri Venkateshwara Pharma Distributors Gadag', used);
    const b = sheetName('Sri Venkateshwara Pharma Distributors Hubli', used);
    expect(a).not.toBe(b);
    expect(b.length).toBeLessThanOrEqual(31);
  });

  test('an empty or missing name falls back rather than producing ""', () => {
    expect(sheetName(null, new Set())).toBe(UNSPECIFIED_VENDOR);
    expect(sheetName('   ', new Set())).toBe(UNSPECIFIED_VENDOR);
  });
});

describe('exportFilename', () => {
  test('is the requisition number and nothing else', () => {
    // Stable across downloads: a filename carrying a timestamp makes two copies
    // of one document look like two documents.
    expect(exportFilename(REQUISITION, 'xlsx')).toBe('REQ-2026-0007.xlsx');
    expect(exportFilename(REQUISITION, 'pdf')).toBe('REQ-2026-0007.pdf');
  });
});

describe('buildWorkbook', () => {
  test('has a Summary sheet plus one per vendor, unspecified last', async () => {
    const wb = await buildWorkbook(REQUISITION);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Summary', 'Alpha Pharma', 'Medico Agencies', UNSPECIFIED_VENDOR,
    ]);
  });

  test('money cells are NUMBERS with a format, not pre-formatted strings', async () => {
    // This is the entire reason to ship xlsx rather than csv — it is what lets
    // the owner sum, sort and pivot the sheet.
    const wb = await buildWorkbook(REQUISITION);
    const sheet = wb.getWorksheet('Medico Agencies');

    let checked = 0;
    sheet.eachRow((row) => {
      const rate = row.getCell(4);
      if (typeof rate.value === 'number' && rate.numFmt) {
        expect(rate.numFmt).toContain('#,##0.00');
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  test('writes a real workbook a reader can open', async () => {
    const wb = await buildWorkbook(REQUISITION);
    const buffer = await wb.xlsx.writeBuffer();
    expect(buffer.length).toBeGreaterThan(0);
    // xlsx is a zip; every one starts PK.
    expect(Buffer.from(buffer).slice(0, 2).toString('latin1')).toBe('PK');
  });

  test('survives a requisition with no items at all', async () => {
    const wb = await buildWorkbook({ ...REQUISITION, items: [] });
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Summary']);
  });
});

describe('buildPdf', () => {
  /** Collects a PDFDocument to a Buffer without touching the filesystem. */
  const render = (doc) => new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

  test('streams a real PDF', async () => {
    const buffer = await render(buildPdf(REQUISITION));
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('never writes U+20B9 — the standard-14 fonts cannot render it', async () => {
    // WinAnsiEncoding has no rupee sign. Writing one produces a wrong glyph or
    // throws, depending on pdfkit version, and the failure looks like a corrupt
    // download rather than a font problem.
    const buffer = await render(buildPdf(REQUISITION));
    expect(buffer.includes(Buffer.from('₹', 'utf8'))).toBe(false);
    expect(buffer.toString('latin1')).not.toContain('₹');
  });

  test('survives a requisition with no items at all', async () => {
    const buffer = await render(buildPdf({ ...REQUISITION, items: [] }));
    expect(buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('COLUMNS', () => {
  test('carries Rate as well as MRP, in the order the owner reads them', () => {
    expect(COLUMNS.map((c) => c.header)).toEqual([
      'Medicine', 'Qty', 'Vendor', 'Rate', 'MRP', 'Date', 'Total',
    ]);
  });
});
