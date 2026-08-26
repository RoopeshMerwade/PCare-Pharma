// ── Resource-level authorisation.
//
// `authorize('owner')` on a route answers "may this ROLE call this endpoint".
// It cannot answer "may this USER see THIS ROW", and for any resource whose
// list endpoint is scoped by `created_by` that second question is the whole
// control: the list is filtered, so the only way to reach someone else's row
// is to ask for it by id — which is exactly what an IDOR is.
//
// Both callers here (bills, customer returns) had that shape: the list scoped
// staff to their own rows and the by-id read did not. One helper rather than
// two hand-rolled checks, so the two can never drift, and so a third module
// adopting the same pattern has something to reach for.
//
// The actor is ALWAYS the object `authenticate` attached to the request from a
// verified JWT. It is never taken from the body, the query or a header — a
// caller-supplied id would make the check decorative.

const { AppError } = require('./AppError');

/**
 * Throw unless `actor` may read/act on `resource`.
 *
 * Owners pass unconditionally. Everyone else passes only when the resource's
 * ownership column equals their own id.
 *
 * @param {object|null} resource  the row already loaded from the database
 * @param {object} actor          req.user — server-derived, never client-supplied
 * @param {object} [opts]
 * @param {string} [opts.field='created_by']  ownership column on the row
 * @param {string} [opts.label='record']      noun used in the 403 message
 */
function assertCanAccess(resource, actor, { field = 'created_by', label = 'record' } = {}) {
  // A missing actor means a route reached a service without `authenticate` in
  // front of it, or a caller forgot to pass it through. Failing closed with a
  // 500 is deliberate: silently treating "no actor" as "allowed" is precisely
  // the bug this file exists to prevent, and it must be loud in development
  // rather than quietly permissive in production.
  if (!actor || !actor.id || !actor.role) {
    throw new AppError('Authorisation context missing.', 500, 'ACTOR_REQUIRED');
  }

  if (actor.role === 'owner') return;

  if (!resource || resource[field] !== actor.id) {
    throw new AppError(
      `You can only view the ${label}s you created.`,
      403,
      'FORBIDDEN'
    );
  }
}

module.exports = { assertCanAccess };
