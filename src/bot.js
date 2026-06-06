'use strict';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino             = require('pino');
const path             = require('path');
const fs               = require('fs');
const qrcode           = require('qrcode-terminal');
const config           = require('./config');
const logger           = require('./utils/logger');
const storageService   = require('./services/storageService');
const messageHandler   = require('./handlers/messageHandler');
const { BaileysMessageWrapper } = require('./utils/baileysWrapper');
const health           = require('./utils/healthMonitor');
const shutdown         = require('./utils/shutdownManager');

let client = null;
let isReconnecting = false;
let reconnectCount = 0;

const MAX_RETRIES   = config.reconnectMaxRetries;
const BASE_DELAY_MS = config.reconnectDelayMs;

const baileysLogger = pino({ level: 'silent' });

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

  try {
    await _buildClient();
  } catch (err) {
    logger.error(`[bot] _buildClient() failed: ${err.message}`);
    isReconnecting = false;
    await scheduleReconnect('initialize() error');
  }

  isReconnecting = false;
}

function start() {
  storageService.ensureDirectories();
  health.start(config.healthIntervalMs);

  shutdown.registerCleanup('whatsapp-client', async () => {
    if (client) {
      logger.info('[bot] Closing WhatsApp socket...');
      try { client.end(); } catch (_) {}
    }
  });

  _buildClient().catch(err => {
    logger.error(`[bot] Initial startup failed: ${err.message}`);
  });
}

async function _buildClient() {
  const authDir = path.join(config.authPath, 'baileys_auth');
  fs.mkdirSync(authDir, { recursive: true });
  
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  client = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
  });

  client.ev.on('creds.update', saveCreds);

  client.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info('[bot] QR received — scan it using WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`[bot] Connection closed. Reason: ${lastDisconnect?.error?.message || statusCode}`);
      health.metrics.incReconnect();
      if (shouldReconnect) {
        scheduleReconnect(lastDisconnect?.error?.message || 'connection closed').catch((err) => {
          logger.error(`[bot] scheduleReconnect() failed: ${err.message}`);
        });
      } else {
        logger.error(`[bot] Logged out from WhatsApp. Please clear session and run again.`);
        process.exit(1);
      }
    } else if (connection === 'open') {
      reconnectCount = 0;
      isReconnecting = false;
      logger.info('[bot] ✅ Bot is READY — listening for messages.');
      logger.info(
        `[bot] Collecting: Groups=${config.listenGroups} | DMs=${config.listenDMs} | Broadcasts=${config.listenBroadcasts}`
      );
      if (config.groupKeywords.length > 0) {
        logger.info(`[bot] Group keyword filter: [${config.groupKeywords.join(', ')}]`);
      } else {
        logger.info('[bot] Group keyword filter: OFF (collecting from ALL groups)');
      }
    }
  });

  client.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      const wrapped = new BaileysMessageWrapper(msg, client);
      await messageHandler.handle(wrapped, client);
    }
  });
}

module.exports = { start };
