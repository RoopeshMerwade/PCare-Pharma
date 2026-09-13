// ══════════════════════════════════════════
// PM2 process file — production only.
//
//   sudo mkdir -p /var/log/pcare && sudo chown <app-user> /var/log/pcare
//   pm2 start ecosystem.config.js && pm2 save
//
// PM2 does not create the log directory, and without it the process cannot
// write its logs and dies with nothing to say why.
// ══════════════════════════════════════════
module.exports = {
  apps: [{
    name: 'pcare-api',
    // Pinned to this file's directory, so `pm2 start` behaves the same from any
    // shell location. (env.js reads backend/.env by absolute path, so the .env
    // no longer depends on the working directory either.)
    cwd: __dirname,
    script: './backend/src/server.js',
    // One fork, and it must stay one. The API rate limiters, the invoice upload
    // guards and the capability probes all hold per-process state; under
    // cluster mode each worker would enforce its own share of every limit.
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    // A 12MB invoice is held in memory, and again as base64, for the whole
    // Gemini read. 400M left little headroom for that, and a restart mid-read
    // loses an upload whose storage write and Gemini call are already paid for.
    max_memory_restart: '700M',
    // server.js drains in-flight requests for up to 10s on SIGTERM. PM2's
    // default of 1.6s would SIGKILL it partway through.
    kill_timeout: 12000,
    listen_timeout: 10000,
    // `env`, not only `env_production`. env_production applies only when started
    // with `--env production`; started without it NODE_ENV was unset, so error
    // responses carried stack traces and the refresh cookie lost `Secure`.
    env: {
      NODE_ENV: 'production',
      PORT: 4000,
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 4000,
    },
    error_file: '/var/log/pcare/error.log',
    out_file:   '/var/log/pcare/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
