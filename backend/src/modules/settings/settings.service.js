// ── Module 19: Settings
// ── Role: Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');

const ALLOWED_KEYS = [
  'pharmacy_name','pharmacy_address','drug_license_no','gst_no',
  'owner_name','phone','email','city','state','pincode',
  'currency_symbol','default_low_stock_threshold',
  'default_credit_terms_days','financial_year_start'
];

async function getAllSettings() {
  const { data, error } = await supabase.from('pharmacy_settings').select('key, value, description, updated_at').order('key');
  if (error) throw new AppError('Failed to fetch settings.', 500, 'DB_ERROR');
  // Return as a flat object for easier frontend consumption
  const settings = {};
  (data||[]).forEach(r => { settings[r.key] = r.value; });
  return { settings, rows: data };
}

async function updateSettings(updates, userId) {
  const invalid = Object.keys(updates).filter(k => !ALLOWED_KEYS.includes(k));
  if (invalid.length) throw new AppError(`Unknown setting key(s): ${invalid.join(', ')}`, 422, 'INVALID_KEYS');

  const upserts = Object.entries(updates).map(([key, value]) => ({ key, value: String(value||''), updated_by: userId, updated_at: new Date().toISOString() }));
  const { error } = await supabase.from('pharmacy_settings').upsert(upserts, { onConflict: 'key' });
  if (error) throw new AppError('Failed to update settings.', 500, 'DB_ERROR');
  const result = await getAllSettings();
  await logAudit(userId, 'settings_updated', { keys: Object.keys(updates) });
  return result;
}

async function getSetting(key) {
  const { data } = await supabase.from('pharmacy_settings').select('value').eq('key', key).single();
  return data?.value;
}

module.exports = { ALLOWED_KEYS, getAllSettings, updateSettings, getSetting };
