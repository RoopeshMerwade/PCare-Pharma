// ── Module: Medicines
// ── Role: Service

const { supabase } = require('../../config/supabase');
const { hasLooseUnits } = require('../../config/capabilities');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const { ilikeTerm } = require('../../utils/postgrest');
const logger = require('../../utils/logger');

// Must stay in step with the medicines_unit_check constraint. 'tablets' was
// added by schema-24: PCare counts loose tablets, so a 10'S strip is ten stock
// units, and a per-tablet medicine could not be catalogued at all before it.
const UNITS = ['tablets', 'strips', 'vials', 'bottles', 'tubes', 'packs', 'pcs'];

// What is inside one of those units. Module 23's parsePack() vocabulary, not a
// second one — "100'S" has to mean the same thing on an invoice review screen
// and at the till. Only TABLET/CAPSULE/PIECE can be sold loose (Module 27);
// the rest describe a measured content of a sealed container.
const CONTENT_UNITS = ['TABLET', 'CAPSULE', 'PIECE', 'MCG', 'MG', 'KG', 'GM', 'ML', 'L', 'DOSE', 'IU'];

const SEARCH_BASE_COLUMNS =
  'id, name, generic_name, manufacturer, unit, default_selling_price, category_name, category_color, total_stock';
const SEARCH_PACK_COLUMNS =
  'pack_content_quantity, pack_content_unit, total_loose_stock, loose_sale_supported';

async function searchColumns() {
  return (await hasLooseUnits())
    ? `${SEARCH_BASE_COLUMNS}, ${SEARCH_PACK_COLUMNS}`
    : SEARCH_BASE_COLUMNS;
}

// ── READ ──────────────────────────────────────────────────

