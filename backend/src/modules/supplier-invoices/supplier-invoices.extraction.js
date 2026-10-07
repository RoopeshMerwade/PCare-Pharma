// ── Module 23: Supplier Invoices — Gemini extraction
//
// One call, one document, one JSON answer. Deliberately dependency-free: the
// Generative Language REST API over Node's built-in fetch, so this module adds
// nothing to the deploy surface and cannot drift with an SDK's major version.
//
// The API key lives ONLY here, read from config, and never leaves the process.
// The browser uploads to Express; Express talks to Gemini. There is no path
// that would put a key in a bundle.
//
// Two design choices worth defending:
//
//   · responseSchema, not prompt-and-hope. The model is constrained to emit
//     exactly this shape, so the normaliser downstream deals with wrong VALUES
//     (which a human then fixes) and never with wrong STRUCTURE.
//
//   · explicit nulls for unreadable fields. A model that guesses an unreadable
//     batch number is worse than useless here — a wrong batch number that looks
//     plausible passes review, reaches the ledger, and is then the number a
//     recall is checked against.

const config = require('../../config/env');
const { AppError } = require('../../utils/AppError');
const logger = require('../../utils/logger');

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── The response contract ────────────────────────────────────────────────
// OpenAPI-subset schema, enforced by the API. `nullable` is load-bearing on
// every field: it is what makes "I could not read this" an expressible answer
// rather than something the model has to invent its way around.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    supplier_name:  { type: 'STRING', nullable: true, description: 'Distributor / seller name exactly as printed.' },
    supplier_gstin: { type: 'STRING', nullable: true, description: '15-character GSTIN of the seller, uppercase, no spaces.' },
    supplier_dl_no: { type: 'STRING', nullable: true, description: 'The SELLER\'s drug licence number(s), printed under labels such as "D.L.No.", "DL No", "DL", "Drug Lic. No.", "Drug Licence No." or "20B/21B" on the letterhead. Not the buyer\'s. Transcribe the licence number(s) exactly as printed; when both 20B and 21B numbers are printed, give them together separated by " / ". Null only when no drug licence label or number appears.' },
    supplier_phone: { type: 'STRING', nullable: true, description: 'The SELLER\'s telephone / mobile / landline number printed on the letterhead (labels such as "Ph:", "Phone:", "Mob:", "Tel:", "Contact:"). Digits, spaces, "+" and "-" only, as printed. Not the buyer\'s and not a bank or email detail. Null when none is printed.' },
    supplier_address: { type: 'STRING', nullable: true, description: 'The SELLER\'s postal address from the letterhead, as printed.' },
    supplier_pan:   { type: 'STRING', nullable: true, description: 'The SELLER\'s 10-character PAN, uppercase. Null unless a field labelled PAN is printed.' },
    supplier_email: { type: 'STRING', nullable: true, description: 'The SELLER\'s email address from the letterhead.' },
    supplier_state: { type: 'STRING', nullable: true, description: 'The SELLER\'s state name, e.g. "Karnataka".' },
    supplier_state_code: { type: 'STRING', nullable: true, description: 'The SELLER\'s GST state code, the two digits that begin their GSTIN, e.g. "29". Null unless printed or derivable from a printed GSTIN.' },

    buyer_name:     { type: 'STRING', nullable: true, description: 'The BUYER / consignee / "Billed To" party name — the pharmacy receiving these goods. Not the seller.' },
    buyer_address:  { type: 'STRING', nullable: true, description: 'The BUYER\'s postal address as printed.' },
    buyer_gstin:    { type: 'STRING', nullable: true, description: 'The BUYER\'s 15-character GSTIN, uppercase, no spaces. Not the seller\'s.' },
    buyer_pan:      { type: 'STRING', nullable: true, description: 'The BUYER\'s 10-character PAN, uppercase.' },
    buyer_dl_no:    { type: 'STRING', nullable: true, description: 'The BUYER\'s drug licence number(s), as printed. Not the seller\'s.' },
    buyer_phone:    { type: 'STRING', nullable: true, description: 'The BUYER\'s telephone number as printed.' },
    buyer_state:    { type: 'STRING', nullable: true, description: 'The BUYER\'s state name.' },
    buyer_state_code: { type: 'STRING', nullable: true, description: 'The BUYER\'s two-digit GST state code.' },

    invoice_no:     { type: 'STRING', nullable: true, description: 'Invoice / bill number exactly as printed, taken only from the field labelled Invoice No. or Bill No. in the header.' },
    invoice_date:   { type: 'STRING', nullable: true, description: 'Invoice date as YYYY-MM-DD.' },
    invoice_time:   { type: 'STRING', nullable: true, description: 'Time of day printed beside the invoice date, as HH:MM or HH:MM:SS (24-hour), or as printed with AM/PM. Null unless a time is actually printed.' },
    invoice_type:   { type: 'STRING', nullable: true, description: 'The DOCUMENT type, from its title: "TAX_INVOICE" for a tax invoice/bill/invoice, "CREDIT_NOTE" for a credit note, "DEBIT_NOTE" for a debit note. This describes what the document IS. A payment-terms column reading "Credit" is NOT a credit note — that goes in payment_type.' },
    payment_type:   { type: 'STRING', nullable: true, description: 'The PAYMENT terms, from a field labelled Payment / Terms / Type: "CASH" or "CREDIT". This says whether the pharmacy has paid yet. It never determines invoice_type.' },
    due_date:       { type: 'STRING', nullable: true, description: 'Payment due date as YYYY-MM-DD.' },
    transaction_date: { type: 'STRING', nullable: true, description: 'Transaction / posting date as YYYY-MM-DD, when printed separately from the invoice date.' },
    order_number:   { type: 'STRING', nullable: true, description: 'Purchase order / order number the invoice references.' },
    order_date:     { type: 'STRING', nullable: true, description: 'Order date as YYYY-MM-DD.' },
    lr_number:      { type: 'STRING', nullable: true, description: 'Transport LR / lorry receipt / consignment number.' },
    lr_date:        { type: 'STRING', nullable: true, description: 'LR date as YYYY-MM-DD.' },
    page_number:    { type: 'INTEGER', nullable: true, description: 'This page\'s number, from a "Page 1 of 3" marker.' },
    total_pages:    { type: 'INTEGER', nullable: true, description: 'Total page count, from a "Page 1 of 3" marker.' },
    sales_executive: { type: 'STRING', nullable: true, description: 'Sales representative / executive / agent name printed on the invoice.' },

    subtotal:       { type: 'NUMBER', nullable: true, description: 'Sum of the line gross amounts BEFORE discount and BEFORE tax, from a row labelled Sub Total / Gross / Total Amount.' },
    total_discount: { type: 'NUMBER', nullable: true, description: 'Total discount across the invoice, from a row labelled Discount / Disc. / Less Discount. A positive number.' },
    taxable_total:  { type: 'NUMBER', nullable: true, description: 'Total taxable value before GST, after any discount.' },
    total_cgst:     { type: 'NUMBER', nullable: true, description: 'Total CGST across the invoice.' },
    total_sgst:     { type: 'NUMBER', nullable: true, description: 'Total SGST across the invoice.' },
    total_igst:     { type: 'NUMBER', nullable: true, description: 'Total IGST across the invoice.' },
    total_cess:     { type: 'NUMBER', nullable: true, description: 'Total CESS across the invoice.' },
    gst_total:      { type: 'NUMBER', nullable: true, description: 'Total tax across the invoice (CGST + SGST + IGST + cess) as a single printed figure, when one is printed.' },
    invoice_total:  { type: 'NUMBER', nullable: true, description: 'Taxable value plus tax, BEFORE round-off and before any additional or deduction amount. Null unless printed separately from the net.' },
    additional_amount: { type: 'NUMBER', nullable: true, description: 'Any amount ADDED after tax — freight, packing, other charges. A positive number.' },
    deduction_amount:  { type: 'NUMBER', nullable: true, description: 'Any amount SUBTRACTED after tax, such as a cash discount or TCS deduction. A positive number.' },
    adjustment_amount: { type: 'NUMBER', nullable: true, description: 'A signed adjustment printed on the invoice. Negative when it reduces the payable.' },
    round_off:      { type: 'NUMBER', nullable: true, description: 'The round-off line. SIGNED and usually NEGATIVE, because a payable is more often rounded down than up: if taxable + tax is 11590.21 and the net printed is 11590.00, round_off is -0.21. Transcribe the sign as printed; where only the payable and the pre-round total are printed, give their difference.' },
    net_total:      { type: 'NUMBER', nullable: true, description: 'Final net payable amount — the figure the pharmacy actually owes, after tax, round-off and every adjustment. Labelled Net Amount / Grand Total / Party Total / Bill Amount.' },
    printed_item_count: { type: 'INTEGER', nullable: true, description: 'The line count the invoice states about itself, e.g. a footer reading "Total Item: 20". Null unless such a figure is actually printed — never your own count of the rows.' },

    tax_summary: {
      type: 'ARRAY',
      nullable: true,
      description: 'The invoice\'s own tax / HSN summary block, ONE ENTRY PER TAX RATE. Most invoices carry several rates (5%, 12%, 18%) and each gets its own entry. This is the ONLY place summary rows belong — never as line_items.',
      items: {
        type: 'OBJECT',
        properties: {
          tax_rate:        { type: 'NUMBER', nullable: true, description: 'The TOTAL GST rate for this band as a percentage: 5, 12, 18, 28. Where the block prints CGST 6% and SGST 6% for a band, the rate is 12.' },
          basic_amount:    { type: 'NUMBER', nullable: true, description: 'Gross / basic value in this band, before discount.' },
          discount_amount: { type: 'NUMBER', nullable: true, description: 'Discount within this band.' },
          taxable_amount:  { type: 'NUMBER', nullable: true, description: 'Taxable value in this band, after discount.' },
          cgst_amount:     { type: 'NUMBER', nullable: true, description: 'CGST charged in this band.' },
          sgst_amount:     { type: 'NUMBER', nullable: true, description: 'SGST charged in this band.' },
          igst_amount:     { type: 'NUMBER', nullable: true, description: 'IGST charged in this band.' },
          cess_amount:     { type: 'NUMBER', nullable: true, description: 'CESS charged in this band.' },
          total_tax:       { type: 'NUMBER', nullable: true, description: 'Total tax in this band.' },
        },
        propertyOrdering: ['tax_rate', 'basic_amount', 'discount_amount', 'taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'total_tax'],
      },
    },
    line_items: {
      type: 'ARRAY',
      description: 'One entry per product row in the invoice table. Continuation rows on a multi-page invoice belong to the same list, as do rows under different sub-group headings.',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', nullable: true, description: 'Product name exactly as printed, including strength, form, and any single-letter tax-class prefix that precedes it.' },
          mfg_code:    { type: 'STRING', nullable: true, description: 'Manufacturer code or name from the M.Fg. / Mfr / Company column, exactly as printed. Usually a short abbreviation such as MAN, BLU, LUPI. Do not expand it.' },
          batch_no:    { type: 'STRING', nullable: true, description: 'Batch / lot number as printed.' },
          mfg_date:    { type: 'STRING', nullable: true, description: 'Manufacture date as YYYY-MM or YYYY-MM-DD.' },
          exp_date:    { type: 'STRING', nullable: true, description: 'Expiry as YYYY-MM when only month and year are printed, otherwise YYYY-MM-DD. Do not convert to a day yourself.' },
          qty_billed:  { type: 'INTEGER', nullable: true, description: 'Billed quantity from the Qty column, counted in the units the invoice uses.' },
          qty_free:    { type: 'INTEGER', nullable: true, description: 'Free / scheme quantity, from a Free or Scheme (Sch.) column. 0 when there is none.' },
          pack_raw:    { type: 'STRING', nullable: true, description: 'The Pack column exactly as printed, as text: "10\'S", "100\'S", "100ML", "30GM", "120MD", "7X2ML". Do not convert it to a number and do not tidy it up. It describes what is inside one unit, not how many units there are.' },
          unit_cost:   { type: 'NUMBER', nullable: true, description: 'The Rate / Trade Price column exactly as printed, before GST and before discount. It is the price of ONE unit from the Qty column. Do not convert it to a per-tablet figure.' },
          mrp:         { type: 'NUMBER', nullable: true, description: 'The MRP column exactly as printed. It is the MRP of ONE unit from the Qty column. Do not convert it.' },
          trade_price: { type: 'NUMBER', nullable: true, description: 'The Trade Price / PTR / T.P. column, exactly as printed, when the invoice has one BESIDE the rate column. It is a list price for the trade and is a THIRD figure — do not copy the rate or the MRP into it. Null when no such column exists.' },
          hsn_code:    { type: 'STRING', nullable: true, description: 'The HSN / HSN Code / SAC column, as printed.' },
          discount_pct: { type: 'NUMBER', nullable: true, description: 'Line discount percentage from a Dis. / Disc. % column. Null when the column shows no percentage.' },
          discount_amount: { type: 'NUMBER', nullable: true, description: 'Line discount in RUPEES, from a Dis.Amt / Disc. Amount column. Many invoices print an amount and no percentage — transcribe whichever is there, and both when both are.' },
          taxable_amount: { type: 'NUMBER', nullable: true, description: 'The line\'s taxable value after discount and before tax, from a Taxable / Taxable Value column.' },
          gst_pct:     { type: 'NUMBER', nullable: true, description: 'The line\'s TOTAL GST percentage from a GST % / Tax % column. Where the invoice splits it into CGST 6% and SGST 6%, this is 12.' },
          cgst_pct:    { type: 'NUMBER', nullable: true, description: 'CGST percentage for this line — HALF the total rate on an in-state supply.' },
          cgst_amount: { type: 'NUMBER', nullable: true, description: 'CGST in rupees for this line.' },
          sgst_pct:    { type: 'NUMBER', nullable: true, description: 'SGST percentage for this line — the other half.' },
          sgst_amount: { type: 'NUMBER', nullable: true, description: 'SGST in rupees for this line.' },
          igst_pct:    { type: 'NUMBER', nullable: true, description: 'IGST percentage — the WHOLE rate, on an interstate supply. A line has either IGST or CGST+SGST, never both.' },
          igst_amount: { type: 'NUMBER', nullable: true, description: 'IGST in rupees for this line.' },
          cess_pct:    { type: 'NUMBER', nullable: true, description: 'CESS percentage for this line, when a cess column exists.' },
          cess_amount: { type: 'NUMBER', nullable: true, description: 'CESS in rupees for this line.' },
          line_total:  { type: 'NUMBER', nullable: true, description: 'The line\'s GROSS amount as printed — before discount and before tax. This is the Amount / Gross Amount / Value column. Transcribe it even when it looks inconsistent with the rate — it is used to check the other columns were read correctly.' },
          net_amount:  { type: 'NUMBER', nullable: true, description: 'The line\'s final amount INCLUDING its tax, from a Net Amount / Total column, when the invoice prints one per line. Not the same as line_total.' },
        },
        required: ['description'],
        propertyOrdering: ['description', 'mfg_code', 'hsn_code', 'batch_no', 'mfg_date', 'exp_date', 'qty_billed', 'qty_free', 'pack_raw', 'unit_cost', 'trade_price', 'mrp', 'discount_pct', 'discount_amount', 'taxable_amount', 'gst_pct', 'cgst_pct', 'cgst_amount', 'sgst_pct', 'sgst_amount', 'igst_pct', 'igst_amount', 'cess_pct', 'cess_amount', 'line_total', 'net_amount'],
      },
    },
  },
  required: ['line_items'],
  propertyOrdering: [
    'supplier_name', 'supplier_gstin', 'supplier_dl_no', 'supplier_phone', 'supplier_address', 'supplier_pan', 'supplier_email', 'supplier_state', 'supplier_state_code',
    'buyer_name', 'buyer_address', 'buyer_gstin', 'buyer_pan', 'buyer_dl_no', 'buyer_phone', 'buyer_state', 'buyer_state_code',
    'invoice_no', 'invoice_date', 'invoice_time', 'invoice_type', 'payment_type', 'due_date', 'transaction_date',
    'order_number', 'order_date', 'lr_number', 'lr_date', 'page_number', 'total_pages', 'sales_executive',
    'subtotal', 'total_discount', 'taxable_total', 'total_cgst', 'total_sgst', 'total_igst', 'total_cess', 'gst_total',
    'invoice_total', 'additional_amount', 'deduction_amount', 'adjustment_amount', 'round_off', 'net_total',
    'printed_item_count', 'tax_summary', 'line_items',
  ],
};

