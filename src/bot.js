'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs             = require('fs');
const path           = require('path');
const qrcode         = require('qrcode-terminal');
const config         = require('./config');
const logger         = require('./utils/logger');
const storageService = require('./services/storageService');
const messageHandler = require('./handlers/messageHandler');
const health         = require('./utils/healthMonitor');
const shutdown       = require('./utils/shutdownManager');

let client = null;
let isReconnecting = false;
let reconnectCount = 0;
let consecutiveAuthFailures = 0;

const MAX_RETRIES   = config.reconnectMaxRetries;
const BASE_DELAY_MS = config.reconnectDelayMs;

function backoffDelay(attempt) {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 120_000);
}

async function scheduleReconnect(reason) {
  if (isReconnecting) {
    logger.debug('[bot] Reconnect already in progress — skipping duplicate trigger.');
    return;
  }

  isReconnecting = true;

  if (reconnectCount >= MAX_RETRIES) {
    logger.error(
      `[bot] Max reconnect attempts (${MAX_RETRIES}) reached after "${reason}". Exiting.`
    );
    process.exit(1);
  }

  const delay = backoffDelay(reconnectCount);
  reconnectCount++;
  logger.warn(
    `[bot] Reconnecting in ${delay}ms (attempt ${reconnectCount}/${MAX_RETRIES}). Reason: ${reason}`
  );

  await new Promise((r) => setTimeout(r, delay));

  if (client) {
    try {
      await client.destroy();
    } catch (_) {}
  }

  try {
    await client.initialize();
  } catch (err) {
    logger.error(`[bot] client.initialize() failed: ${err.message}`);
    isReconnecting = false;
    await scheduleReconnect('initialize() error');
  }

  isReconnecting = false;
}

function start() {
  if (client) {
    logger.warn('[bot] start() called more than once — ignoring.');
    return;
  }

  storageService.ensureDirectories();
  health.start(config.healthIntervalMs);

  shutdown.registerCleanup('whatsapp-client', async () => {
    if (client) {
      logger.info('[bot] Destroying WhatsApp client...');
      try { await client.destroy(); } catch (_) {}
    }
  });

  _buildClient();
}

function _buildClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authPath }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
    restartOnAuthFail: false,
  });

  client.on('qr', (qr) => {
    logger.info('[bot] QR received — open WhatsApp → Linked Devices → Link a Device and scan:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    consecutiveAuthFailures = 0;
    logger.info(`[bot] 🔐 Session authenticated (saved to "${config.authPath}").`);
  });

  client.on('ready', () => {
    reconnectCount = 0;
    isReconnecting = false;
    consecutiveAuthFailures = 0;
    logger.info('[bot] ✅ Bot is READY — listening for messages.');
    logger.info(
      `[bot] Collecting: Groups=${config.listenGroups} | DMs=${config.listenDMs} | Broadcasts=${config.listenBroadcasts}`
    );
    if (config.groupKeywords.length > 0) {
      logger.info(`[bot] Group keyword filter: [${config.groupKeywords.join(', ')}]`);
    } else {
      logger.info('[bot] Group keyword filter: OFF (collecting from ALL groups)');
    }
  });

  client.on('auth_failure', (msg) => {
    consecutiveAuthFailures++;
    health.metrics.incAuthFailure();
    logger.error(`[bot] Auth failed (attempt ${consecutiveAuthFailures}): ${msg}`);
    if (consecutiveAuthFailures >= 2) {
      logger.error('[bot] Repeated auth failures — backing up corrupt session...');
      _backupAndClearSession();
    }
  });

  client.on('disconnected', (reason) => {
    logger.warn(`[bot] Disconnected. Reason: ${reason}`);
    health.metrics.incReconnect();
    scheduleReconnect(reason).catch((err) => {
      logger.error(`[bot] scheduleReconnect() threw: ${err.message}`);
    });
  });

  client.on('message', async (msg) => {
    await messageHandler.handle(msg, client);
  });

  client.on('message_create', async (msg) => {
    await messageHandler.handle(msg, client);
  });

  logger.info('[bot] Initializing WhatsApp client (may take 15–30 s on first run)...');
  client.initialize().catch((err) => {
    logger.error(`[bot] Initial client.initialize() failed: ${err.message}`);
    scheduleReconnect('startup failure').catch((e) => {
      logger.error(`[bot] Could not schedule initial reconnect: ${e.message}`);
    });
  });
}

function _backupAndClearSession() {
  const authDir = path.resolve(config.authPath);
  if (!fs.existsSync(authDir)) return;
  const backup = `${authDir}_corrupt_${Date.now()}`;
  try {
    fs.renameSync(authDir, backup);
    logger.warn(`[bot] Corrupt session backed up to: ${backup}`);
    logger.warn('[bot] Next restart will show a fresh QR code.');
  } catch (err) {
    logger.error(`[bot] Could not back up session: ${err.message}`);
  }
}

module.exports = { start };