async function listMedicines({ categoryId, stockFilter, search, includeInactive = false, page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;

  let query = supabase
    .from('medicines_with_stock')
    .select('*', { count: 'exact' })
    .order('name', { ascending: true })
    .range(offset, offset + limit - 1);

  if (!includeInactive) query = query.eq('is_active', true);
  if (categoryId)       query = query.eq('category_id', categoryId);

  // Stock filter: low | out | ok
  if (stockFilter === 'low') query = query.eq('is_low_stock', true);
  if (stockFilter === 'out') query = query.lte('total_stock', 0);

  // Search across name, generic_name, manufacturer.
  // NOTE: this was previously textSearch('name,generic_name,manufacturer', …)
  // — a comma list is not a real column, so every list request with a search
  // term 500'd. ilike matches the /medicines/search endpoint's behavior.
  if (search?.trim()) {
    const term = ilikeTerm(search);
    query = query.or(`name.ilike.${term},generic_name.ilike.${term},manufacturer.ilike.${term}`);
  }

  const { data, error, count } = await query;
  if (error) throw new AppError('Failed to fetch medicines.', 500, 'DB_ERROR');

  return {
    medicines: data,
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
  };
}

// Quick search for autocomplete — name/generic/manufacturer prefix match
async function searchMedicines(q, { activeOnly = true } = {}) {
  if (!q?.trim()) return [];
  const term = ilikeTerm(q);

  let query = supabase
    .from('medicines_with_stock')
    // The pack columns ride along so the POS can offer single units without a
    // second request per search result — loose_sale_supported is the view's
    // own answer, so the counter and the allocator agree by construction.
    //
    // Omitted entirely where schema-27 has not been run: asking for a column
    // that does not exist fails the WHOLE query, and an empty medicine search
    // means no bill can be started at all. The frontend's supportsLooseSale()
    // reads an absent flag as "not splittable", so the counter degrades to the
    // single quantity box it had before Module 27.
    .select(await searchColumns())
    .or(`name.ilike.${term},generic_name.ilike.${term},manufacturer.ilike.${term}`)
    .order('name', { ascending: true })
    .limit(20);

  if (activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new AppError('Search failed.', 500, 'DB_ERROR');
  return data;
}

async function getMedicineById(id) {
  const { data, error } = await supabase
    .from('medicines_with_stock')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) throw new AppError('Medicine not found.', 404, 'MEDICINE_NOT_FOUND');
  return data;
}

// ── CREATE ────────────────────────────────────────────────

async function createMedicine(payload, createdBy) {
  const { name, generic_name, manufacturer, category_id, unit, default_selling_price, low_stock_threshold, hsn_code, description, pack_content_quantity, pack_content_unit } = payload;

  // Verify category exists and is active
  const { data: cat } = await supabase
    .from('medicine_categories')
    .select('id, is_active')
    .eq('id', category_id)
    .single();

  if (!cat) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');
  if (!cat.is_active) throw new AppError('Cannot assign a deactivated category to a medicine.', 409, 'CATEGORY_INACTIVE');

  const { data, error } = await supabase
    .from('medicines')
    .insert({
      name: name.trim(),
      generic_name: generic_name?.trim(),
      manufacturer: manufacturer?.trim(),
      category_id,
      unit,
      default_selling_price,
      low_stock_threshold: low_stock_threshold ?? 20,
      hsn_code: hsn_code?.trim(),
      description: description?.trim(),
      // What is inside one `unit`. Only meaningful as a pair, so a half-filled
      // answer is stored as no answer rather than as a countable pack of
      // unknown contents — which is what would let a strip be split into an
      // invented number of tablets.
      pack_content_quantity: pack_content_unit ? (pack_content_quantity ?? null) : null,
      pack_content_unit: pack_content_quantity ? (pack_content_unit ?? null) : null,
      created_by: createdBy
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      const packDesc = pack_content_quantity && pack_content_unit
        ? ` (${pack_content_quantity} ${pack_content_unit})`
        : '';
      throw new AppError(`"${name}"${packDesc} from ${manufacturer || 'this manufacturer'} already exists in the catalog.`, 409, 'DUPLICATE_MEDICINE');
    }
    throw new AppError('Failed to create medicine.', 500, 'DB_ERROR');
  }

  await logAudit(createdBy, 'medicine_created', { medicineId: data.id, name: data.name });
  logger.info({ createdBy, medicineId: data.id }, 'Medicine created');
  return data;
}

// ── UPDATE ────────────────────────────────────────────────

async function updateMedicine(id, payload, requestingUserId) {
  const allowed = ['name','generic_name','manufacturer','category_id','unit','default_selling_price','low_stock_threshold','hsn_code','description','pack_content_quantity','pack_content_unit'];
  const updates = Object.fromEntries(
    Object.entries(payload)
      .filter(([k]) => allowed.includes(k) && payload[k] !== undefined)
      .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
  );

  if (Object.keys(updates).length === 0) throw new AppError('No updatable fields provided.', 422, 'NO_FIELDS');

  /* Re-describing the pack while opened stock exists would silently restate
     what those loose units ARE. Eight tablets counted against a strip of 10
     become eight-tenths of a strip of 15 the moment the number changes — same
     row, different meaning, and every price derived from it moves with it.
     The write-off and adjustment paths stay open (the trigger only gates
     positive movements), so the remedy is to clear the loose stock first. */
  const packChanging = updates.pack_content_quantity !== undefined || updates.pack_content_unit !== undefined;
  if (packChanging && !(await hasLooseUnits())) {
    throw new AppError(
      'Pack contents need the loose-units migration (schema-27-loose-units.sql). Nothing was changed.',
      503, 'MIGRATION_REQUIRED'
    );
  }
  if (packChanging) {
    const { data: batches } = await supabase
      .from('batches_with_stock')
      .select('batch_no, loose_qty')
      .eq('medicine_id', id)
      .gt('loose_qty', 0);

    if (batches?.length) {
      const total = batches.reduce((sum, b) => sum + Number(b.loose_qty), 0);
      throw new AppError(
        `${total} loose unit(s) are still open across ${batches.length} batch(es) (${batches.map((b) => b.batch_no).join(', ')}). ` +
        'Sell, write off or adjust them away before changing what a pack contains.',
        409, 'LOOSE_STOCK_OPEN'
      );
    }
  }

  // If category being changed, verify new category is active
  if (updates.category_id) {
    const { data: cat } = await supabase.from('medicine_categories').select('id, is_active').eq('id', updates.category_id).single();
    if (!cat) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');
    if (!cat.is_active) throw new AppError('Cannot assign a deactivated category.', 409, 'CATEGORY_INACTIVE');
  }

  const { data, error } = await supabase
    .from('medicines')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('A medicine with that name from this manufacturer already exists.', 409, 'DUPLICATE_MEDICINE');
    throw new AppError('Failed to update medicine.', 500, 'DB_ERROR');
  }
  if (!data) throw new AppError('Medicine not found.', 404, 'MEDICINE_NOT_FOUND');

  await logAudit(requestingUserId, 'medicine_updated', { medicineId: id, fields: Object.keys(updates) });
  return data;
}

