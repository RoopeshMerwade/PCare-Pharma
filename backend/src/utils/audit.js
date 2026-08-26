// ── Shared audit-log writer.
// Previously copy-pasted into 11 module services; this is the single
// implementation. Audit writes are deliberately fire-and-forget: a failed
// audit insert must never fail the business operation it records — but it
// IS logged, because a silently dead audit trail is a compliance problem.

const { supabase } = require('../config/supabase');
const logger = require('./logger');

async function logAudit(userId, action, metadata = {}, { ip = null, userAgent = null } = {}) {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      user_id: userId,
      action,
      metadata,
      ip_address: ip,
      user_agent: userAgent,
    });
    if (error) logger.warn({ action, reason: error.message }, 'Audit log write failed');
  } catch (e) {
    logger.warn({ action, reason: e.message }, 'Audit log write failed');
  }
}

module.exports = { logAudit };
