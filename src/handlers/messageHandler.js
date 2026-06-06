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

const albumBuffers = new Map();
const seenAlbums = new Set();

/*
 * MIGRATION NOTE FOR BAILEYS ALBUM SUPPORT:
 * whatsapp-web.js had a severe limitation where album parent was type=album, hasMedia=false, 
 * childMessages=null and hidden "+N" media were not downloadable reliably.
 * Therefore, the project has been refactored to use Baileys as the message ingestion layer.
 * Because Baileys emits individual media messages separately, we group nearby media messages
 * by chatId + senderJid + timestamp window to reconstruct albums reliably.
 */

function getAlbumId(message) {
  if (message.type === 'album') {
    return getMessageId(message);
  }
  const raw = message.rawData || message._data || {};
  if (raw.type === 'album') {
    return getMessageId(message);
  }
  if (raw.mediaGroupId) return String(raw.mediaGroupId);
  if (raw.albumId) return String(raw.albumId);
  if (raw.parentMsgId) return String(raw.parentMsgId);
  if (Array.isArray(raw.childMessages) && raw.childMessages.length > 0) {
    return getMessageId(message);
  }
  return null;
}

function findGroupId(message, fromStr) {
  const explicitId = getAlbumId(message);
  if (explicitId) {
    return { groupId: explicitId, isExplicit: true };
  }

  // Otherwise, look for an active buffer in the same chat within 5 seconds for the same sender
  const senderId = message.author || message.from || '';
  const nowSec = message.timestamp || Math.floor(Date.now() / 1000);
  for (const [groupId, group] of albumBuffers.entries()) {
    if (group.fromStr === fromStr && group.senderId === senderId && !group.isExplicit) {
      if (Math.abs(group.timestamp - nowSec) <= 5) {
        return { groupId, isExplicit: false };
      }
    }
  }

  // Otherwise, generate a new window-based group ID
  const newGroupId = `window_${fromStr}_${senderId}_${nowSec}_${Math.random().toString(36).substring(2, 7)}`;
  return { groupId: newGroupId, isExplicit: false };
}

async function finalizeAlbumBatch(groupId, client) {
  const group = albumBuffers.get(groupId);
  if (!group) return;
  albumBuffers.delete(groupId);
  seenAlbums.add(groupId);

  logger.info(`[messageHandler] album batch finalized: ${groupId}`);

  try {
    const uniqueMessagesMap = new Map();

    for (const msg of group.messages) {
      const msgId = getMessageId(msg);
      if (msg.hasMedia) {
        uniqueMessagesMap.set(msgId, msg);
      }

      const raw = msg.rawData || msg._data || {};
      if (Array.isArray(raw.childMessages)) {
        for (const childData of raw.childMessages) {
          const { BaileysMessageWrapper } = require('../utils/baileysWrapper');
          const childMsg = new BaileysMessageWrapper(childData, client);
          const childId = getMessageId(childMsg);
          if (childMsg.hasMedia) {
            uniqueMessagesMap.set(childId, childMsg);
          }
        }
      }
    }

    const uniqueMessages = Array.from(uniqueMessagesMap.values());
    logger.info(`[messageHandler] Child count: ${uniqueMessages.length}`);

    let metadata = group.metadata;
    if (uniqueMessages.length === 1 && !group.isExplicit) {
      const singleMsg = uniqueMessages[0];
      const singleId = getMessageId(singleMsg);
      metadata.id = singleId;
      metadata.type = singleMsg.type || 'image';
      metadata.body = singleMsg.body || metadata.body;
      
      seenIds.set(singleId, Date.now());
      seenIds.set(groupId, Date.now());
    } else {
      for (const msgId of uniqueMessagesMap.keys()) {
        seenIds.set(msgId, Date.now());
      }
      seenIds.set(groupId, Date.now());
      
      let body = '';
      for (const msg of group.messages) {
        if (msg.body) {
          body = msg.body;
          break;
        }
      }
      metadata.body = body;
    }

    if (uniqueMessages.length === 0) {
      logger.warn(`[messageHandler] Album batch ${groupId} finalized with 0 media items.`);
      return;
    }

    if (uniqueMessages.length === 1 && !group.isExplicit) {
      metadata = await mediaHandler.handle(uniqueMessages[0], metadata, metadata.id);
    } else {
      metadata = await mediaHandler.handleAlbum(uniqueMessages, metadata);
    }

    await jsonStorage.save(metadata);
    health.metrics.incMessage();
    
    const preview = metadata.body
      ? ` | "${metadata.body.slice(0, 60)}"`
      : (metadata.mediaItems && metadata.mediaItems.length > 0 ? ` | [album:${metadata.mediaItems.length} items]` : (metadata.media ? ` | [${metadata.type}]` : ''));
    logger.info(`[${metadata.chatType.toUpperCase()}] ${metadata.chatName} | ${metadata.sender}${preview}`);

  } catch (err) {
    logger.error(`[messageHandler] Error finalising album batch ${groupId}: ${err.message}`, { stack: err.stack });
  }
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

    const isMedia = message.hasMedia;
    const albumIdInfo = getAlbumId(message);
    const isAlbumCandidate = isMedia || message.type === 'album' || albumIdInfo !== null;

    if (isAlbumCandidate) {
      const { groupId, isExplicit } = findGroupId(message, fromStr);
      
      logger.info(`[messageHandler] album candidate detected: ${groupId} (isExplicit: ${isExplicit})`);

      if (seenAlbums.has(groupId)) {
        logger.debug(`[messageHandler] Album group ${groupId} already processed — skipping individual message.`);
        return;
      }

      let group = albumBuffers.get(groupId);
      if (!group) {
        const senderId = message.author || message.from || '';
        group = {
          groupId,
          isExplicit,
          fromStr,
          senderId,
          timestamp: message.timestamp || Math.floor(Date.now() / 1000),
          messages: [],
          metadata: { ...metadata, id: groupId, type: 'album' },
          timer: null,
        };
        albumBuffers.set(groupId, group);

        group.timer = setTimeout(() => {
          finalizeAlbumBatch(groupId, _client).catch(err => {
            logger.error(`[messageHandler] Error finalising album batch: ${err.message}`);
          });
        }, 1500);
      }

      group.messages.push(message);
    } else {
      await jsonStorage.save(metadata);
      health.metrics.incMessage();
      const preview = metadata.body ? ` | "${metadata.body.slice(0, 60)}"` : '';
      logger.info(`[${chatType.toUpperCase()}] ${chatName} | ${sender}${preview}`);
    }

  } catch (err) {
    logger.error(`[messageHandler] Unhandled error: ${err.message}`, { stack: err.stack });
  }
}

module.exports = { handle };
