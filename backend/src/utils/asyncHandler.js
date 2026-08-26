// Wraps async route handlers — eliminates try/catch boilerplate everywhere
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { asyncHandler };
