// ── Billing data access. The only file in this module that touches
// Supabase. No business decisions here — queries in, rows/errors out.

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { mapDbError } = require('../../utils/dbErrors');
const { ilikeTerm } = require('../../utils/postgrest');

async function listBills({ search, paymentMode, dateFrom, dateTo, createdBy, page, limit }) {
  const offset = (page - 1) * limit;
  let q = supabase.from('bills_with_totals').select('*', { count: 'exact' })
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (paymentMode) q = q.eq('payment_mode', paymentMode);
  if (dateFrom)    q = q.gte('created_at', dateFrom);
  if (dateTo)      q = q.lte('created_at', dateTo + 'T23:59:59');
  if (createdBy)   q = q.eq('created_by', createdBy);
  if (search) {
    const term = ilikeTerm(search);
    q = q.or(`customer_name.ilike.${term},customer_phone.ilike.${term},bill_number.ilike.${term}`);
  }
  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch bills.', 500, 'DB_ERROR');
  return { bills: data, count };
}

async function getBillWithTotals(id) {
  const { data, error } = await supabase.from('bills_with_totals').select('*').eq('id', id).single();
  if (error || !data) return null;
  return data;
}

async function getBillItems(billId) {
  const { data } = await supabase.from('bill_items')
    .select('*, medicines(name, unit), inventory_batches(batch_no, exp_date)')
    .eq('bill_id', billId);
  return data || [];
}

async function getBillsInRange(dateFrom, dateTo) {
  const { data, error } = await supabase.from('bills_with_totals')
    .select('payment_mode, total, payment_status')
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo + 'T23:59:59');
  if (error) throw new AppError('Failed to fetch totals.', 500, 'DB_ERROR');
  return data;
}

async function getMedicineName(medicineId) {
  const { data } = await supabase.from('medicines').select('name').eq('id', medicineId).single();
  return data?.name || null;
}

// Single-transaction bill creation: header + items + ledger commit together.
async function createBillAtomic(bill, items) {
  const { data: billId, error } = await supabase.rpc('create_bill_atomic', {
    p_bill: bill,
    p_items: items,
  });
  if (error) {
    const mapped = mapDbError(error);
    if (mapped) throw mapped;
    throw new AppError('Failed to create bill.', 500, 'DB_ERROR');
  }
  return billId;
}

module.exports = {
  listBills, getBillWithTotals, getBillItems, getBillsInRange,
  getMedicineName, createBillAtomic,
};
