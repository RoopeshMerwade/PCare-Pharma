// ── Module 16: Notifications Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const logger = require('../../utils/logger');

// ── READ
async function getNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  let q = supabase.from('notifications').select('*')
    .or(`user_id.eq.${userId},user_id.is.null`)  // own + broadcasts
    .order('created_at', { ascending: false }).limit(limit);
  if (unreadOnly) q = q.eq('is_read', false);
  const { data, error } = await q;
  if (error) throw new AppError('Failed to fetch notifications.', 500, 'DB_ERROR');
  return data;
}

async function getUnreadCount(userId) {
  const { count } = await supabase.from('notifications')
    .select('*', { count:'exact', head:true })
    .or(`user_id.eq.${userId},user_id.is.null`)
    .eq('is_read', false);
  return count || 0;
}

// ── MARK READ
async function markRead(notificationId, userId) {
  const { error } = await supabase.from('notifications')
    .update({ is_read: true }).eq('id', notificationId)
    .or(`user_id.eq.${userId},user_id.is.null`);
  if (error) throw new AppError('Failed to mark notification.', 500, 'DB_ERROR');
}

async function markAllRead(userId) {
  await supabase.from('notifications').update({ is_read: true })
    .or(`user_id.eq.${userId},user_id.is.null`).eq('is_read', false);
}

// ── CREATE (internal use — called by other services or cron)
async function createNotification({ user_id = null, type, title, message, metadata = {} }) {
  try {
    const { data, error } = await supabase.from('notifications')
      .insert({ user_id, type, title, message, metadata }).select().single();
    if (error) logger.warn({ type, error: error.message }, 'Notification insert failed');
    return data;
  } catch(e) {
    logger.warn({ type }, 'Notification creation failed silently');
  }
}

// ── GENERATE SYSTEM ALERTS (called on dashboard load to keep notifications fresh)
async function generateAlerts(ownerId) {
  try {
    // Low stock alert
    const { data: lowStock } = await supabase.from('medicines_with_stock')
      .select('name, total_stock').eq('is_active', true).eq('is_low_stock', true).limit(5);
    if (lowStock?.length) {
      await createNotification({
        user_id: ownerId, type: 'LOW_STOCK',
        title: `${lowStock.length} medicine${lowStock.length>1?'s':''} below minimum stock`,
        message: lowStock.map(m=>`${m.name}: ${m.total_stock} remaining`).join('; '),
        metadata: { count: lowStock.length, medicines: lowStock }
      });
    }

    // Near expiry
    const { data: expiring } = await supabase.from('expiry_summary')
      .select('medicine_name, days_to_expiry').eq('urgency', 'critical').limit(5);
    if (expiring?.length) {
      await createNotification({
        user_id: ownerId, type: 'NEAR_EXPIRY',
        title: `${expiring.length} batch${expiring.length>1?'es':''} expiring within 30 days`,
        message: expiring.map(b=>`${b.medicine_name}: ${b.days_to_expiry}d`).join('; '),
        metadata: { count: expiring.length }
      });
    }

    // Pending customer returns
    const { count: crCount } = await supabase.from('customer_returns')
      .select('*', { count:'exact', head:true }).eq('status', 'pending');
    if (crCount > 0) {
      await createNotification({
        user_id: ownerId, type: 'CUSTOMER_RETURN_PENDING',
        title: `${crCount} customer return${crCount>1?'s':''} awaiting approval`,
        message: 'Review and approve or reject pending returns.',
        metadata: { count: crCount }
      });
    }

    // Overdue medication refills — chronic care module (21)
    const { data: overdueRefills } = await supabase.from('medication_schedule_status')
      .select('customer_name, medicine_name, days_since_last_purchase').eq('status', 'overdue').limit(5);
    if (overdueRefills?.length) {
      await createNotification({
        user_id: ownerId, type: 'REFILL_OVERDUE',
        title: `${overdueRefills.length} patient${overdueRefills.length>1?'s':''} overdue for a medication refill`,
        message: overdueRefills.map(r=>`${r.customer_name} (${r.medicine_name}): ${r.days_since_last_purchase}d overdue`).join('; '),
        metadata: { count: overdueRefills.length }
      });
    }
  } catch(e) {
    logger.warn('Alert generation failed silently');
  }
}

module.exports = { getNotifications, getUnreadCount, markRead, markAllRead, createNotification, generateAlerts };
