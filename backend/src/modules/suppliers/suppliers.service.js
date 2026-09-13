// ── Module 06: Suppliers Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const { normalizeContactPhone } = require('../../utils/phone');
const { applySearch, paginationMeta } = require('../../utils/postgrest');
const logger = require('../../utils/logger');

// Matches the page's own placeholder — "Search by name, contact or GST…".
const SUPPLIER_SEARCH_COLUMNS = ['name', 'contact_person', 'gst_no'];

/**
 * One page of suppliers with outstanding balances merged in from the view.
 *
 * `search` is new and is a bug fix, not an optimisation: SuppliersPage has
 * always sent one (useResource puts every non-empty filter on the query
 * string) and this function has always ignored it, with no client-side
 * fallback filter either — so typing in that box did nothing at all.
 *
 * Balances are fetched for THIS PAGE's ids only. supplier_balances aggregates
 * every purchase line in the database; pulling all of it to annotate thirty
 * rows was the whole cost of this endpoint. `ids.length <= limit <= 100`, so
 * the .in() is hard-bounded and needs no chunking.
 *
 * The balance merge stays best-effort — a view problem must not take the list
 * down. (The old primary path queried supplier_balances with an embedded join
 * PostgREST can't resolve on a view; it always fell into its fallback, which
 * ignored includeInactive.)
 */
async function listSuppliers({ search, includeInactive = false, page = 1, limit = 30 } = {}) {
  const offset = (page - 1) * limit;

  let q = supabase.from('suppliers')
    .select('*', { count: 'exact' })
    .order('name', { ascending: true })
    .order('id', { ascending: true })   // name is uniquely indexed, but a total order costs nothing
    .range(offset, offset + limit - 1);
  if (!includeInactive) q = q.eq('is_active', true);
  q = applySearch(q, search, SUPPLIER_SEARCH_COLUMNS);

  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch suppliers.', 500, 'DB_ERROR');

  const rows = data || [];
  const ids = rows.map((s) => s.id);
  let byId = new Map();
  if (ids.length) {
    const { data: balances } = await supabase
      .from('supplier_balances')
      .select('supplier_id, total_purchased, total_paid')
      .in('supplier_id', ids);
    byId = new Map((balances || []).map((b) => [b.supplier_id, b]));
  }

  return {
    suppliers: rows.map((s) => ({
      ...s,
      total_purchased: parseFloat(byId.get(s.id)?.total_purchased ?? 0),
      total_paid: parseFloat(byId.get(s.id)?.total_paid ?? 0),
    })),
    pagination: paginationMeta(page, limit, count),
  };
}

/**
 * Just enough to fill a <select>.
 *
 * Five screens fetched the whole supplier list — every column, plus a full
 * supplier_balances aggregation — to render {id, name} options. Not one of
 * them reads phone, gst_no or credit_terms_days.
 *
 * Active only: you cannot raise a new order against a deactivated distributor,
 * which is what every one of these dropdowns is for. Bounded at 500 because a
 * <select> that long is already unusable — if a pharmacy ever passes it, the
 * fix is a search-as-you-type picker, not a bigger list.
 */
async function listSupplierOptions() {
  const { data, error } = await supabase
    .from('suppliers')
    .select('id, name')
    .eq('is_active', true)
    .order('name', { ascending: true })
    .limit(500);
  if (error) throw new AppError('Failed to fetch suppliers.', 500, 'DB_ERROR');
  return data || [];
}

async function getSupplierById(id) {
  const { data, error } = await supabase.from('suppliers').select('*').eq('id', id).single();
  if (error || !data) throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
  return data;
}

async function createSupplier(payload, createdBy) {
  const { name, contact_person, phone, email, gst_no, drug_license_no, credit_terms_days, notes } = payload;
  const { data, error } = await supabase.from('suppliers')
    .insert({ name: name.trim(), contact_person: contact_person?.trim(), phone: normalizeContactPhone(phone), email: email?.trim()?.toLowerCase(), gst_no: gst_no?.trim()?.toUpperCase(), drug_license_no: drug_license_no?.trim(), credit_terms_days: credit_terms_days || 30, notes: notes?.trim(), created_by: createdBy })
    .select().single();
  if (error) {
    if (error.code === '23505') throw new AppError(`Supplier "${name}" already exists.`, 409, 'DUPLICATE_SUPPLIER');
    throw new AppError('Failed to create supplier.', 500, 'DB_ERROR');
  }
  await logAudit(createdBy, 'supplier_created', { supplierId: data.id, name: data.name });
  return data;
}

async function updateSupplier(id, payload, userId) {
  const allowed = ['name','contact_person','phone','email','gst_no','drug_license_no','credit_terms_days','notes'];
  // Phone goes through normalizeContactPhone rather than a plain trim so that
  // clearing the field on the edit form writes NULL, not the empty string the
  // form actually submits — one absent value, not two.
  const clean = (k, v) => (k === 'phone' ? normalizeContactPhone(v) : (typeof v === 'string' ? v.trim() : v));
  const updates = Object.fromEntries(Object.entries(payload).filter(([k]) => allowed.includes(k) && payload[k] !== undefined).map(([k,v]) => [k, clean(k, v)]));
  if (!Object.keys(updates).length) throw new AppError('No updatable fields.', 422, 'NO_FIELDS');
  const { data, error } = await supabase.from('suppliers').update(updates).eq('id', id).select().single();
  if (error) {
    if (error.code === '23505') throw new AppError('A supplier with that name already exists.', 409, 'DUPLICATE_SUPPLIER');
    throw new AppError('Failed to update supplier.', 500, 'DB_ERROR');
  }
  if (!data) throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
  await logAudit(userId, 'supplier_updated', { supplierId: id });
  return data;
}

async function setSupplierStatus(id, isActive, userId) {
  const { data, error } = await supabase.from('suppliers').update({ is_active: isActive }).eq('id', id).select().single();
  if (error) throw new AppError('Failed to update supplier.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
  await logAudit(userId, isActive ? 'supplier_activated' : 'supplier_deactivated', { supplierId: id });
  return data;
}

module.exports = { listSuppliers, listSupplierOptions, getSupplierById, createSupplier, updateSupplier, setSupplierStatus };
