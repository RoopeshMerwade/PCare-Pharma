// ═══════════════════════════════════════════════════════════════════════════
// Contact phone shape — a deliberate mirror of backend/src/utils/phone.js.
//
// The server's copy is authoritative; this one exists so the counter sees the
// problem inline instead of a 422 after a round trip. Keep the two in step,
// the same arrangement domain/invoice.js and domain/pack.js already use.
//
// This is the SUPPLIER rule: a letterhead number, displayed and never dialled
// by the system, so landlines with STD codes and two-numbers-on-one-line are
// all valid. Customer phones are a different rule — they are the lookup key on
// a bill — and are not validated with this.
// ═══════════════════════════════════════════════════════════════════════════

const MAX_LENGTH = 40;
const MIN_DIGITS = 6;
const MAX_DIGITS = 25;
const PHONE_SHAPE = /^[0-9+\-\s(),./]+$/;

export const CONTACT_PHONE_MESSAGE =
  'Enter a phone or landline number — digits, with + - ( ) / or spaces if needed';

/** Collapse whitespace and trim; any kind of blank becomes `null`. */
export function normalizeContactPhone(value) {
  if (typeof value !== 'string') return value;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/**
 * True when `value` reads as a dialable number. Blank is NOT accepted here —
 * whether the field may be empty is the form's decision, not the shape rule's.
 */
export function isContactPhone(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s === '' || s.length > MAX_LENGTH) return false;
  if (!PHONE_SHAPE.test(s)) return false;
  const digits = s.replace(/\D/g, '').length;
  return digits >= MIN_DIGITS && digits <= MAX_DIGITS;
}
