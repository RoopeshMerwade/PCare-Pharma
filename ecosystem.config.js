// ══════════════════════════════════════════
// PM2 ecosystem.config.js — save in /app root
// ══════════════════════════════════════════
module.exports = {
  apps: [{
    name: 'pcare-api',
    script: './backend/src/server.js',
    instances: 1,           // single outlet; scale up if needed
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    env_production: {
      NODE_ENV: 'production',
      PORT: 4000,
    },
    error_file: '/var/log/pcare/error.log',
    out_file:   '/var/log/pcare/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
