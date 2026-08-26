// ── Module 21: Chronic Medication Adherence Monitoring — Service
//
// Status (early_refill / due_soon / overdue / on_track) is ALWAYS computed
// live from bills via medication_schedule_status — nothing is stored.
// This mirrors the append-only-ledger principle used everywhere else in
// this system: derived data is never cached.

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

// ── LOOKUP LIST (fixed, per product decision) ─────────────

async function listConditionOptions() {
  const { data, error } = await supabase.from('chronic_conditions').select('*').eq('is_active', true).order('name');
  if (error) throw new AppError('Failed to fetch condition list.', 500, 'DB_ERROR');
  return data;
}

// ── PATIENT CONDITIONS (diagnosis records) ────────────────

async function listPatientConditions(customerId) {
  const { data, error } = await supabase.from('patient_conditions')
    .select('*, chronic_conditions(name)')
    .eq('customer_id', customerId).eq('is_active', true)
    .order('diagnosed_date', { ascending: false });
  if (error) throw new AppError('Failed to fetch patient conditions.', 500, 'DB_ERROR');
  return data;
}

async function addPatientCondition({ customer_id, condition_id, diagnosed_date, prescribing_doctor, notes }, userId) {
  const { data, error } = await supabase.from('patient_conditions')
    .insert({ customer_id, condition_id, diagnosed_date: diagnosed_date || null, prescribing_doctor: prescribing_doctor?.trim() || null, notes: notes?.trim() || null, created_by: userId })
    .select('*, chronic_conditions(name)').single();
  if (error) throw new AppError('Failed to record condition.', 500, 'DB_ERROR');
  await logAudit(userId, 'patient_condition_added', { customerId: customer_id, conditionId: condition_id });
  return data;
}

async function deactivatePatientCondition(id, userId) {
  const { data, error } = await supabase.from('patient_conditions').update({ is_active: false }).eq('id', id).select().single();
  if (error) throw new AppError('Failed to update condition record.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Condition record not found.', 404, 'CONDITION_NOT_FOUND');
  await logAudit(userId, 'patient_condition_deactivated', { conditionRecordId: id });
  return data;
}

// ── MEDICATION SCHEDULES ───────────────────────────────────

async function listSchedulesForCustomer(customerId) {
  const { data, error } = await supabase.from('medication_schedule_status').select('*').eq('customer_id', customerId).order('medicine_name');
  if (error) throw new AppError('Failed to fetch medication schedules.', 500, 'DB_ERROR');
  return data;
}

async function createSchedule({ customer_id, medicine_id, condition_id, refill_cycle_days, early_grace_days, late_grace_days }, userId) {
  // Prevent duplicate active schedules for the same customer+medicine
  const { data: existing } = await supabase.from('medication_schedules')
    .select('id').eq('customer_id', customer_id).eq('medicine_id', medicine_id).eq('is_active', true).maybeSingle();
  if (existing) throw new AppError('An active schedule already exists for this customer and medicine. Edit or deactivate it first.', 409, 'DUPLICATE_SCHEDULE');

  const { data, error } = await supabase.from('medication_schedules')
    .insert({
      customer_id, medicine_id, condition_id: condition_id || null,
      refill_cycle_days,
      early_grace_days: early_grace_days ?? 7,
      late_grace_days:  late_grace_days  ?? 7,
      created_by: userId,
    })
    .select().single();
  if (error) throw new AppError('Failed to create medication schedule.', 500, 'DB_ERROR');
  await logAudit(userId, 'medication_schedule_created', { scheduleId: data.id, customerId: customer_id, medicineId: medicine_id });
  return data;
}

async function updateSchedule(id, { refill_cycle_days, early_grace_days, late_grace_days }, userId) {
  const updates = {};
  if (refill_cycle_days !== undefined) updates.refill_cycle_days = refill_cycle_days;
  if (early_grace_days  !== undefined) updates.early_grace_days  = early_grace_days;
  if (late_grace_days   !== undefined) updates.late_grace_days   = late_grace_days;
  if (!Object.keys(updates).length) throw new AppError('No updatable fields provided.', 422, 'NO_FIELDS');

  const { data, error } = await supabase.from('medication_schedules').update(updates).eq('id', id).select().single();
  if (error) throw new AppError('Failed to update schedule.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Schedule not found.', 404, 'SCHEDULE_NOT_FOUND');
  await logAudit(userId, 'medication_schedule_updated', { scheduleId: id });
  return data;
}

async function deactivateSchedule(id, userId) {
  const { data, error } = await supabase.from('medication_schedules').update({ is_active: false }).eq('id', id).select().single();
  if (error) throw new AppError('Failed to deactivate schedule.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Schedule not found.', 404, 'SCHEDULE_NOT_FOUND');
  await logAudit(userId, 'medication_schedule_deactivated', { scheduleId: id });
  return data;
}

// ── DASHBOARD / NOTIFICATIONS FEED ────────────────────────

async function getOverdueSchedules({ limit = 20 } = {}) {
  const { data, error } = await supabase.from('medication_schedule_status')
    .select('*').in('status', ['overdue', 'early_refill']).order('days_since_last_purchase', { ascending: false }).limit(limit);
  if (error) throw new AppError('Failed to fetch overdue schedules.', 500, 'DB_ERROR');
  return data;
}

// ── POINT-OF-SALE CHECK ───────────────────────────────────
// Called by billing.service.js BEFORE a bill is created.
// Returns warnings for any tracked medicine in this cart that is
// early_refill or overdue for this customer. Sale is never blocked —
// but if warnings exist and aren't in `acknowledgedScheduleIds`,
// billing.service.js will refuse to proceed until the staff acknowledges.

async function checkAdherenceWarnings(customerPhone, items) {
  if (!customerPhone || !items?.length) return [];

  const medicineIds = items.map(i => i.medicine_id);
  const { data: schedules, error } = await supabase.from('medication_schedule_status')
    .select('*').eq('customer_phone', customerPhone).in('medicine_id', medicineIds)
    .in('status', ['early_refill', 'overdue']);
  if (error) throw new AppError('Failed to check medication adherence.', 500, 'DB_ERROR');

  return (schedules || []).map(s => ({
    schedule_id: s.schedule_id,
    medicine_id: s.medicine_id,
    medicine_name: s.medicine_name,
    status: s.status,
    days_since_last_purchase: s.days_since_last_purchase,
    refill_cycle_days: s.refill_cycle_days,
  }));
}

// Records that staff saw and acknowledged these warnings — called after
// the bill is successfully created, linking the acknowledgment to it.
async function recordAcknowledgments(billId, warnings, userId) {
  if (!warnings?.length) return;
  const rows = warnings.map(w => ({
    bill_id: billId, schedule_id: w.schedule_id, status_at_sale: w.status,
    days_since_last_purchase: w.days_since_last_purchase, acknowledged_by: userId,
  }));
  const { error } = await supabase.from('adherence_acknowledgments').insert(rows);
  if (error) logger.warn({ billId, error: error.message }, 'Failed to record adherence acknowledgment');
  await logAudit(userId, 'adherence_warning_acknowledged', { billId, count: warnings.length, statuses: warnings.map(w => w.status) });
}

module.exports = {
  listConditionOptions,
  listPatientConditions, addPatientCondition, deactivatePatientCondition,
  listSchedulesForCustomer, createSchedule, updateSchedule, deactivateSchedule,
  getOverdueSchedules, checkAdherenceWarnings, recordAcknowledgments,
};
