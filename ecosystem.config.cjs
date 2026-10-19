'use strict';
module.exports = {
  apps: [{
    name: 'whatsappbot',
    cwd: __dirname,
    script: 'index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    autorestart: true,
    stop_exit_codes: [78], // Refused session ownership requires operator action, not a restart storm.
    restart_delay: 5000,
    // Network retries stay in-process. This ceiling applies only to genuine startup/fatal crashes.
    min_uptime: 10000,
    max_restarts: 50,
    kill_timeout: 20000,
    shutdown_with_message: true,
    time: true,
    env: { NODE_ENV: 'production' },
    // Streaming removes full-media copies; still leave headroom for concurrent payloads/protocol state.
    max_memory_restart: '1G',
  }],
};
