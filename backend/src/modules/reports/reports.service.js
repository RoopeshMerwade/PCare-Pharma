// ── Module 15: Reports Service — all data computed live, nothing stored

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const {
  getISTDateString,
  getISTMonthStart,
  getISTDaysAgo,
  getISTStartOfDay,
  getISTEndOfDay,
  getISOWeekKey,
} = require('../../utils/date');

// ── SALES REPORT
async function getSalesReport({ dateFrom, dateTo, groupBy = 'day' } = {}) {
  const from = dateFrom || getISTMonthStart();
  const to   = dateTo   || getISTDateString();

  const { data, error } = await supabase
    .from('daily_sales_summary')
    .select('*')
    .gte('sale_date', from)
    .lte('sale_date', to)
    .order('sale_date', { ascending: true });

  if (error) throw new AppError('Failed to generate sales report.', 500, 'DB_ERROR');

  // Aggregate by week or month if requested
  let rows = data;
  if (groupBy === 'week' || groupBy === 'month') {
    const grouped = {};
    data.forEach(r => {
      const key = groupBy === 'week'
        ? getISOWeekKey(r.sale_date)
        : r.sale_date.slice(0, 7);
      if (!grouped[key]) grouped[key] = { period: key, bill_count:0, total_revenue:0, cash_total:0, upi_total:0, credit_total:0, card_total:0 };
      grouped[key].bill_count    += r.bill_count;
      grouped[key].total_revenue += parseFloat(r.total_revenue);
      grouped[key].cash_total    += parseFloat(r.cash_total);
      grouped[key].upi_total     += parseFloat(r.upi_total);
      grouped[key].credit_total  += parseFloat(r.credit_total);
      grouped[key].card_total    += parseFloat(r.card_total);
    });
    rows = Object.values(grouped);
  }

  const totals = rows.reduce((a,r) => ({
    bill_count:    a.bill_count    + (r.bill_count||0),
    total_revenue: a.total_revenue + parseFloat(r.total_revenue||0),
    cash_total:    a.cash_total    + parseFloat(r.cash_total||0),
    upi_total:     a.upi_total     + parseFloat(r.upi_total||0),
    credit_total:  a.credit_total  + parseFloat(r.credit_total||0),
    card_total:    a.card_total    + parseFloat(r.card_total||0),
  }), { bill_count:0, total_revenue:0, cash_total:0, upi_total:0, credit_total:0, card_total:0 });

  return { dateFrom: from, dateTo: to, groupBy, rows, totals, generated_at: new Date().toISOString() };
}

// ── MARGIN ANALYTICS
async function getMarginReport({ categoryId, limit = 50 } = {}) {
  let q = supabase.from('margin_analytics').select('*').order('total_margin_earned', { ascending: false }).limit(limit);
  if (categoryId) q = q.eq('category_name', categoryId);
  const { data, error } = await q;
  if (error) throw new AppError('Failed to generate margin report.', 500, 'DB_ERROR');

  const summary = {
    total_medicines:   data.length,
    total_margin:      data.reduce((s,r) => s + parseFloat(r.total_margin_earned||0), 0),
    avg_margin_pct:    data.length ? data.reduce((s,r) => s + parseFloat(r.avg_margin_pct||0), 0) / data.length : 0,
    total_qty_sold:    data.reduce((s,r) => s + (r.total_qty_sold||0), 0),
  };

  return { medicines: data, summary, generated_at: new Date().toISOString() };
}

// ── VENDOR / PURCHASE REPORT
async function getPurchaseReport({ supplierId, dateFrom, dateTo } = {}) {
  const from = dateFrom || getISTDaysAgo(90);
  const to   = dateTo   || getISTDateString();

  let q = supabase.from('purchases_with_totals').select('*')
    .gte('created_at', getISTStartOfDay(from)).lte('created_at', getISTEndOfDay(to))
    .order('created_at', { ascending: false });
  if (supplierId) q = q.eq('supplier_id', supplierId);

  const { data, error } = await q;
  if (error) throw new AppError('Failed to generate purchase report.', 500, 'DB_ERROR');

  const summary = {
    total_orders:   data.length,
    total_ordered:  data.reduce((s,r) => s + parseFloat(r.ordered_total||0), 0),
    total_received: data.reduce((s,r) => s + parseFloat(r.received_total||0), 0),
    received_count: data.filter(r => r.status === 'received').length,
    pending_count:  data.filter(r => r.status === 'sent').length,
  };

  return { purchases: data, summary, dateFrom: from, dateTo: to, generated_at: new Date().toISOString() };
}

// ── INVENTORY SNAPSHOT
async function getInventoryReport() {
  const { data, error } = await supabase.from('medicines_with_stock').select('*').eq('is_active', true).order('name');
  if (error) throw new AppError('Failed to generate inventory report.', 500, 'DB_ERROR');

  const summary = {
    total_medicines: data.length,
    out_of_stock:    data.filter(m => m.total_stock <= 0).length,
    low_stock:       data.filter(m => m.is_low_stock && m.total_stock > 0).length,
    near_expiry:     data.filter(m => m.near_expiry_batch_count > 0).length,
    healthy:         data.filter(m => !m.is_low_stock && m.total_stock > 0).length,
  };

  return { medicines: data, summary, generated_at: new Date().toISOString() };
}

// ── TOP SELLING MEDICINES (for dashboard widget)
async function getTopMedicines({ dateFrom, dateTo, limit = 10 } = {}) {
  const from = dateFrom || getISTMonthStart();
  const to   = dateTo   || getISTDateString();

  const { data, error } = await supabase.rpc('top_medicines_by_qty', { p_from: from, p_to: to, p_limit: limit }).catch(() => ({ data: null, error: 'rpc not found' }));

  // Fallback: query directly
  if (error || !data) {
    const { data: items } = await supabase.from('bill_items')
      .select('medicine_id, qty, medicines(name, unit)')
      .gte('created_at', getISTStartOfDay(from)).lte('created_at', getISTEndOfDay(to));
    const agg = {};
    (items||[]).forEach(i => {
      if (!agg[i.medicine_id]) agg[i.medicine_id] = { medicine_id: i.medicine_id, name: i.medicines?.name, unit: i.medicines?.unit, total_qty: 0 };
      agg[i.medicine_id].total_qty += i.qty;
    });
    return Object.values(agg).sort((a,b) => b.total_qty - a.total_qty).slice(0, limit);
  }
  return data;
}

module.exports = { getSalesReport, getMarginReport, getPurchaseReport, getInventoryReport, getTopMedicines };
