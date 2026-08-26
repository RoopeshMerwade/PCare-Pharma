// ── Module 23: Supplier Invoices Service
//
// The only layer that touches Supabase, per the module pattern. Two distinct
// jobs live here and it is worth keeping them apart in your head:
//
//   INGEST  — file in, staged draft out. Talks to Storage, to Gemini, and to
//             the staging tables. Writes nothing that is stock.
//   COMMIT  — staged draft in, inventory out. One RPC call. Writes nothing
//             itself; commit_supplier_invoice() owns the transaction.
//
// Between them sits review, which is a series of small PATCHes that each
// re-run the deterministic rules. Warnings are recomputed on every save rather
// than kept in sync by hand — a stale "cost exceeds MRP" badge under a value
// the reviewer already fixed is how a reviewer learns to ignore badges.

const { supabase } = require('../../config/supabase');
const config = require('../../config/env');
const { AppError } = require('../../utils/AppError');
const { mapDbError } = require('../../utils/dbErrors');
const { logAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');
const { extractInvoice, assertExtractionAvailable } = require('./supplier-invoices.extraction');
const {
  normalizeExtraction, normalizeBatchNo, normalizeText,
  descriptionForMatching, rederiveLine,
} = require('./supplier-invoices.normalize');
const { validateItem, validateInvoice, hasBlockingErrors } = require('./supplier-invoices.validate');

const BUCKET = config.invoices.bucket;

/** Trigram score at or above which a catalogue match is applied automatically.
 *  Below it the candidates are still stored, so the picker opens pre-populated
 *  — but the line stays unmapped and therefore blocks import until a human
 *  chooses. Auto-linking a weak match is how the wrong medicine gets stock. */
const AUTO_MATCH_THRESHOLD = 0.45;

/** Today in IST, as YYYY-MM-DD. toISOString() is UTC and rolls the date back
 *  before 05:30 IST, which would let a batch expiring today read as valid. */
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}

// ── READ ──────────────────────────────────────────────────

