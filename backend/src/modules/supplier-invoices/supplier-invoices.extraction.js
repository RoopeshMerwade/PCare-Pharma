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
//   · temperature 0 and an explicit instruction to emit null. A model that
//     guesses an unreadable batch number is worse than useless here — a wrong
//     batch number that looks plausible passes review, reaches the ledger, and
//     is then the number a recall is checked against.

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
    invoice_no:     { type: 'STRING', nullable: true, description: 'Invoice / bill number exactly as printed, taken only from the field labelled Invoice No. or Bill No. in the header.' },
    invoice_date:   { type: 'STRING', nullable: true, description: 'Invoice date as YYYY-MM-DD.' },
    taxable_total:  { type: 'NUMBER', nullable: true, description: 'Total taxable value before GST, after any discount.' },
    gst_total:      { type: 'NUMBER', nullable: true, description: 'Total GST (CGST + SGST + IGST + cess).' },
    net_total:      { type: 'NUMBER', nullable: true, description: 'Final net payable amount.' },
    printed_item_count: { type: 'INTEGER', nullable: true, description: 'The line count the invoice states about itself, e.g. a footer reading "Total Item: 20". Null unless such a figure is actually printed — never your own count of the rows.' },
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
          discount_pct: { type: 'NUMBER', nullable: true, description: 'Line discount percentage from a Dis. / Disc. % column. Null when the column shows no percentage.' },
          gst_pct:     { type: 'NUMBER', nullable: true, description: 'Line GST percentage from a GST % / Tax % column.' },
          line_total:  { type: 'NUMBER', nullable: true, description: 'Printed amount for this line before GST. Transcribe it even when it looks inconsistent with the rate — it is used to check the other columns were read correctly.' },
        },
        required: ['description'],
        propertyOrdering: ['description', 'mfg_code', 'batch_no', 'mfg_date', 'exp_date', 'qty_billed', 'qty_free', 'pack_raw', 'unit_cost', 'mrp', 'discount_pct', 'gst_pct', 'line_total'],
      },
    },
  },
  required: ['line_items'],
  propertyOrdering: ['supplier_name', 'supplier_gstin', 'supplier_dl_no', 'supplier_phone', 'invoice_no', 'invoice_date', 'taxable_total', 'gst_total', 'net_total', 'printed_item_count', 'line_items'],
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
   - discount_pct and gst_pct come from the Dis.% and GST% columns where those columns exist.
   - line_total is the printed line amount. Transcribe it even when it looks inconsistent with the rate. It is the cross-check that catches a misread digit, so a helpfully "corrected" line_total destroys the only evidence there is.

5. mfg_code is the M.Fg. / Mfr / Company column — usually a short abbreviation such as MAN, BLU, LUPI, ZYD. Copy it as printed. Do not expand it into a company name.

6. Include every product row, across every page, including rows that sit under a sub-heading or group reference part-way down the table — those are still lines of this same invoice.

7. Do NOT return as line items, ever:
   - sub-total, tax-summary, HSN-summary, or CLASS / SUB TOTAL / SCHEME / DISC. / LEVIES rows;
   - freight, round-off, or narrative lines;
   - any "Bill wise outstanding Details" / "Outstanding" / ledger table, usually at the foot of the page. It lists OTHER invoices with their own numbers, dates and amounts, and it looks very much like product data. It is a statement of past dues, not part of this delivery.

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
      // Transcription, not composition. Any sampling temperature above zero is
      // asking the model to be creative about a batch number.
      temperature: 0,
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
