'use strict';
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./utils/logger');
const storage = require('./services/storageService');
const messages = require('./handlers/messageHandler');
const media = require('./handlers/mediaHandler');
const wrapper = require('./utils/baileysWrapper');
const health = require('./utils/healthMonitor');
const shutdown = require('./utils/shutdownManager');
const { createLifecycle } = require('./utils/socketLifecycle');
const { acquireSessionLock } = require('./utils/sessionLock');
let controller, ownership, started = false;

async function start() {
  if (started) return;
  started = true;
  const authDir = path.join(config.authPath, 'baileys_auth');
  ownership = acquireSessionLock(authDir);
  logger.info('[startup] ' + JSON.stringify({ pid: process.pid, cwd: process.cwd(), authPath: authDir }));
  execFile('git', ['rev-parse', 'HEAD'], { windowsHide: true, timeout: 2000 }, (error, stdout) => {
    if (!error) logger.info('[startup] revision=' + stdout.trim() + ' pid=' + process.pid);
  });
  storage.ensureDirectories();
  controller = createLifecycle({
    config,
    async buildSocket() {
      const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
      fs.mkdirSync(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const socket = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });
      return { socket, saveCreds };
    },
    onMessage: (msg, socket) => messages.handle(new wrapper.BaileysMessageWrapper(msg, socket), socket),
    onFatal: () => shutdown.shutdown('socket-fatal', 1),
    log: (level, event) => logger[level]('[bot] ' + JSON.stringify(event)),
    onReconnect: health.metrics.incReconnect,
    onAuth: kind => kind === 'CONFLICT' ? health.metrics.incConflict() : health.metrics.incAuthFailure(),
  });
  health.registerProvider('socket', controller.stats);
  health.registerProvider('messages', messages.stats);
  health.registerProvider('media', media.queueStats);
  health.registerProvider('groups', wrapper.cacheStats);
  shutdown.registerStop(() => { controller.beginStop(); messages.beginStop(); media.beginStop(); });
  shutdown.registerCleanup('collector', async () => {
    // Release the session only after every writer/socket has stopped successfully.
    await media.stop(); await messages.stop(); await controller.stop();
    ownership.release();
  });
  health.start(config.healthIntervalMs); // Referenced heartbeat keeps AUTH_REQUIRED observable and alive.
  await controller.start();
}
module.exports = { start };
