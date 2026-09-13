// ═══════════════════════════════════════════════════════════════════════════
// Contact phone numbers — the shape rule for a phone we only ever DISPLAY.
//
// A supplier's phone is a reference detail copied off a distributor's
// letterhead. Nothing authenticates against it, nothing sends an SMS to it, no
// index is keyed on it — it exists so somebody can ring the distributor about
// a short delivery. The rule is therefore "plausibly a number a person could
// dial", not "a mobile number".
//
// `isMobilePhone('en-IN')` was the wrong rule and rejected every landline.
// Indian distributors print STD numbers (0836-2661234), two numbers on one
// line, and extensions; that validator accepts none of them. It also
// disagreed with the module that FEEDS this field: supplier-invoices stores
// the extracted letterhead number as free text (`normalizePhone`, 30 chars,
// punctuation kept) and Module 23's "Add and link" posts that value straight
// into POST /suppliers — so the stricter rule downstream rejected what the
// invoice had already accepted, on a value the reviewer could not edit.
//
// Customers and staff deliberately keep `isMobilePhone`: a customer's phone is
// the lookup key stamped onto every bill (`bills.customer_phone` is indexed),
// and a staff phone is a personal mobile. Those are identities. This is not.
// ═══════════════════════════════════════════════════════════════════════════

// 40 chars / 25 digits fits the two full numbers a letterhead routinely prints
// ("0836-2661234 / 2661235") with room for an STD code and a separator. It is
// comfortably above supplier-invoices' own 30-char cap, so anything that
// survived extraction survives this.
const MAX_LENGTH = 40;
const MIN_DIGITS = 6;
const MAX_DIGITS = 25;

// Everything a phone is printed with, and nothing a phone is not. Letters are
// excluded on purpose: they are how a label ("Ph:", "Mob") or a whole caption
// gets swept into the field, and a value with letters in it is a misread, not
// a number.
const PHONE_SHAPE = /^[0-9+\-\s(),./]+$/;

const CONTACT_PHONE_MESSAGE =
  'Enter a phone or landline number — digits, with + - ( ) / or spaces if needed';

/**
 * Collapse whitespace and trim; a blank of any kind becomes `null`.
 *
 * Used as an express-validator `customSanitizer`, so it must pass non-strings
 * through untouched rather than stringifying them — a number or an object in
 * this field is a client bug and `isContactPhone` has to be able to see it.
 * Returning `null` for blanks is what keeps `''` out of the column: the old
 * chain stored the empty string the form submits for "no phone".
 */
function normalizeContactPhone(value) {
  if (typeof value !== 'string') return value;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/**
 * True when `value` reads as a dialable number.
 *
 * Blank is NOT accepted here. Emptiness is `.optional()`'s decision — a field
 * that is optional on one route and required on another shares this shape rule
 * but not that answer, and folding the two together is how "(optional)" ends
 * up meaning "mandatory".
 */
function isContactPhone(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s === '' || s.length > MAX_LENGTH) return false;
  if (!PHONE_SHAPE.test(s)) return false;
  const digits = s.replace(/\D/g, '').length;
  return digits >= MIN_DIGITS && digits <= MAX_DIGITS;
}

module.exports = {
  isContactPhone,
  normalizeContactPhone,
  CONTACT_PHONE_MESSAGE,
  MAX_LENGTH,
  MIN_DIGITS,
  MAX_DIGITS,
};
