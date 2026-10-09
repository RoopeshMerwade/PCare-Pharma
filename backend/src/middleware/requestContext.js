// ── Middleware: request ID + structured request logging
//
// Attaches req.id (honours an inbound X-Request-Id from nginx so one id can
// trace a request across the proxy and the API) and logs a single structured
// line per request with method, path, status, duration, and user — the log
// line every production incident starts from.

const crypto = require('crypto');
const logger = require('../utils/logger');

// nginx overwrites X-Request-Id with its own $request_id (32 hex chars), but the
// single-service deploy (app.js serving the SPA, no nginx in front) passes the
// client's header straight through. Unchecked, any caller could choose the id
// stamped on their own log lines — reusing another request's id to muddy an
// incident trace, or sending kilobytes of junk. Only a short token shape is
// honoured; anything else gets a fresh UUID.
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const requestContext = (req, res, next) => {
  const inbound = req.headers['x-request-id'];
  req.id = typeof inbound === 'string' && REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
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
