// ── Money arithmetic. Pure, dependency-free, no config, no clock.
//
// These two functions were written for Module 23 and lived in
// supplier-invoices.normalize.js. Loose-unit pricing divides a strip price by
// its tablet count and needs exactly the same behaviour, so they moved here
// rather than being written a second time — two rounding rules in one codebase
// is how a ₹0.01 disagreement between a bill and a margin report starts.
//
// normalize.js still imports and re-exports both, so Module 23's public
// surface and its test suite are unchanged.

/**
 * Rounds to paise, half-up, without inheriting the double's rounding.
 *
 * `Math.round(x * 100) / 100` is not enough once division is involved. ₹25.00 a
 * strip of ten, less 3%, is exactly ₹2.425 a tablet — but 2.425 has no exact
 * double, the stored value sits a hair BELOW it, and the naive form silently
 * yields ₹2.42. Going through a fixed-precision string first settles the tie on
 * the decimal value the pharmacy would compute by hand.
 *
 * Half-up rather than half-even, and deliberately so. For a cost, rounding a
 * tie down understates what the stock cost and overstates every margin derived
 * from it. For a loose selling price the same direction protects the counter:
 * a strip of 7 at ₹10.00 is ₹1.43 a tablet, so seven sold singly fetch ₹10.01
 * rather than ₹9.99. Half a paisa is not material; a systematically optimistic
 * margin is.
 */
function roundPaise(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(Number((value * 100).toFixed(4))) / 100;
}

/**
 * A finite number, or null — without JavaScript's coercion of blanks to zero.
 *
 * `Number(null)`, `Number('')` and `Number(false)` are all 0, and 0 is finite,
 * so a plain `Number.isFinite(Number(x))` guard lets an ABSENT rate through as
 * a cost of ₹0.00. That is the worst possible failure here: zero is a number a
 * reviewer will scroll past, where a blank is one they cannot miss.
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { roundPaise, finiteOrNull };
