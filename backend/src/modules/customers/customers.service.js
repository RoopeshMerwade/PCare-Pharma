// ── Module 11: Customers Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const { ilikeTerm } = require('../../utils/postgrest');
const logger = require('../../utils/logger');

async function listCustomers({ search, page = 1, limit = 50, includeInactive = false } = {}) {
  const offset = (page - 1) * limit;
  let q = supabase
    .from('customers_with_stats')
    .select('*', { count: 'exact' })
    .order('name', { ascending: true })
    .range(offset, offset + limit - 1);

  if (!includeInactive) q = q.eq('is_active', true);
  if (search?.trim()) {
    const term = ilikeTerm(search);
    q = q.or(`name.ilike.${term},phone.ilike.${term},email.ilike.${term}`);
  }

  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch customers.', 500, 'DB_ERROR');
  return { customers: data, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function getCustomerById(id) {
  const { data, error } = await supabase.from('customers_with_stats').select('*').eq('id', id).single();
  if (error || !data) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
  return data;
}

async function getCustomerByPhone(phone) {
  const { data } = await supabase.from('customers').select('*').eq('phone', phone).maybeSingle();
  return data; // null if not found
}

async function getCustomerPurchaseHistory(id, { page = 1, limit = 20 } = {}) {
  const customer = await getCustomerById(id);
  // Bills join on phone; a customer without a phone has no linkable history
  // (.eq with null would match nothing anyway — return the empty page honestly).
  if (!customer.phone) {
    return { bills: [], pagination: { page, limit, total: 0, pages: 0 } };
  }
  const offset = (page - 1) * limit;
  const { data, error, count } = await supabase
    .from('bills_with_totals')
    .select('*', { count: 'exact' })
    .eq('customer_phone', customer.phone)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new AppError('Failed to fetch purchase history.', 500, 'DB_ERROR');
  return { bills: data, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function createCustomer({ name, phone, email, date_of_birth, address, notes }, createdBy) {
  if (phone) {
    const existing = await getCustomerByPhone(phone);
    if (existing) throw new AppError(`A customer with phone ${phone} already exists.`, 409, 'DUPLICATE_PHONE');
  }
  const { data, error } = await supabase.from('customers')
    .insert({ name: name.trim(), phone: phone?.trim() || null, email: email?.trim()?.toLowerCase() || null, date_of_birth: date_of_birth || null, address: address?.trim() || null, notes: notes?.trim() || null, created_by: createdBy })
    .select().single();
  if (error) throw new AppError('Failed to create customer.', 500, 'DB_ERROR');
  await logAudit(createdBy, 'customer_created', { customerId: data.id, name: data.name });
  logger.info({ createdBy, customerId: data.id }, 'Customer created');
  return data;
}

async function updateCustomer(id, payload, userId) {
  const allowed = ['name','email','date_of_birth','address','notes'];
  const updates = Object.fromEntries(Object.entries(payload).filter(([k]) => allowed.includes(k) && payload[k] !== undefined).map(([k,v]) => [k, typeof v === 'string' ? v.trim() : v]));
  if (!Object.keys(updates).length) throw new AppError('No updatable fields provided.', 422, 'NO_FIELDS');
  // Phone is immutable after creation — it's the join key for bill history
  if (payload.phone) throw new AppError('Phone number cannot be changed after account creation.', 422, 'PHONE_IMMUTABLE');
  const { data, error } = await supabase.from('customers').update(updates).eq('id', id).select().single();
  if (error) throw new AppError('Failed to update customer.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
  await logAudit(userId, 'customer_updated', { customerId: id });
  return data;
}

async function setCustomerStatus(id, isActive, userId) {
  const { data, error } = await supabase.from('customers').update({ is_active: isActive }).eq('id', id).select().single();
  if (error) throw new AppError('Failed to update customer.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
  await logAudit(userId, isActive ? 'customer_activated' : 'customer_deactivated', { customerId: id });
  return data;
}

module.exports = { listCustomers, getCustomerById, getCustomerByPhone, getCustomerPurchaseHistory, createCustomer, updateCustomer, setCustomerStatus };
