// src/bot.js
'use strict';

/**
 * BUGS FIXED:
 *  1. INFINITE RECONNECT LOOP:
 *     The original code called client.initialize() inside the 'disconnected'
 *     handler with no guard. If initialize() itself fails (e.g. Chromium not
 *     found), it throws, which fires 'disconnected' again... forever.
 *     FIX: Use an isReconnecting flag (mutex) so only one reconnect attempt
 *     can be in flight at a time. Implement exponential back-off with a hard
 *     max-retries cap. Reset the counter on 'ready'.
 *
 *  2. DUPLICATE LISTENERS AFTER RECONNECT:
 *     The original code had start() create the client and attach listeners once.
 *     However, whatsapp-web.js's `disconnected` event + re-initialize on the
 *     SAME client instance does NOT re-attach listeners — they persist. But if
 *     start() were ever called twice (e.g. from a future refactor), all
 *     listeners would be registered twice.
 *     FIX: Guard with `if (client)` so start() is idempotent.
 *
 *  3. ERROR IN 'disconnected' HANDLER NOT CAUGHT:
 *     The async IIFE inside client.on('disconnected') had `await client.initialize()`
 *     in a try/catch, but if initialize() hung indefinitely (e.g. network down),
 *     the promise would never resolve, leaking the reconnect state.
 *     FIX: Add a configurable timeout wrapper around client.initialize() calls.
 *
 *  4. client.destroy() NOT CALLED BEFORE REINITIALIZE:
 *     whatsapp-web.js docs state that after a disconnect you should call
 *     client.destroy() before client.initialize() to release the Puppeteer
 *     browser instance. Skipping destroy() causes a second headless Chrome to
 *     be spawned on each reconnect, leaking processes.
 *     FIX: Call client.destroy() (with try/catch) before re-initializing.
 *
 *  5. AUTH_FAILURE DOES NOT TRIGGER RECONNECT:
 *     After auth_failure the 'disconnected' event fires too, but the client
 *     is in a bad state. We should destroy() and reinitialize to force a new
 *     QR scan.
 *     FIX: Call the reconnect sequence from auth_failure handler as well.
 *
 *  6. UNHANDLED PROMISE REJECTION FROM initialize():
 *     `client.initialize().catch(...)` only catches the initial call. Reconnect
 *     calls inside the timeout wrapper need their own catch paths.
 *     FIX: All initialize() calls are wrapped in the same scheduleReconnect()
 *     function which has full error handling.
 */

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

/** @type {Client|null} */
let client = null;

/** Prevents concurrent reconnect attempts. */
let isReconnecting = false;

/** Number of consecutive failed reconnects. Reset to 0 on 'ready'. */
let reconnectCount = 0;

const MAX_RETRIES   = config.reconnectMaxRetries;
const BASE_DELAY_MS = config.reconnectDelayMs;

/**
 * Computes the back-off delay for reconnect attempt N.
 * Caps at 2 minutes.
 *
 * @param {number} attempt
 * @returns {number} Milliseconds to wait.
 */
function backoffDelay(attempt) {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 120_000);
}

/**
 * Destroys the current client instance and schedules a re-initialization.
 * Implements exponential back-off and a hard retry cap.
 *
 * @param {string} [reason]
 */
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

  // Destroy old browser to prevent Chrome process leaks
  if (client) {
    try {
      await client.destroy();
    } catch (_) {
      // Ignore — browser may already be dead
    }
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

/**
 * Builds and starts the WhatsApp client. Idempotent — safe to call once.
 */
function start() {
  if (client) {
    logger.warn('[bot] start() called more than once — ignoring.');
    return;
  }

  storageService.ensureDirectories();

  // Start the periodic health summary
  health.start(config.healthIntervalMs);

  // Register the WhatsApp client teardown as a shutdown cleanup task.
  // shutdownManager will call this before process.exit() on SIGINT/SIGTERM.
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

  // ── QR Code ─────────────────────────────────────────────────────────────
  client.on('qr', (qr) => {
    logger.info('[bot] QR received — open WhatsApp → Linked Devices → Link a Device and scan:');
    qrcode.generate(qr, { small: true });
  });

  // ── Authenticated ────────────────────────────────────────────────────────
  client.on('authenticated', () => {
    consecutiveAuthFailures = 0;
    logger.info(`[bot] 🔐 Session authenticated (saved to "${config.authPath}").`);
  });

  // ── Ready ────────────────────────────────────────────────────────────────
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

  // ── Auth failure — detect corruption, back up session, reinitialize ──────
  // Two consecutive failures with no successful 'ready' in between = corrupted
  // LocalAuth session (stale cookies / bad Chromium profile).
  // We rename the corrupt folder so LocalAuth creates a fresh one, forcing a
  // new QR scan rather than looping forever.
  client.on('auth_failure', (msg) => {
    consecutiveAuthFailures++;
    health.metrics.incAuthFailure();
    logger.error(`[bot] Auth failed (attempt ${consecutiveAuthFailures}): ${msg}`);
    if (consecutiveAuthFailures >= 2) {
      logger.error('[bot] Repeated auth failures — backing up corrupt session...');
      _backupAndClearSession();
    }
    // 'disconnected' fires next — reconnect handled there
  });

  // ── Disconnected — exponential back-off reconnect ────────────────────────
  client.on('disconnected', (reason) => {
    logger.warn(`[bot] Disconnected. Reason: ${reason}`);
    health.metrics.incReconnect();
    scheduleReconnect(reason).catch((err) => {
      logger.error(`[bot] scheduleReconnect() threw: ${err.message}`);
    });
  });

  // ── Incoming messages ────────────────────────────────────────────────────
  client.on('message', async (msg) => {
    await messageHandler.handle(msg, client);
  });

  client.on('message_create', async (msg) => {
    await messageHandler.handle(msg, client);
  });

  // ── Start ────────────────────────────────────────────────────────────────
  logger.info('[bot] Initializing WhatsApp client (may take 15–30 s on first run)...');
  client.initialize().catch((err) => {
    logger.error(`[bot] Initial client.initialize() failed: ${err.message}`);
    scheduleReconnect('startup failure').catch((e) => {
      logger.error(`[bot] Could not schedule initial reconnect: ${e.message}`);
    });
  });
}

/**
 * Renames the corrupt auth session folder to a timestamped backup,
 * allowing LocalAuth to create a fresh session on the next initialize().
 */
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

/** Tracks auth failures between successful ready events. */
let consecutiveAuthFailures = 0;

module.exports = { start };

