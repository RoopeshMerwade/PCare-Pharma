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

// How many detail rows a report ships. A report is read, not paged through —
// the summary above each table covers the whole range, and the table is the
// worst offenders. Both are response-shaping numbers, not business rules.
const PURCHASE_DETAIL_LIMIT = 100;
const REORDER_LIMIT = 100;

// ── VENDOR / PURCHASE REPORT
async function getPurchaseReport({ supplierId, dateFrom, dateTo, detailLimit = PURCHASE_DETAIL_LIMIT } = {}) {
  const from = dateFrom || getISTDaysAgo(90);
  const to   = dateTo   || getISTDateString();

  const inRange = (columns) => {
    const q = supabase.from('purchases_with_totals').select(columns)
      .gte('created_at', getISTStartOfDay(from)).lte('created_at', getISTEndOfDay(to));
    return supplierId ? q.eq('supplier_id', supplierId) : q;
  };

  const [aggRes, detailRes] = await Promise.all([
    // Whole range, FOUR columns. The summary has to cover every order in the
    // window or the three stat tiles are wrong, and PurchaseFlowCard buckets
    // by month over the same set — a bounded list would silently under-plot
    // the chart, which is worse than a wrong number because it looks right.
    inRange('created_at, ordered_total, received_total, status'),
    inRange('*').order('created_at', { ascending: false }).limit(detailLimit),
  ]);
  if (aggRes.error) throw new AppError('Failed to generate purchase report.', 500, 'DB_ERROR');

  const all = aggRes.data || [];
  const summary = {
    total_orders:   all.length,
    total_ordered:  all.reduce((s,r) => s + parseFloat(r.ordered_total||0), 0),
    total_received: all.reduce((s,r) => s + parseFloat(r.received_total||0), 0),
    received_count: all.filter(r => r.status === 'received').length,
    pending_count:  all.filter(r => r.status === 'sent').length,
  };

  return {
    purchases: detailRes.data || [],   // bounded — the table
    purchases_total: summary.total_orders,
    flow: all,                         // whole range — the chart
    summary, dateFrom: from, dateTo: to, generated_at: new Date().toISOString(),
  };
}

// ── INVENTORY SNAPSHOT
/**
 * Catalogue health, counted in the database, plus the reorder list.
 *
 * This used to fetch the whole active catalogue and make four Array.filter
 * passes over it, and the FRONTEND then filtered the same array again into
 * "Needs reordering". Both halves now happen server-side: five head-counts
 * that move no rows, and one bounded query for the list itself.
 */
async function getInventoryReport({ reorderLimit = REORDER_LIMIT } = {}) {
  const HEAD = { count: 'exact', head: true };
  // A factory: postgrest-js filter methods mutate the builder in place, so a
  // shared instance would have each count inherit the previous one's filters.
  const scope = () => supabase.from('medicines_with_stock').select('*', HEAD).eq('is_active', true);

  const [totalRes, outRes, lowRes, nearRes, reorderRes] = await Promise.all([
    scope(),
    scope().lte('total_stock', 0),
    scope().eq('is_low_stock', true).gt('total_stock', 0),
    scope().gt('near_expiry_batch_count', 0),
    // BOTH halves of the predicate this replaces, deliberately.
    //
    // is_low_stock is `coalesce(total_stock,0) < low_stock_threshold`, which is
    // TRUE at zero stock for any normal threshold — so `is_low_stock` alone
    // looks like it already covers "out of stock". It does not: the column has
    // `check (low_stock_threshold >= 0)`, and at a threshold of 0 a medicine
    // with no stock gives `0 < 0` = FALSE. That row belongs at the top of a
    // reorder list and would have been silently dropped from it.
    supabase.from('medicines_with_stock')
      .select('id, name, unit, category_name, category_color, total_stock, low_stock_threshold, is_low_stock, near_expiry_batch_count', { count: 'exact' })
      .eq('is_active', true)
      .or('is_low_stock.eq.true,total_stock.lte.0')
      .order('total_stock', { ascending: true })
      .order('id', { ascending: true })
      .limit(reorderLimit),
  ]);

  if (totalRes.error) throw new AppError('Failed to generate inventory report.', 500, 'DB_ERROR');

  const total = totalRes.count ?? 0;
  const out   = outRes.count ?? 0;
  const low   = lowRes.count ?? 0;

  return {
    summary: {
      total_medicines: total,
      out_of_stock: out,
      low_stock: low,
      near_expiry: nearRes.count ?? 0,
      // Subtracted rather than counted, and it is exact.
      // `low_stock_threshold` is NOT NULL and total_stock is coalesced, so
      // is_low_stock is a total boolean — {stock <= 0}, {stock > 0 AND low}
      // and {stock > 0 AND NOT low} partition the catalogue with nothing left
      // over. That last set is what `healthy` meant before. Counting it
      // separately would cost a fifth round trip to learn the same number, and
      // would let rounding between five independent counts leave
      // StockHealthCard's bar not summing to the catalogue — the one invariant
      // that card depends on.
      healthy: Math.max(0, total - out - low),
    },
    reorder: reorderRes.data || [],
    reorder_total: reorderRes.count ?? (reorderRes.data || []).length,
    generated_at: new Date().toISOString(),
  };
}

