// ── Module 06: Suppliers Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

// Flat supplier rows (the shape SuppliersPage renders) with outstanding
// balances merged in from the view. The old primary path queried
// supplier_balances with an embedded join that PostgREST can't resolve on a
// view — it always fell into its fallback, which ignored includeInactive.
async function listSuppliers({ includeInactive = false } = {}) {
  let q = supabase.from('suppliers').select('*').order('name');
  if (!includeInactive) q = q.eq('is_active', true);
  const { data: suppliers, error } = await q;
  if (error) throw new AppError('Failed to fetch suppliers.', 500, 'DB_ERROR');

  // Best-effort balance merge — a view problem must not take the list down.
  const { data: balances } = await supabase.from('supplier_balances').select('supplier_id, total_purchased, total_paid');
  const byId = new Map((balances || []).map(b => [b.supplier_id, b]));
  return suppliers.map(s => ({
    ...s,
    total_purchased: parseFloat(byId.get(s.id)?.total_purchased ?? 0),
    total_paid: parseFloat(byId.get(s.id)?.total_paid ?? 0),
  }));
}

async function getSupplierById(id) {
  const { data, error } = await supabase.from('suppliers').select('*').eq('id', id).single();
  if (error || !data) throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
  return data;
}

async function createSupplier(payload, createdBy) {
  const { name, contact_person, phone, email, gst_no, drug_license_no, credit_terms_days, notes } = payload;
  const { data, error } = await supabase.from('suppliers')
    .insert({ name: name.trim(), contact_person: contact_person?.trim(), phone: phone?.trim(), email: email?.trim()?.toLowerCase(), gst_no: gst_no?.trim()?.toUpperCase(), drug_license_no: drug_license_no?.trim(), credit_terms_days: credit_terms_days || 30, notes: notes?.trim(), created_by: createdBy })
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
  const updates = Object.fromEntries(Object.entries(payload).filter(([k]) => allowed.includes(k) && payload[k] !== undefined).map(([k,v]) => [k, typeof v === 'string' ? v.trim() : v]));
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

module.exports = { listSuppliers, getSupplierById, createSupplier, updateSupplier, setSupplierStatus };
