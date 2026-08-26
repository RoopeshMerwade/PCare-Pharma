// ── Middleware: request ID + structured request logging
//
// Attaches req.id (honours an inbound X-Request-Id from nginx so one id can
// trace a request across the proxy and the API) and logs a single structured
// line per request with method, path, status, duration, and user — the log
// line every production incident starts from.

const crypto = require('crypto');
const logger = require('../utils/logger');

const requestContext = (req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    // req.user is set by authenticate AFTER this middleware runs, but the
    // finish event fires at response time, so the id is available here.
    logger[level]({
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs,
      userId: req.user?.id,
    }, 'request completed');
  });

  next();
};

module.exports = { requestContext };