const PROMPT = `You are reading an Indian pharmaceutical distributor's tax invoice for a pharmacy's goods-inward desk. Transcribe it. Do not interpret it.

RULES — these override anything the document seems to suggest:

1. NEVER invent, infer or complete a value. If a field is blank, cropped, blurred, smudged or covered by a stamp, return null for it. A null is a correct answer. A plausible guess is a defect: the numbers you return become pharmacy stock, batch traceability and pricing.

2. Transcribe exactly what is printed. Do not correct spellings, expand abbreviations, or normalise a product name to one you recognise. "PARACIP 500 TAB" stays "PARACIP 500 TAB".

3. Expiry dates: return YYYY-MM when only a month and year are printed (the usual case). Return YYYY-MM-DD only when a specific day is actually printed. Never pick a day yourself.

4. Quantities, packs and rates — transcribe, never convert:
   - qty_billed is the Qty column. qty_free is a separate Free/Scheme ("Sch.") column, or 0. This is the number of units being bought — strips, bottles, tubes, inhalers. Never replace it with a number taken from the Pack column.
   - pack_raw is the Pack column copied out as TEXT, exactly as printed: "10'S", "100'S", "100ML", "30GM", "120MD", "7X2ML". Do not turn it into a number, do not work out how many tablets that is, do not tidy the punctuation. The Pack column says what is INSIDE one unit; it never says how many units there are. The suffix carries the whole meaning — 100'S, 100ML, 100GM and 100MD share a digit and describe four different things — so copying the digits alone destroys the information.
   - unit_cost is the Rate / Trade Price column as printed, and mrp is the MRP column as printed. Both are the price of ONE unit from the Qty column. Copy them as they stand. Do NOT divide either by a pack size and do NOT adjust them to agree with anything else on the row.
   - qty_billed and qty_free are SEPARATE and must never be added together. "S.Q 10, F.Q 5" is qty_billed 10 and qty_free 5 — never 15 in either field. The pharmacy paid for ten and received fifteen, and both facts are needed.
   - mrp, unit_cost (the rate) and trade_price are THREE different columns and must never be copied into one another. MRP 28.31 with a rate of 20.22 is normal, not an error to reconcile.
   - discount_pct and gst_pct come from the Dis.% and GST% columns where those columns exist. Where the invoice prints a discount AMOUNT instead of, or as well as, a percentage, put it in discount_amount. Transcribe whichever the invoice actually has; do not convert one into the other.
   - line_total is the printed line amount. Transcribe it even when it looks inconsistent with the rate. It is the cross-check that catches a misread digit, so a helpfully "corrected" line_total destroys the only evidence there is.

4b. TAX COLUMNS — transcribe, never derive:
   - A line carries EITHER cgst/sgst OR igst, never both. In-state supply splits the rate in half (12% GST = CGST 6% + SGST 6%); interstate charges the whole rate as IGST. Copy what is printed; do not work out which one it "should" be.
   - gst_pct is the TOTAL rate for the line. When the invoice only prints CGST 6% and SGST 6%, gst_pct is 12.
   - Do not compute a tax amount that is not printed. A blank tax column is null, not zero.

5. mfg_code is the M.Fg. / Mfr / Company column — usually a short abbreviation such as MAN, BLU, LUPI, ZYD. Copy it as printed. Do not expand it into a company name.

6. Include every product row, across every page, including rows that sit under a sub-heading or group reference part-way down the table — those are still lines of this same invoice.

7. Do NOT return as line items, ever:
   - sub-total, tax-summary, HSN-summary, or CLASS / SUB TOTAL / SCHEME / DISC. / LEVIES rows;
   - freight, round-off, or narrative lines;
   - any "Bill wise outstanding Details" / "Outstanding" / ledger table, usually at the foot of the page. It lists OTHER invoices with their own numbers, dates and amounts, and it looks very much like product data. It is a statement of past dues, not part of this delivery.

   Those summary rows are still WANTED — they just belong somewhere else. The tax / HSN summary block goes in tax_summary, one entry per rate. The footer money goes in subtotal, total_discount, taxable_total, gst_total, round_off, additional_amount, deduction_amount and net_total. Only the outstanding-dues table is discarded outright.

7b. The tax summary block is grouped BY RATE, and an invoice normally has several. A block showing 5%, 12% and 18% bands produces three entries in tax_summary, not one. Never merge bands, and never pick the largest as "the" invoice rate.

7c. invoice_type describes what the DOCUMENT is, read from its title: a "Tax Invoice", "Invoice" or "Bill" is TAX_INVOICE; a "Credit Note" is CREDIT_NOTE; a "Debit Note" is DEBIT_NOTE. payment_type is a different question entirely — it is the payment terms, CASH or CREDIT, usually printed in a small header field. A tax invoice marked "Credit" is a TAX_INVOICE with payment_type CREDIT. It is NOT a credit note, and treating it as one would reverse the direction of the stock it delivers.

7d. round_off is signed and is usually NEGATIVE. If taxable plus tax comes to 11590.21 and the printed payable is 11590.00, round_off is -0.21. Transcribe the sign as printed; where the invoice shows only the two totals, give the difference.

8. invoice_no comes only from the header field labelled "Invoice No." or "Bill No.". A page may also carry group or case references inside the item table, and a list of earlier bill numbers at the foot. None of those is the invoice number.

11. supplier_dl_no is the seller's drug licence number from the letterhead. It appears under many abbreviated labels — "D.L.No.", "DL No.", "D.L.", "DL", "Drug Lic. No.", "Drug Licence No." — and the number itself often carries a 20B / 21B style prefix. Match on any of these labels; transcribe the number(s) exactly as printed.

12. supplier_phone is the seller's phone / mobile / landline from the letterhead, under labels such as "Ph:", "Phone:", "Mob:", "Tel:" or "Contact:". Transcribe the digits exactly as printed. Do not confuse it with the buyer's details or GST-related contact columns.

9. Money values are plain numbers: no currency symbol, no thousands separators.

10. The page may be photographed rather than scanned: rotated, angled, creased or shadowed. Read it in whatever orientation it is in. If a fold or a shadow makes part of a row unreadable, return that row with nulls in the fields you cannot see rather than leaving the row out — a line that is present but blank gets corrected by a human, a line that is missing is never noticed.

If the image is not a distributor invoice at all, return an empty line_items array and nulls throughout.`;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Throws 503 unless the server can read documents at all.
 *
 * Exported because the service calls it BEFORE touching storage. Discovering an
 * unconfigured server only after a 12MB upload has landed means paying for the
 * write, deleting it again, and reporting a storage error for a configuration
 * problem. Cheapest check first.
 */