// ── DEACTIVATE / REACTIVATE ───────────────────────────────

async function setActiveStatus(id, isActive, requestingUserId) {
  const { data, error } = await supabase
    .from('medicines')
    .update({ is_active: isActive })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new AppError('Failed to update medicine status.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Medicine not found.', 404, 'MEDICINE_NOT_FOUND');

  const action = isActive ? 'medicine_reactivated' : 'medicine_deactivated';
  await logAudit(requestingUserId, action, { medicineId: id });
  logger.info({ requestedBy: requestingUserId, medicineId: id, isActive }, action);
  return data;
}

// ── ALERTS (used by Owner Dashboard) ─────────────────────

async function getLowStockAlerts() {
  const { data, error } = await supabase
    .from('medicines_with_stock')
    .select('id, name, unit, total_stock, low_stock_threshold, category_name, category_color')
    .eq('is_active', true)
    .eq('is_low_stock', true)
    .order('total_stock', { ascending: true })
    .limit(10);

  if (error) throw new AppError('Failed to fetch low stock alerts.', 500, 'DB_ERROR');
  return data;
}

async function getNearExpiryAlerts() {
  const { data, error } = await supabase
    .from('medicines_with_stock')
    .select('id, name, unit, near_expiry_batch_count, category_name')
    .eq('is_active', true)
    .gt('near_expiry_batch_count', 0)
    .order('near_expiry_batch_count', { ascending: false })
    .limit(10);

  if (error) throw new AppError('Failed to fetch near-expiry alerts.', 500, 'DB_ERROR');
  return data;
}

async function getAlternatives(medicineId) {
  const { data: target, error: targetError } = await supabase
    .from('medicines_with_stock')
    .select('id, name, generic_name, unit, default_selling_price, total_stock, is_low_stock')
    .eq('id', medicineId)
    .single();

  if (targetError || !target) throw new AppError('Medicine not found.', 404, 'MEDICINE_NOT_FOUND');

  if (!target.generic_name?.trim()) {
    return { target, alternatives: [] };
  }

  const cleanGeneric = target.generic_name.trim();

  // Find other active medicines sharing the same generic molecule/composition
  const { data: alternatives, error: altError } = await supabase
    .from('medicines_with_stock')
    .select('id, name, generic_name, manufacturer, unit, default_selling_price, category_name, category_color, total_stock, is_low_stock, low_stock_threshold')
    .eq('is_active', true)
    .neq('id', medicineId)
    .ilike('generic_name', `%${cleanGeneric}%`)
    .order('total_stock', { ascending: false })
    .limit(10);

  if (altError) {
    logger.error({ altError, medicineId }, 'Failed to fetch generic alternatives');
    throw new AppError('Failed to fetch alternatives.', 500, 'DB_ERROR');
  }

  return { target, alternatives: alternatives || [] };
}

module.exports = {
  listMedicines, searchMedicines, getMedicineById, getAlternatives,
  createMedicine, updateMedicine, setActiveStatus,
  getLowStockAlerts, getNearExpiryAlerts, UNITS, CONTENT_UNITS
};