// ── TOP SELLING MEDICINES (for dashboard widget)
async function getTopMedicines({ dateFrom, dateTo, limit = 10 } = {}) {
  const from = dateFrom || getISTMonthStart();
  const to   = dateTo   || getISTDateString();

  let data, error;
  try {
    ({ data, error } = await supabase.rpc('top_medicines_by_qty', { p_from: from, p_to: to, p_limit: limit }));
  } catch (e) {
    error = e;
  }

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

// ── SALES EXPORT DATA
async function getSalesExportData({ dateFrom, dateTo } = {}) {
  const from = dateFrom || getISTMonthStart();
  const to   = dateTo   || getISTDateString();
  const startTz = getISTStartOfDay(from);
  const endTz   = getISTEndOfDay(to);

  // 1. Pharmacy settings (for store name)
  const { data: settingRow } = await supabase
    .from('pharmacy_settings')
    .select('value')
    .eq('key', 'pharmacy_name')
    .single();
  const storeName = settingRow?.value || 'P. Care Pharma';

  // 2. Daily summary rows from daily_sales_summary
  const { data: dailyRows, error: dailyErr } = await supabase
    .from('daily_sales_summary')
    .select('*')
    .gte('sale_date', from)
    .lte('sale_date', to)
    .order('sale_date', { ascending: true });

  if (dailyErr) throw new AppError('Failed to generate sales export.', 500, 'DB_ERROR');

  // 3. Bills in range from bills_with_totals
  const { data: bills, error: billsErr } = await supabase
    .from('bills_with_totals')
    .select('*')
    .gte('created_at', startTz)
    .lte('created_at', endTz)
    .order('created_at', { ascending: true });

  if (billsErr) throw new AppError('Failed to fetch bills for export.', 500, 'DB_ERROR');

  // 4. Line items joined with medicines & inventory_batches
  const { data: items, error: itemsErr } = await supabase
    .from('bill_items')
    .select('id, bill_id, medicine_id, batch_id, qty, unit_price, mrp, created_at, medicines(name, manufacturer, hsn_code, unit), inventory_batches(batch_no, exp_date)')
    .gte('created_at', startTz)
    .lte('created_at', endTz)
    .order('created_at', { ascending: true });

  if (itemsErr) throw new AppError('Failed to fetch bill items for export.', 500, 'DB_ERROR');

  const billMap = new Map();
  const discountsByDate = {};
  const unitsByBill = new Map();

  (bills || []).forEach((b) => {
    billMap.set(b.id, b);
    const saleDate = getISTDateString(b.created_at);
    discountsByDate[saleDate] = (discountsByDate[saleDate] || 0) + Number(b.discount_amount || 0);
  });

  const lineItems = (items || []).map((it) => {
    const parentBill = billMap.get(it.bill_id);
    const qty = Number(it.qty || 0);
    unitsByBill.set(it.bill_id, (unitsByBill.get(it.bill_id) || 0) + qty);

    return {
      ...it,
      bill_number: parentBill?.bill_number || '—',
      customer_name: parentBill?.customer_name,
      created_at: parentBill?.created_at || it.created_at,
    };
  });

  // Attach units to bills
  (bills || []).forEach((b) => {
    b.total_units = unitsByBill.get(b.id) || b.item_count || 0;
  });

  // Attach discounts to dailyRows
  (dailyRows || []).forEach((r) => {
    r.discount_total = discountsByDate[r.sale_date] || 0;
  });

  return {
    storeName,
    dateFrom: from,
    dateTo: to,
    generatedAt: new Date().toISOString(),
    dailyRows: dailyRows || [],
    bills: bills || [],
    lineItems,
  };
}

module.exports = {
  getSalesReport,
  getMarginReport,
  getPurchaseReport,
  getInventoryReport,
  getTopMedicines,
  getSalesExportData,
};