async function listInvoices({ status, supplierId, page = 1, limit = 30 } = {}) {
  const offset = (page - 1) * limit;
  let q = supabase.from('supplier_invoices_with_counts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq('status', status);
  if (supplierId) q = q.eq('supplier_id', supplierId);

  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch supplier invoices.', 500, 'DB_ERROR');
  return {
    invoices: data,
    pagination: { page, limit, total: count, pages: Math.max(Math.ceil((count || 0) / limit), 1) },
  };
}

async function getInvoiceById(id) {
  const { data, error } = await supabase
    .from('supplier_invoices_with_counts').select('*').eq('id', id).single();
  if (error || !data) throw new AppError('Supplier invoice not found.', 404, 'INVOICE_NOT_FOUND');

  const { data: items, error: itemErr } = await supabase
    .from('supplier_invoice_items')
    .select('*, medicines(id, name, generic_name, manufacturer, unit, default_selling_price)')
    .eq('invoice_id', id)
    .order('line_no');
  if (itemErr) throw new AppError('Failed to fetch invoice lines.', 500, 'DB_ERROR');

  return { ...data, items: items || [] };
}

/**
 * A short-lived signed URL for the original document.
 *
 * The bucket is private and stays private: the review screen renders this URL
 * in an iframe/img and it expires on its own. There is no public path to a
 * distributor's invoice at any point.
 */
async function getDocumentUrl(id) {
  const { data: invoice, error } = await supabase
    .from('supplier_invoices').select('storage_path, file_mime, file_name').eq('id', id).single();
  if (error || !invoice) throw new AppError('Supplier invoice not found.', 404, 'INVOICE_NOT_FOUND');

  const { data, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(invoice.storage_path, config.invoices.signedUrlTtlSeconds);

  if (signErr || !data?.signedUrl) {
    logger.warn({ invoiceId: id, reason: signErr?.message }, 'Failed to sign invoice document URL');
    throw new AppError('The original document could not be opened. It may have been removed from storage.', 502, 'DOCUMENT_UNAVAILABLE');
  }

  return {
    url: data.signedUrl,
    mime: invoice.file_mime,
    file_name: invoice.file_name,
    expires_in: config.invoices.signedUrlTtlSeconds,
  };
}

// ── MATCHING ──────────────────────────────────────────────

/** Trigram candidates for a printed product description. Never throws — a
 *  matching failure must degrade to "unmapped", not fail the whole upload. */
async function matchMedicines(query, limit = 5) {
  const q = normalizeText(query, 200);
  if (!q) return [];
  const { data, error } = await supabase.rpc('match_medicines_trgm', { p_query: q, p_limit: limit });
  if (error) {
    logger.warn({ reason: error.message }, 'Trigram medicine match failed');
    return [];
  }
  return (data || []).map((row) => ({ ...row, score: Number(row.score) }));
}

/**
 * Resolves the printed distributor to a supplier row.
 *
 * GSTIN first and exactly: it is a registration number, so a match on it is
 * certain in a way a name match never is. Only then fall back to the name.
 */
async function resolveSupplier({ gstin, name }) {
  if (gstin) {
    const { data } = await supabase.from('suppliers').select('id, name, gst_no').eq('gst_no', gstin).limit(1);
    if (data?.length) return { supplier: data[0], confidence: 1, source: 'gstin' };
  }
  const q = normalizeText(name, 200);
  if (!q) return { supplier: null, confidence: null, source: null };

  const { data, error } = await supabase.rpc('match_suppliers_trgm', { p_query: q, p_limit: 3 });
  if (error) {
    logger.warn({ reason: error.message }, 'Trigram supplier match failed');
    return { supplier: null, confidence: null, source: null };
  }
  const best = data?.[0];
  if (best && Number(best.score) >= AUTO_MATCH_THRESHOLD) {
    return { supplier: best, confidence: Number(best.score), source: 'name' };
  }
  return { supplier: null, confidence: best ? Number(best.score) : null, source: null };
}

// ── VALIDATION PASS ───────────────────────────────────────

/** Is (medicine, batch) already on the shelf? A repeat would be rejected by
 *  the unique index inside the commit transaction, so it is worth knowing
 *  during review rather than at the moment of approval. */
async function findExistingBatches(items) {
  const pairs = items.filter((i) => i.medicine_id && i.batch_no && !i.is_excluded);
  if (!pairs.length) return new Set();

  const medicineIds = [...new Set(pairs.map((i) => i.medicine_id))];
  const { data, error } = await supabase
    .from('inventory_batches').select('medicine_id, batch_no').in('medicine_id', medicineIds);
  if (error) {
    logger.warn({ reason: error.message }, 'Existing-batch lookup failed; BATCH_EXISTS not checked');
    return new Set();
  }
  return new Set((data || []).map((b) => `${b.medicine_id}::${String(b.batch_no).toUpperCase()}`));
}

/** Has this invoice number already been staged or imported for this supplier? */
async function isDuplicateInvoice({ id, supplier_id, invoice_no }) {
  if (!supplier_id || !invoice_no) return false;
  let q = supabase.from('supplier_invoices')
    .select('id', { head: false })
    .eq('supplier_id', supplier_id)
    .eq('invoice_no_key', invoice_no.trim().toUpperCase())
    .neq('status', 'REJECTED')
    .limit(1);
  if (id) q = q.neq('id', id);

  const { data, error } = await q;
  if (error) {
    logger.warn({ reason: error.message }, 'Duplicate-invoice pre-check failed');
    return false; // the unique index is still the backstop
  }
  return Boolean(data?.length);
}

/**
 * Recomputes every warning on a document and persists them.
 *
 * Called after ingestion and after every review edit, so what the screen shows
 * is always derived from what is currently stored — never from what was true
 * when the file was uploaded.
 */
async function revalidate(invoiceId) {
  const invoice = await getInvoiceById(invoiceId);
  const context = { today: today() };

  const [existingBatches, duplicate] = await Promise.all([
    findExistingBatches(invoice.items),
    isDuplicateInvoice(invoice),
  ]);

  const itemsWithWarnings = invoice.items.map((item) => {
    const warnings = validateItem(item, {
      ...context,
      batchExists:
        Boolean(item.medicine_id && item.batch_no) &&
        existingBatches.has(`${item.medicine_id}::${String(item.batch_no).toUpperCase()}`),
    });
    return {
      ...item,
      warnings,
      // Correcting one field on a 30-line invoice changes that line's warnings
      // and nobody else's. Without this, every blur wrote 30 rows to store 29
      // identical values — and each of those writes fires the updated_at
      // trigger, so the whole invoice looked freshly edited every time.
      _changed: JSON.stringify(warnings) !== JSON.stringify(item.warnings || []),
    };
  });

  const invoiceWarnings = validateInvoice(invoice, itemsWithWarnings, { ...context, duplicateInvoice: duplicate });
  const invoiceChanged =
    JSON.stringify(invoiceWarnings) !== JSON.stringify(invoice.validation_warnings || []);

  // Written back one statement per changed line. There are under fifty lines on
  // any invoice this pharmacy receives, and a bulk upsert would need every
  // column echoed back — which is exactly how an edit gets silently reverted.
  //
  // Persisting is a convenience for the list page's counts; the response below
  // is built from the freshly computed values either way, so a failed write
  // costs a stale badge on the list, never a wrong decision on the review
  // screen. Logged rather than thrown for that reason.
  const writes = await Promise.all([
    ...(invoiceChanged
      ? [supabase.from('supplier_invoices').update({ validation_warnings: invoiceWarnings }).eq('id', invoiceId)]
      : []),
    ...itemsWithWarnings
      .filter((item) => item._changed)
      .map((item) =>
        supabase.from('supplier_invoice_items').update({ warnings: item.warnings }).eq('id', item.id)
      ),
  ]);
  const failed = writes.filter((w) => w.error);
  if (failed.length) {
    logger.warn({ invoiceId, count: failed.length, reason: failed[0].error.message }, 'Persisting validation warnings failed');
  }

  const activeItems = itemsWithWarnings.filter((i) => !i.is_excluded);
  const itemErrorCount = activeItems.reduce(
    (sum, i) => sum + (i.warnings || []).filter((w) => w.severity === 'error').length, 0
  );

  return {
    ...invoice,
    validation_warnings: invoiceWarnings,
    // `_changed` was bookkeeping for the writes above and is not part of the
    // API shape — stripped rather than left to leak into the client.
    items: itemsWithWarnings.map(({ _changed, ...item }) => item),
    // The view's counts were read a moment ago from the PREVIOUS warnings.
    // Recomputed here so a caller never sees a badge that disagrees with the
    // warnings sitting beside it in the same response.
    unmapped_count: activeItems.filter((i) => !i.medicine_id).length,
    item_error_count: itemErrorCount,
    blocking_error_count: invoiceWarnings.filter((w) => w.severity === 'error').length + itemErrorCount,
    can_import: !hasBlockingErrors(invoiceWarnings, itemsWithWarnings),
  };
}

// ── INGEST ────────────────────────────────────────────────

function storagePath(file) {
  const now = new Date();
  const safe = (file.originalname || 'invoice')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-80);
  const stamp = `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${stamp}-${safe}`;
}

/**
 * Upload → read → stage. Synchronous end to end: fewer than 20 invoices a
 * month does not justify a queue, and a queue would put the reviewer's work
 * behind a poll loop for no benefit.
 *
 * @param file    multer memory file { buffer, mimetype, originalname, size }
 * @param body    { supplier_id? } — set when the uploader already knows
 * @param userId  from the JWT, never from the body
 */
async function ingestInvoice(file, { supplier_id } = {}, userId) {
  if (!file?.buffer?.length) {
    throw new AppError('No file was received. Attach the invoice and try again.', 422, 'NO_FILE');
  }
  // Before storage, not after. An unconfigured server should cost nothing —
  // otherwise the 12MB write lands, gets deleted again, and the person is told
  // about a storage problem when the actual problem is a missing API key.
  assertExtractionAvailable();

  const path = storagePath(file);
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

  if (uploadErr) {
    logger.error({ reason: uploadErr.message, bucket: BUCKET }, 'Invoice upload to storage failed');
    if (/bucket/i.test(uploadErr.message || '') && /not found/i.test(uploadErr.message || '')) {
      throw new AppError(
        `The "${BUCKET}" storage bucket does not exist. Run schema-23-supplier-invoices.sql, or create it as a private bucket.`,
        500, 'STORAGE_BUCKET_MISSING'
      );
    }
    throw new AppError('The document could not be stored. Try again.', 502, 'STORAGE_UPLOAD_FAILED');
  }

  let extraction;
  try {
    extraction = await extractInvoice(file.buffer, file.mimetype);
  } catch (err) {
    // Nothing readable came back, so there is no draft to review — leaving the
    // object behind would accumulate unreferenced files nobody can reach.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    throw err;
  }

  const { invoice: header, items } = normalizeExtraction(extraction.raw);

  // An explicitly chosen supplier always wins over the model's reading of the
  // letterhead — the person uploading knows who they bought from.
  let resolvedSupplierId = supplier_id || null;
  if (!resolvedSupplierId) {
    const resolved = await resolveSupplier({ gstin: header.supplier_gstin, name: header.supplier_name_raw });
    resolvedSupplierId = resolved.supplier?.id || null;
  }

  const { data: invoiceRow, error: insertErr } = await supabase
    .from('supplier_invoices')
    .insert({
      ...header,
      supplier_id: resolvedSupplierId,
      status: 'NEEDS_REVIEW',
      storage_path: path,
      file_name: file.originalname || null,
      file_mime: file.mimetype,
      file_size: file.size ?? file.buffer.length,
      raw_extraction: extraction.raw,
      extraction_model: extraction.model,
      extraction_ms: extraction.elapsedMs,
      uploaded_by: userId,
    })
    .select()
    .single();

  if (insertErr) {
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    const mapped = mapDbError(insertErr, {
      duplicateMessage: 'This invoice number has already been recorded for that distributor.',
      duplicateCode: 'DUPLICATE_INVOICE',
    });
    // A duplicate is a normal outcome the uploader caused and is reported to
    // them as a 409. Everything else is an operational fault, and PostgREST's
    // own message is the only thing that names WHICH column is missing — and so
    // which migration was skipped. Logged before the throw for that reason: the
    // client message is deliberately generic, so if this line does not run, the
    // cause exists nowhere.
    if (!mapped || mapped.code !== 'DUPLICATE_INVOICE') {
      logger.error({ reason: insertErr.message, code: insertErr.code }, 'Failed to stage supplier invoice');
    }
    if (mapped) throw mapped;
    throw new AppError('The invoice could not be saved for review.', 500, 'DB_ERROR');
  }

  if (items.length) {
    // Catalogue suggestions, one lookup per line. Serial rather than parallel:
    // a 40-line invoice fanning out 40 concurrent RPCs against a Supabase free
    // tier is how the pool runs out mid-ingest.
    const staged = [];
    for (const item of items) {
      // Matched on the description with its tax-class prefix removed — MARG
      // prints "a CLONAFIT PLUS TAB", and that leading "a " measurably drags
      // the trigram score against a catalogue holding "Clonafit Plus".
      const candidates = await matchMedicines(descriptionForMatching(item.raw_description));
      const best = candidates[0];
      const auto = best && best.score >= AUTO_MATCH_THRESHOLD ? best : null;
      staged.push({
        ...item,
        invoice_id: invoiceRow.id,
        medicine_id: auto?.id || null,
        match_source: auto ? 'auto' : null,
        match_confidence: auto ? Number(auto.score.toFixed(3)) : null,
        match_candidates: candidates.slice(0, 5),
        // Seeded from the catalogue's standard price, never above the printed
        // MRP — inventory_batches CHECKs selling_price <= mrp, so a default
        // that breaches it would make the line un-importable on arrival.
        selling_price:
          auto?.default_selling_price != null && item.mrp != null
            ? Math.min(Number(auto.default_selling_price), Number(item.mrp))
            : auto?.default_selling_price ?? null,
      });
    }

    const { error: itemsErr } = await supabase.from('supplier_invoice_items').insert(staged);
    if (itemsErr) {
      // A header with no lines is a draft that can never be imported and can
      // never be fixed — worse than no draft at all. Unwind it: the FK cascade
      // takes any lines that did land, and the object goes with it.
      await supabase.from('supplier_invoices').delete().eq('id', invoiceRow.id);
      await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
      logger.error({ reason: itemsErr.message, invoiceId: invoiceRow.id }, 'Failed to stage invoice lines');
      throw new AppError('The invoice lines could not be saved for review. Nothing was kept — upload it again.', 500, 'DB_ERROR');
    }
  }

  await logAudit(userId, 'supplier_invoice_uploaded', {
    invoiceId: invoiceRow.id,
    fileName: file.originalname,
    lineCount: items.length,
    model: extraction.model,
    extractionMs: extraction.elapsedMs,
  });
  logger.info(
    { userId, invoiceId: invoiceRow.id, lineCount: items.length, ms: extraction.elapsedMs, usage: extraction.usage },
    'Supplier invoice extracted'
  );

  return await revalidate(invoiceRow.id);
}

// ── REVIEW EDITS ──────────────────────────────────────────

const INVOICE_FIELDS = [
  'supplier_id', 'invoice_no', 'invoice_date',
  'taxable_total', 'gst_total', 'net_total', 'supplier_gstin', 'supplier_dl_no', 'supplier_phone',
];

const ITEM_FIELDS = [
  'medicine_id', 'batch_no', 'mfg_date', 'exp_date',
  'qty_billed', 'qty_free', 'pack_raw',
  'printed_rate', 'printed_mrp', 'discount_pct', 'gst_pct',
  'unit_cost', 'mrp', 'selling_price', 'line_total', 'is_excluded',
];

/** Editing any of these changes what the derived columns should be. Note that
 *  qty_billed is NOT among them: quantity is the stock figure itself and has no
 *  bearing on the per-unit cost, which is exactly the separation this module
 *  got wrong before. */
const DERIVATION_INPUTS = ['pack_raw', 'printed_rate', 'printed_mrp', 'discount_pct'];
/** …unless the reviewer set the answer directly in the same request. A typed
 *  cost is a decision about this specific line and always wins over arithmetic. */
const DERIVED_OUTPUTS = ['unit_cost', 'mrp', 'selling_price'];

/** Only NEEDS_REVIEW is editable. An IMPORTED invoice is a permanent record of
 *  what became stock; a REJECTED one is a permanent record of what did not. */
async function assertEditable(id) {
  const { data, error } = await supabase
    .from('supplier_invoices').select('id, status').eq('id', id).single();
  if (error || !data) throw new AppError('Supplier invoice not found.', 404, 'INVOICE_NOT_FOUND');
  if (data.status !== 'NEEDS_REVIEW') {
    throw new AppError(
      data.status === 'IMPORTED'
        ? 'This invoice has already been imported and can no longer be edited.'
        : 'This invoice was rejected and can no longer be edited.',
      409, 'INVALID_STATUS'
    );
  }
  return data;
}

async function updateInvoice(id, payload, userId) {
  await assertEditable(id);

  const updates = {};
  for (const key of INVOICE_FIELDS) {
    if (payload[key] === undefined) continue;
    updates[key] = payload[key] === '' ? null : payload[key];
  }
  if (typeof updates.invoice_no === 'string') updates.invoice_no = normalizeText(updates.invoice_no, 60);
  if (!Object.keys(updates).length) throw new AppError('No updatable fields.', 422, 'NO_FIELDS');

  const { error } = await supabase.from('supplier_invoices').update(updates).eq('id', id);
  if (error) {
    const mapped = mapDbError(error, {
      duplicateMessage: 'Another invoice with this number is already on file for that distributor.',
      duplicateCode: 'DUPLICATE_INVOICE',
    });
    if (mapped) throw mapped;
    throw new AppError('The invoice could not be updated.', 500, 'DB_ERROR');
  }

  await logAudit(userId, 'supplier_invoice_edited', { invoiceId: id, fields: Object.keys(updates) });
  return await revalidate(id);
}

async function updateItem(invoiceId, itemId, payload, userId) {
  await assertEditable(invoiceId);

  const { data: existing, error: loadErr } = await supabase
    .from('supplier_invoice_items').select('*').eq('id', itemId).eq('invoice_id', invoiceId).single();
  if (loadErr || !existing) throw new AppError('That line is not on this invoice.', 404, 'ITEM_NOT_FOUND');

  const updates = {};
  for (const key of ITEM_FIELDS) {
    if (payload[key] === undefined) continue;
    updates[key] = payload[key] === '' ? null : payload[key];
  }
  if (updates.batch_no !== undefined) updates.batch_no = normalizeBatchNo(updates.batch_no);
  // qty_free is NOT NULL with a default; an explicit null would violate the
  // column rather than "clear" it.
  if (updates.qty_free === null) updates.qty_free = 0;

  // ── Re-derive ──────────────────────────────────────────────────────────
  //
  // Correcting the printed rate or the discount has to move the cost with it.
  // Correcting the pack string re-reads the contents but deliberately changes
  // neither cost nor stock — the Pack column is a description of what is inside
  // a unit, not a multiplier on it.
  //
  // Skipped entirely when the reviewer typed a cost, MRP or price in the same
  // request: they are looking at the paper, and overwriting their number with a
  // computed one would make the field feel broken in exactly the way
  // `useInvoiceReview` was built to prevent.
  const touchedInputs = DERIVATION_INPUTS.some((f) => updates[f] !== undefined);
  const touchedOutputs = DERIVED_OUTPUTS.some((f) => updates[f] !== undefined);
  if (touchedInputs && !touchedOutputs) {
    Object.assign(updates, rederiveLine({ ...existing, ...updates }));
  }

  // A human touching the mapping is a confirmation, and confirmation is what
  // clears LOW_MATCH_CONFIDENCE. Tracked here rather than trusted from the
  // client so the audit trail cannot be talked out of it.
  if (updates.medicine_id !== undefined && updates.medicine_id !== existing.medicine_id) {
    updates.match_source = updates.medicine_id ? 'manual' : null;
    updates.match_confidence = null;
  }

  if (!Object.keys(updates).length) throw new AppError('No updatable fields.', 422, 'NO_FIELDS');

  const { error } = await supabase.from('supplier_invoice_items').update(updates).eq('id', itemId);
  if (error) throw new AppError('The line could not be updated.', 500, 'DB_ERROR');

  await logAudit(userId, 'supplier_invoice_line_edited', {
    invoiceId, itemId, lineNo: existing.line_no, fields: Object.keys(updates),
  });
  return await revalidate(invoiceId);
}

/** Links a line to a medicine that was just created from the review screen.
 *  Separate from updateItem only so the audit entry says what happened. */
async function linkCreatedMedicine(invoiceId, itemId, medicineId, userId) {
  await assertEditable(invoiceId);
  const { error } = await supabase
    .from('supplier_invoice_items')
    .update({ medicine_id: medicineId, match_source: 'created', match_confidence: null })
    .eq('id', itemId).eq('invoice_id', invoiceId);
  if (error) throw new AppError('The line could not be linked to the new medicine.', 500, 'DB_ERROR');
  await logAudit(userId, 'supplier_invoice_medicine_created', { invoiceId, itemId, medicineId });
  return await revalidate(invoiceId);
}

// ── COMMIT ────────────────────────────────────────────────

/**
 * Approve & commit. Owner-only (enforced on the route).
 *
 * The API re-runs validation immediately before calling the RPC. Not because
 * the RPC would let anything through — it re-checks every rule itself — but
 * because a failure here produces the inline, field-anchored message the
 * reviewer can act on, whereas the RPC's is a rolled-back transaction and a
 * mapped code.
 */
async function approveInvoice(id, userId) {
  const state = await revalidate(id);

  if (state.status !== 'NEEDS_REVIEW') {
    throw new AppError(
      state.status === 'IMPORTED'
        ? 'This invoice has already been imported.'
        : 'This invoice was rejected and cannot be imported.',
      409, 'INVALID_STATUS'
    );
  }

  if (!state.can_import) {
    const blocking = [
      ...state.validation_warnings.filter((w) => w.severity === 'error'),
      ...state.items
        .filter((i) => !i.is_excluded)
        .flatMap((i) => (i.warnings || [])
          .filter((w) => w.severity === 'error')
          .map((w) => ({ ...w, line_no: i.line_no }))),
    ];
    throw new AppError(
      'This invoice still has problems that would make the stock wrong. Fix the highlighted lines and try again.',
      422, 'VALIDATION_BLOCKED', { issues: blocking }
    );
  }

  const { data: purchaseId, error } = await supabase.rpc('commit_supplier_invoice', {
    p_invoice_id: id,
    p_user_id: userId,
  });

  if (error) {
    const mapped = mapDbError(error, {
      duplicateMessage: 'One of the batch numbers already exists for that medicine. Nothing was imported.',
      duplicateCode: 'DUPLICATE_BATCH',
    });
    if (mapped) throw mapped;
    logger.error({ reason: error.message, invoiceId: id }, 'commit_supplier_invoice failed');
    throw new AppError('The invoice could not be imported. Nothing was added to stock.', 500, 'DB_ERROR');
  }

  await logAudit(userId, 'supplier_invoice_imported', {
    invoiceId: id,
    purchaseId,
    invoiceNo: state.invoice_no,
    supplierId: state.supplier_id,
    lineCount: state.items.filter((i) => !i.is_excluded).length,
  });
  logger.info({ userId, invoiceId: id, purchaseId }, 'Supplier invoice imported to stock');

  return await getInvoiceById(id);
}

async function rejectInvoice(id, reason, userId) {
  await assertEditable(id);
  const { error } = await supabase
    .from('supplier_invoices')
    .update({ status: 'REJECTED', rejected_reason: normalizeText(reason, 300) })
    .eq('id', id);
  if (error) throw new AppError('The invoice could not be rejected.', 500, 'DB_ERROR');

  await logAudit(userId, 'supplier_invoice_rejected', { invoiceId: id, reason: reason || null });
  return await getInvoiceById(id);
}

module.exports = {
  listInvoices,
  getInvoiceById,
  getDocumentUrl,
  ingestInvoice,
  updateInvoice,
  updateItem,
  linkCreatedMedicine,
  approveInvoice,
  rejectInvoice,
  matchMedicines,
  revalidate,
  AUTO_MATCH_THRESHOLD,
};
