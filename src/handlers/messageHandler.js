// src/handlers/messageHandler.js
'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const groupFilter = require('../utils/groupFilter');
const jidUtils = require('../utils/jidUtils');
const mediaHandler = require('./mediaHandler');
const jsonStorage = require('../services/jsonStorageService');
const health = require('../utils/healthMonitor');

// ── Deduplication cache ──────────────────────────────────────────────────────
const DEDUP_TTL_MS = 10_000;
const DEDUP_MAX = 2_000;
/** @type {Map<string, number>} */
const seenIds = new Map();

function isDuplicate(msgId) {
  const now = Date.now();
  if (seenIds.size >= DEDUP_MAX) {
    for (const [id, ts] of seenIds) {
      if (now - ts > DEDUP_TTL_MS) seenIds.delete(id);
    }
  }
  if (seenIds.has(msgId)) { health.metrics.incDedup(); return true; }
  seenIds.set(msgId, now);
  return false;
}

/**
 * Determines the canonical message ID string from a whatsapp-web.js message.
 *
 * @param {import('whatsapp-web.js').Message} message
 * @returns {string}
 */
function getMessageId(message) {
  if (message.id) {
    if (message.id._serialized) return message.id._serialized;
    if (message.id.id) return message.id.id;
  }
  // Last resort — not globally unique but prevents a crash
  return `fallback_${Date.now()}_${Math.random()}`;
}

/**
 * Main entry point for every incoming WhatsApp message.
 *
 * @param {import('whatsapp-web.js').Message} message
 * @param {import('whatsapp-web.js').Client}  _client  (reserved for future use)
 * @returns {Promise<void>}
 */
async function handle(message, _client) {
  try {
    // ── Step 1: Skip own messages ───────────────────────────────────────────
    // if (message.fromMe) return;

    // ── Step 2: Deduplication (message + message_create both fire) ──────────
    const msgId = getMessageId(message);
    if (isDuplicate(msgId)) {
      logger.debug(`[messageHandler] Duplicate skipped: ${msgId}`);
      return;
    }

    // ── Step 3: JID-based broadcast pre-check (avoid getChat() throw) ─────────
    const fromStr = String(message.from || '');
    const isStatusBc = jidUtils.isStatusJid(fromStr);
    if (isStatusBc && !config.listenBroadcasts) { health.metrics.incSkipped(); return; }

    // ── Step 4: Fetch chat for definitive type resolution ─────────────────────
    let chat = null;
    if (!isStatusBc) {
      try {
        chat = await message.getChat();
      } catch (err) {
        logger.error(`[messageHandler] getChat() failed for ${msgId}: ${err.message}`);
        health.metrics.incSkipped();
        return;
      }
    }

    // Use jidUtils for authoritative type (handles @lid, @g.us, @broadcast)
    const { chatType, isGroup, isBroadcast, isDM } = jidUtils.detectChatType(fromStr, chat);

    if (isGroup && !config.listenGroups) { health.metrics.incSkipped(); return; }
    if (isDM && !config.listenDMs) { health.metrics.incSkipped(); return; }
    if (isBroadcast && !config.listenBroadcasts) { health.metrics.incSkipped(); return; }

    // ── Step 6: Keyword filter (groups only) ────────────────────────────────
    if (isGroup && config.groupKeywords.length > 0) {
      const groupName = chat ? chat.name : undefined;
      if (!groupFilter.isAllowed(groupName)) { health.metrics.incSkipped(); return; }
    }

    // ── Step 7: Resolve sender info ─────────────────────────────────────────
    let contact = {};
    try {
      contact = await message.getContact();
    } catch (_) {
      // Non-fatal — use empty defaults below
    }

    const chatName = (chat && chat.name) || contact.pushname || contact.number || 'Unknown';

    // Sender: prefer pushname → number → message.author (group sender JID) →
    // strip the @lid/@c.us suffix from the raw JID as a last resort.
    const rawAuthor = message.author || message.from || '';
    const strippedJid = rawAuthor.replace(/@.*$/, '');
    const sender = contact.pushname || contact.number || strippedJid || 'Unknown';

    // ── Step 8: Safe timestamp ──────────────────────────────────────────────
    const rawTs = message.timestamp;
    const tsMs = rawTs && rawTs > 0 ? rawTs * 1000 : Date.now();
    const timestampISO = new Date(tsMs).toISOString();

    // ── Step 9: Build metadata record ────────────────────────────────────────
    let metadata = {
      id: msgId,
      chatType,
      chatId: fromStr,
      chatName,
      sender,
      senderNumber: contact.number || null,
      timestamp: rawTs || Math.floor(tsMs / 1000),
      timestampISO,
      type: message.type || 'unknown',
      body: message.body || null,
      hasMedia: message.hasMedia || false,
      mediaFilename: null,
      mediaMimetype: null,
      mediaSize: null,
      filePath: null,
    };

    // ── Step 10: Download media if present ───────────────────────────────────
    if (message.hasMedia) {
      metadata = await mediaHandler.handle(message, metadata, msgId);
    }

    // ── Step 11: Persist to NDJSON (O(1) append) ────────────────────────────
    await jsonStorage.save(metadata);

    // ── Step 12: Log + health counters ───────────────────────────────────────
    health.metrics.incMessage();
    const preview = metadata.body
      ? ` | "${metadata.body.slice(0, 60)}"`
      : (metadata.mediaFilename ? ` | [${metadata.type}]` : '');
    logger.info(`[${chatType.toUpperCase()}] ${chatName} | ${sender}${preview}`);

  } catch (err) {
    logger.error(`[messageHandler] Unhandled error: ${err.message}`, { stack: err.stack });
  }
}

module.exports = { handle };
