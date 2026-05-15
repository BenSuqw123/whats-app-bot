'use strict';

const config      = require('../config');
const logger      = require('../utils/logger');
const groupFilter = require('../utils/groupFilter');
const jidUtils    = require('../utils/jidUtils');
const mediaHandler = require('./mediaHandler');
const jsonStorage  = require('../services/jsonStorageService');
const health       = require('../utils/healthMonitor');

const DEDUP_TTL_MS = 10_000;
const DEDUP_MAX    = 2_000;
const seenIds      = new Map();

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

function getMessageId(message) {
  if (message.id) {
    if (message.id._serialized) return message.id._serialized;
    if (message.id.id) return message.id.id;
  }
  return `fallback_${Date.now()}_${Math.random()}`;
}

async function handle(message, _client) {
  try {
    const msgId = getMessageId(message);
    if (isDuplicate(msgId)) {
      logger.debug(`[messageHandler] Duplicate skipped: ${msgId}`);
      return;
    }

    const fromStr    = String(message.from || '');
    const isStatusBc = jidUtils.isStatusJid(fromStr);
    if (isStatusBc && !config.listenBroadcasts) { health.metrics.incSkipped(); return; }

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

    const { chatType, isGroup, isBroadcast, isDM } = jidUtils.detectChatType(fromStr, chat);

    if (isGroup     && !config.listenGroups)     { health.metrics.incSkipped(); return; }
    if (isDM        && !config.listenDMs)         { health.metrics.incSkipped(); return; }
    if (isBroadcast && !config.listenBroadcasts)  { health.metrics.incSkipped(); return; }

    if (isGroup && config.groupKeywords.length > 0) {
      const groupName = chat ? chat.name : undefined;
      if (!groupFilter.isAllowed(groupName)) { health.metrics.incSkipped(); return; }
    }

    let contact = {};
    try {
      contact = await message.getContact();
    } catch (_) {}

    const chatName   = (chat && chat.name) || contact.pushname || contact.number || 'Unknown';
    const rawAuthor  = message.author || message.from || '';
    const strippedJid = rawAuthor.replace(/@.*$/, '');
    const sender     = contact.pushname || contact.number || strippedJid || 'Unknown';

    const rawTs = message.timestamp;
    const tsMs  = rawTs && rawTs > 0 ? rawTs * 1000 : Date.now();

    // chatId is only included when chatName is unavailable or chatType is unknown,
    // because the folder structure already encodes chat identity for normal messages.
    const needsChatId = !chatName || chatName === 'Unknown' || chatType === 'unknown';

    let metadata = {
      id:       msgId,
      chatType,
      ...(needsChatId ? { chatId: fromStr } : {}),
      chatName,
      sender,
      timestamp: rawTs || Math.floor(tsMs / 1000),
      type:      message.type || 'unknown',
      body:      message.body || '',
    };

    if (message.hasMedia) {
      metadata = await mediaHandler.handle(message, metadata, msgId);
    }

    await jsonStorage.save(metadata);

    health.metrics.incMessage();
    const preview = metadata.body
      ? ` | "${metadata.body.slice(0, 60)}"`
      : (metadata.media ? ` | [${metadata.type}]` : '');
    logger.info(`[${chatType.toUpperCase()}] ${chatName} | ${sender}${preview}`);

  } catch (err) {
    logger.error(`[messageHandler] Unhandled error: ${err.message}`, { stack: err.stack });
  }
}

module.exports = { handle };
