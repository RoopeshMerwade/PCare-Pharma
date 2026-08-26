const pino = require('pino');
const config = require('../config/env');

const logger = pino({
  level: config.logLevel,
  // In production: output JSON for log aggregation (CloudWatch, Datadog, etc)
  // In development: pretty-print
  transport: !config.isProduction
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  redact: {
    // NEVER log sensitive fields — GDPR + security
    paths: ['password', 'new_password', 'token', 'access_token', 'refresh_token',
            'req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
    remove: true
  }
});

module.exports = logger;
