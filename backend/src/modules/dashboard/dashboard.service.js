// ── Modules 17+18: Dashboard Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { getTopMedicines } = require('../reports/reports.service');
const { getUnreadCount } = require('../notifications/notifications.service');
const { getOverdueSchedules } = require('../chronic-care/chronic-care.service');
const { getTodayBoard } = require('../attendance/attendance.service');
const {
  getPendingRequisitionBoard, getMyPendingRequisitions,
} = require('../stock-requisitions/stock-requisitions.service');

const today      = () => new Date().toISOString().slice(0,10);
const monthStart = () => new Date(new Date().setDate(1)).toISOString().slice(0,10);
const weekStart  = () => { const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
const daysAgo    = (n) => { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

// Window for the dashboard sparklines and the revenue trend chart.
const TREND_DAYS = 14;

/**
 * daily_sales_summary only emits rows for days that had bills. A quiet Sunday
 * must plot as ₹0, not vanish and silently compress the x-axis — so the gaps
 * are filled here, server-side, and every consumer gets an honest series.
 */
function zeroFilledTrend(rows) {
  const byDate = {};
  (rows || []).forEach((r) => { byDate[r.sale_date] = r; });
  const out = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const date = daysAgo(i);
    const r = byDate[date] || {};
    out.push({
      sale_date:     date,
      bill_count:    parseInt(r.bill_count || 0, 10),
      total_revenue: parseFloat(r.total_revenue || 0),
      cash_total:    parseFloat(r.cash_total || 0),
      upi_total:     parseFloat(r.upi_total || 0),
      credit_total:  parseFloat(r.credit_total || 0),
      card_total:    parseFloat(r.card_total || 0),
    });
  }
  return out;
}

// ── OWNER DASHBOARD
async function getOwnerDashboard(ownerId) {
  const [
    todaySales, weekSales, monthSales, trendData,
    lowStockData, nearExpiryData,
    pendingCR, pendingSR,
    topMeds, unreadCount, overdueRefills, attendance, requisitions
  ] = await Promise.allSettled([
    // Today's sales
    supabase.from('bills_with_totals').select('total, payment_mode, created_by, created_by_name, item_count')
      .gte('created_at', today()).lte('created_at', today()+'T23:59:59'),
    // This week
    supabase.from('bills_with_totals').select('total')
      .gte('created_at', weekStart()).lte('created_at', today()+'T23:59:59'),
    // This month
    supabase.from('bills_with_totals').select('total')
      .gte('created_at', monthStart()).lte('created_at', today()+'T23:59:59'),
    // Last 14 days, day by day — sparklines and the revenue trend chart
    supabase.from('daily_sales_summary')
      .select('sale_date, bill_count, total_revenue, cash_total, upi_total, credit_total, card_total')
      .gte('sale_date', daysAgo(TREND_DAYS - 1)).lte('sale_date', today())
      .order('sale_date', { ascending: true }),
    // Low stock (top 5 preview + total count)
    supabase.from('medicines_with_stock').select('id, name, unit, total_stock, low_stock_threshold, category_name, category_color', { count: 'exact' })
      .eq('is_active', true).eq('is_low_stock', true).order('total_stock').limit(5),
    // Near expiry (within 30d preview + total count)
    supabase.from('expiry_summary').select('medicine_name, batch_no, exp_date, stock_qty, days_to_expiry', { count: 'exact' })
      .eq('urgency', 'critical').limit(5),
    // Pending customer returns
    supabase.from('customer_returns').select('*', { count:'exact', head:true }).eq('status', 'pending'),
    // Pending supplier returns
    supabase.from('supplier_returns').select('*', { count:'exact', head:true }).eq('status', 'draft'),
    // Top medicines
    getTopMedicines({ dateFrom: monthStart(), dateTo: today(), limit: 5 }),
    // Unread notifications
    getUnreadCount(ownerId),
    // Overdue / early medication refills (chronic care — Module 21)
    getOverdueSchedules({ limit: 5 }),
    // Who is on the counter today (attendance — Module 26). Shipped in the
    // dashboard payload rather than fetched separately so the widget has rows
    // to paint on first render; it refetches /attendance/today after each
    // check-in so the board stays live without reloading the whole dashboard.
    getTodayBoard(),
    // What the counter has asked to be ordered (Module 30). Same arrangement
    // as attendance: rows travel in the dashboard payload so the card has
    // something to paint on first render, and it refetches for itself after
    // each approve or reject.
    getPendingRequisitionBoard(),
  ]);

  const safe = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;

  const todayBills = safe(todaySales, { data: [] }).data || [];
  const todayTotal = todayBills.reduce((s,b) => s + parseFloat(b.total||0), 0);
  const payModes   = { cash:0, upi:0, credit:0, card:0 };
  const staffMap   = {};

  todayBills.forEach(b => {
    if (payModes[b.payment_mode] !== undefined) payModes[b.payment_mode] += parseFloat(b.total||0);
    const staffId   = b.created_by || 'unassigned';
    const staffName = b.created_by_name || 'Staff / Owner';
    if (!staffMap[staffId]) {
      staffMap[staffId] = {
        staff_id: staffId,
        staff_name: staffName,
        bill_count: 0,
        item_count: 0,
        total_sales: 0,
      };
    }
    staffMap[staffId].bill_count += 1;
    staffMap[staffId].item_count += (b.item_count || 0);
    staffMap[staffId].total_sales += parseFloat(b.total || 0);
  });

  const staffSales = Object.values(staffMap).sort((a, b) => b.total_sales - a.total_sales);

  const weekBills  = safe(weekSales, { data: [] }).data || [];
  const monthBills = safe(monthSales, { data: [] }).data || [];

  const trend = zeroFilledTrend(safe(trendData, { data: [] }).data);
  // Pin the trend's endpoint to the figures computed above from
  // bills_with_totals: daily_sales_summary buckets by the DB session
  // timezone while today() slices UTC, so around midnight the two can
  // disagree — and a sparkline whose endpoint contradicts the headline it
  // sits under reads as a bug. (The underlying UTC/IST skew is pre-existing
  // and also affects week/month and /reports/sales; not fixed here.)
  const trendToday = trend[trend.length - 1];
  trendToday.bill_count    = todayBills.length;
  trendToday.total_revenue = todayTotal;
  trendToday.cash_total    = payModes.cash;
  trendToday.upi_total     = payModes.upi;
  trendToday.credit_total  = payModes.credit;
  trendToday.card_total    = payModes.card;

  const yRow = trend[trend.length - 2] || null;

  const lowStockRes = safe(lowStockData, { data: [], count: 0 });
  const nearExpiryRes = safe(nearExpiryData, { data: [], count: 0 });

  return {
    today: {
      date:        today(),
      bill_count:  todayBills.length,
      total_sales: todayTotal,
      payment_breakdown: payModes,
      staff_sales: staffSales,
    },
    week: {
      bill_count:  weekBills.length,
      total_sales: weekBills.reduce((s,b) => s + parseFloat(b.total||0), 0),
    },
    month: {
      bill_count:  monthBills.length,
      total_sales: monthBills.reduce((s,b) => s + parseFloat(b.total||0), 0),
    },
    trend: {
      days: TREND_DAYS,
      rows: trend,   // zero-filled, ascending; last row always equals `today`
    },
    yesterday: yRow && {
      date:        yRow.sale_date,
      bill_count:  yRow.bill_count,
      total_sales: yRow.total_revenue,
      payment_breakdown: {
        cash:   yRow.cash_total,
        upi:    yRow.upi_total,
        credit: yRow.credit_total,
        card:   yRow.card_total,
      },
    },
    alerts: {
      low_stock:                lowStockRes.data || [],
      low_stock_count:          lowStockRes.count ?? (lowStockRes.data || []).length,
      near_expiry:              nearExpiryRes.data || [],
      near_expiry_count:        nearExpiryRes.count ?? (nearExpiryRes.data || []).length,
      pending_customer_returns: safe(pendingCR, { count:0 }).count || 0,
      pending_supplier_returns: safe(pendingSR, { count:0 }).count || 0,
      overdue_refills:          safe(overdueRefills, []),
    },
    // Empty rows with a zeroed summary rather than null: the widget renders a
    // board, and "no staff accounts yet" is a state it can say out loud.
    // A null here would make it guess.
    attendance: safe(attendance, { rows: [], summary: { total: 0, present: 0, checked_out: 0, absent: 0 } }),
    requisitions: safe(requisitions, { rows: [], summary: { pending: 0, urgent: 0 } }),
    top_medicines: safe(topMeds, []),
    unread_notifications: safe(unreadCount, 0),
    generated_at: new Date().toISOString(),
  };
}

// ── STAFF DASHBOARD
async function getStaffDashboard(staffId) {
  const [todayOwn, lowStock, pendingOwn, myRequisitions] = await Promise.allSettled([
    // Today's bills by this staff
    supabase.from('bills_with_totals').select('id, bill_number, total, customer_name, created_at, item_count')
      .eq('created_by', staffId).gte('created_at', today()).order('created_at', { ascending: false }),
    // Low stock alert (top 5 preview + total count)
    supabase.from('medicines_with_stock').select('name, unit, total_stock', { count: 'exact' })
      .eq('is_active', true).eq('is_low_stock', true).order('total_stock').limit(5),
    // Own pending returns
    supabase.from('customer_returns').select('id, return_number, status, customer_name, created_at')
      .eq('created_by', staffId).eq('status', 'pending').limit(5),
    // Own stock requests still waiting on the owner (Module 30)
    getMyPendingRequisitions(staffId),
  ]);

  const safe = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;

  const myBills = safe(todayOwn, { data:[] }).data || [];
  const lowStockRes = safe(lowStock, { data:[], count: 0 });

  return {
    today: {
      date:       today(),
      bill_count: myBills.length,
      item_count: myBills.reduce((s,b) => s + (b.item_count||0), 0),
      recent_bills: myBills.slice(0, 5),
    },
    low_stock_alerts: lowStockRes.data || [],
    low_stock_count:  lowStockRes.count ?? (lowStockRes.data || []).length,
    pending_returns:  safe(pendingOwn, { data:[] }).data || [],
    pending_requisitions: safe(myRequisitions, []),
    generated_at: new Date().toISOString(),
  };
}

module.exports = { getOwnerDashboard, getStaffDashboard };
