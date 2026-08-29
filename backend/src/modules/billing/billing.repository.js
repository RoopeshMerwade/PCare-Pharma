// ── Billing data access. The only file in this module that touches
// Supabase. No business decisions here — queries in, rows/errors out.

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { mapDbError } = require('../../utils/dbErrors');
const { ilikeTerm } = require('../../utils/postgrest');
const { getISTStartOfDay, getISTEndOfDay } = require('../../utils/date');

async function listBills({ search, paymentMode, dateFrom, dateTo, createdBy, page, limit }) {
  const offset = (page - 1) * limit;
  let q = supabase.from('bills_with_totals').select('*', { count: 'exact' })
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (paymentMode) q = q.eq('payment_mode', paymentMode);
  if (dateFrom)    q = q.gte('created_at', dateFrom.includes('T') ? dateFrom : getISTStartOfDay(dateFrom));
  if (dateTo)      q = q.lte('created_at', dateTo.includes('T') ? dateTo : getISTEndOfDay(dateTo));
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
    .select('*, medicines(name, unit, pack_content_unit, pack_content_quantity), inventory_batches(batch_no, exp_date)')
    .eq('bill_id', billId);
  return data || [];
}

async function getBillsInRange(dateFrom, dateTo) {
  const from = dateFrom || '1970-01-01';
  const to = dateTo || getISTDateString();
  const { data, error } = await supabase.from('bills_with_totals')
    .select('payment_mode, total, payment_status')
    .gte('created_at', from.includes('T') ? from : getISTStartOfDay(from))
    .lte('created_at', to.includes('T') ? to : getISTEndOfDay(to));
  if (error) throw new AppError('Failed to fetch totals.', 500, 'DB_ERROR');
  return data;
}

async function getSalesTotalsSummary(dateFrom, dateTo) {
  const from = dateFrom || '1970-01-01';
  const to = dateTo || getISTDateString();
  const { data, error } = await supabase.rpc('get_sales_totals_summary', {
    p_from: from,
    p_to: to,
  });
  if (error || !data) {
    const { data: rows } = await supabase.from('daily_sales_summary')
      .select('bill_count, total_revenue, cash_total, upi_total, credit_total, card_total')
      .gte('sale_date', from)
      .lte('sale_date', to);
    const summary = { count: 0, total: 0, cash: 0, upi: 0, credit: 0, card: 0 };
    (rows || []).forEach(r => {
      summary.count += parseInt(r.bill_count || 0, 10);
      summary.total += parseFloat(r.total_revenue || 0);
      summary.cash += parseFloat(r.cash_total || 0);
      summary.upi += parseFloat(r.upi_total || 0);
      summary.credit += parseFloat(r.credit_total || 0);
      summary.card += parseFloat(r.card_total || 0);
    });
    return summary;
  }
  return {
    count: parseInt(data.count || 0, 10),
    total: parseFloat(data.total || 0),
    cash: parseFloat(data.cash || 0),
    upi: parseFloat(data.upi || 0),
    credit: parseFloat(data.credit || 0),
    card: parseFloat(data.card || 0),
  };
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
  getSalesTotalsSummary, getMedicineName, createBillAtomic,
};
