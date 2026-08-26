const logger = require('../utils/logger');
const config = require('../config/env');

// Global error handler — MUST have 4 args for Express to treat as error middleware
//
// Contract (do NOT change): the machine-readable code is serialized as `error`,
// not `code` — the frontend's ApiError maps data.error → err.code and the
// backend tests assert res.body.error.
const errorHandler = (err, req, res, next) => {
  const isOperational = err.isOperational === true;

  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message;

  if (!isOperational) {
    // Body-parser errors are the common non-AppError 4xx — translate them
    // instead of reporting a fake 500.
    if (err.type === 'entity.too.large') {
      statusCode = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large.';
    } else if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      statusCode = 400; code = 'INVALID_JSON'; message = 'Request body is not valid JSON.';
    } else {
      // Unknown programming/system error: never leak internal codes (e.g. Node's
      // ECONNREFUSED) or messages to clients.
      statusCode = 500; code = 'INTERNAL_ERROR';
      message = 'An unexpected error occurred. Please try again.';
    }
  }

  // Log all 5xx with full detail; 4xx as warn
  if (statusCode >= 500) {
    logger.error({ err, requestId: req.id, req: { method: req.method, url: req.originalUrl, userId: req.user?.id } }, 'Server error');
  } else {
    logger.warn({ code, message, requestId: req.id, url: req.originalUrl, userId: req.user?.id }, 'Client error');
  }

  const body = { error: code, message };
  // details is structured data the frontend acts on (e.g. adherence warnings) —
  // only ever forwarded from operational AppErrors, never from system errors.
  if (isOperational && err.details !== undefined) body.details = err.details;
  if (!config.isProduction && err.stack) body.stack = err.stack;

  return res.status(statusCode).json(body);
};

module.exports = { errorHandler };
