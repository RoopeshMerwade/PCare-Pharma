// ── Server startup — binds the port and owns process lifecycle.
// All app construction lives in app.js so tests can require the app
// without opening a socket.

const config = require('./config/env');
const logger = require('./utils/logger');
const app = require('./app');

const server = app.listen(config.port, () =>
  logger.info({ port: config.port, env: config.env }, 'P.Care API server started')
);

// ── Graceful shutdown: stop accepting connections, let in-flight requests
// finish, then exit. A 10s hard deadline prevents a hung connection from
// blocking redeploys.
function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
    logger.info('Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('Forced shutdown after 10s drain timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app; // legacy export — new code should require('./app')