function assertExtractionAvailable() {
  if (!config.gemini.enabled) {
    throw new AppError(
      'Invoice reading is not configured on this server. Add GEMINI_API_KEY to the backend environment.',
      503, 'EXTRACTION_UNAVAILABLE'
    );
  }
}

async function callGemini(body, { attempt = 1 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gemini.timeoutMs);

  let res;
  try {
    res = await fetch(
      `${API_ROOT}/${encodeURIComponent(config.gemini.model)}:generateContent`,
      {
        method: 'POST',
        // Header, not a query string: a key in a URL ends up in access logs.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new AppError(
        `Reading the document took longer than ${Math.round(config.gemini.timeoutMs / 1000)} seconds. Try a smaller file, or one page at a time.`,
        504, 'EXTRACTION_TIMEOUT'
      );
    }
    throw new AppError('Could not reach the document reading service. Try again in a moment.', 502, 'EXTRACTION_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Logged, never returned: an upstream error body can carry the key back.
    logger.warn({ status: res.status, attempt, detail: detail.slice(0, 500) }, 'Gemini extraction call failed');

    if (RETRYABLE_STATUS.has(res.status) && attempt < config.gemini.maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      return callGemini(body, { attempt: attempt + 1 });
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError('The document reading service rejected this server\'s credentials. Contact the administrator.', 502, 'EXTRACTION_UNAUTHORIZED');
    }
    if (res.status === 429) {
      throw new AppError('The document reading service is rate limiting this pharmacy. Wait a minute and try again.', 429, 'EXTRACTION_RATE_LIMITED');
    }
    // 404 here means the configured model id, not the document — Google retires
    // model versions on notice and this is the shape the retirement takes
    // ("no longer available to new users"). Distinguished from EXTRACTION_FAILED
    // because retrying a different document will not help; every upload fails
    // identically until GEMINI_MODEL is updated. Not in RETRYABLE_STATUS, so this
    // doesn't burn attempts on a config problem first.
    if (res.status === 404) {
      throw new AppError(
        'Invoice reading is misconfigured on this server (unknown model). Contact the administrator.',
        502, 'EXTRACTION_MODEL_UNAVAILABLE'
      );
    }
    throw new AppError('The document could not be read. Try again in a moment.', 502, 'EXTRACTION_FAILED');
  }

  return res.json();
}

/**
 * Reads one invoice document.
 *
 * @param buffer  the file, in memory — never written to disk on this server
 * @param mimeType  application/pdf | image/jpeg | image/png | image/webp
 * @returns { raw, model, elapsedMs } — `raw` is the parsed model JSON, kept
 *          verbatim for the audit trail before any normalisation touches it
 */
async function extractInvoice(buffer, mimeType) {
  assertExtractionAvailable();
  const started = Date.now();

  const payload = await callGemini({
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: config.gemini.maxOutputTokens,
    },
  });

  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) {
    logger.warn({ blockReason }, 'Gemini blocked the invoice document');
    throw new AppError('The document reading service refused this file. Re-scan the invoice and try again.', 422, 'EXTRACTION_BLOCKED');
  }

  const candidate = payload?.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') {
    // The JSON is truncated, so parsing it would yield a silently short list of
    // line items — the one failure mode a reviewer would not notice.
    throw new AppError(
      'The invoice has more lines than can be read in one pass. Split the document and upload it in parts.',
      422, 'EXTRACTION_TRUNCATED'
    );
  }

  const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
  if (!text.trim()) {
    throw new AppError('The document reading service returned nothing for this file.', 502, 'EXTRACTION_EMPTY');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    logger.warn({ sample: text.slice(0, 300) }, 'Gemini returned unparseable JSON despite responseSchema');
    throw new AppError('The document could not be read into a usable form. Try re-scanning it.', 502, 'EXTRACTION_MALFORMED');
  }

  return {
    raw,
    model: config.gemini.model,
    elapsedMs: Date.now() - started,
    usage: payload?.usageMetadata || null,
  };
}

module.exports = { extractInvoice, assertExtractionAvailable, RESPONSE_SCHEMA, PROMPT };
