'use strict';

const pino = require('pino');
const logger = require('./logger');

const baileysLogger = pino({ level: 'silent' });
const groupMetadataCache = new Map();

async function getGroupMetadata(sock, groupId) {
  if (groupMetadataCache.has(groupId)) {
    return groupMetadataCache.get(groupId);
  }
  try {
    const metadata = await sock.groupMetadata(groupId);
    groupMetadataCache.set(groupId, metadata);
    return metadata;
  } catch (err) {
    logger.error(`[baileysWrapper] Failed to fetch group metadata for ${groupId}: ${err.message}`);
    return null;
  }
}

function getMessageContent(message) {
  if (!message) return null;
  if (message.ephemeralMessage) {
    return getMessageContent(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage) {
    return getMessageContent(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2) {
    return getMessageContent(message.viewOnceMessageV2.message);
  }
  if (message.documentWithCaptionMessage) {
    return getMessageContent(message.documentWithCaptionMessage.message);
  }
  return message;
}

function getMessageType(content) {
  if (!content) return 'unknown';
  if (content.conversation || content.extendedTextMessage) return 'chat';
  if (content.imageMessage) return 'image';
  if (content.videoMessage) return 'video';
  if (content.audioMessage) return 'audio';
  if (content.documentMessage) return 'document';
  if (content.stickerMessage) return 'sticker';
  return 'unknown';
}

function getMessageBody(content) {
  if (!content) return '';
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage) return content.extendedTextMessage.text;
  if (content.imageMessage) return content.imageMessage.caption || '';
  if (content.videoMessage) return content.videoMessage.caption || '';
  if (content.documentMessage) return content.documentMessage.caption || '';
  return '';
}

class BaileysMessageWrapper {
  constructor(msg, client) {
    this.rawMsg = msg;
    this.client = client;
    this.from = msg.key.remoteJid;
    this.author = msg.key.participant || msg.key.remoteJid;
    
    const participantSuffix = msg.key.participant ? `_${msg.key.participant}` : '';
    this.id = {
      _serialized: `${msg.key.fromMe ? 'true' : 'false'}_${msg.key.remoteJid}_${msg.key.id}${participantSuffix}`,
      id: msg.key.id,
      fromMe: msg.key.fromMe,
      remote: msg.key.remoteJid,
    };
    
    this.timestamp = Number(msg.messageTimestamp);
    
    const content = getMessageContent(msg.message);
    this.type = getMessageType(content);
    this.body = getMessageBody(content);
    this.hasMedia = !!(content && (
      content.imageMessage ||
      content.videoMessage ||
      content.documentMessage ||
      content.audioMessage ||
      content.stickerMessage
    ));
    
    this.rawData = msg;
    this._data = msg;
  }

  async getChat() {
    const isGroup = this.from.endsWith('@g.us');
    const isBroadcast = this.from.endsWith('@broadcast') || this.from === 'status@broadcast';
    let name = 'Unknown';
    if (isGroup) {
      const metadata = await getGroupMetadata(this.client, this.from);
      if (metadata) name = metadata.subject;
    } else {
      name = this.rawMsg.pushName || this.from.split('@')[0] || 'Unknown';
    }
    return {
      id: this.from,
      name,
      isGroup,
      isBroadcast,
      isDM: !isGroup && !isBroadcast,
    };
  }

  async getContact() {
    return {
      pushname: this.rawMsg.pushName || null,
      number: this.author.split('@')[0] || null,
    };
  }

  async downloadMedia() {
    const content = getMessageContent(this.rawMsg.message);
    if (!content) return null;
    
    let mediaKey = null;
    for (const key of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage']) {
      if (content[key]) {
        mediaKey = key;
        break;
      }
    }
    if (!mediaKey) return null;
    const mediaInfo = content[mediaKey];
    
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const buffer = await downloadMediaMessage(
      this.rawMsg,
      'buffer',
      {},
      { logger: baileysLogger }
    );

    if (!buffer) return null;

    return {
      mimetype: mediaInfo.mimetype,
      data: buffer.toString('base64'),
      filename: mediaInfo.fileName || mediaInfo.filename || null,
      filesize: mediaInfo.fileLength ? Number(mediaInfo.fileLength) : buffer.length,
    };
  }
}

module.exports = { BaileysMessageWrapper, getMessageContent };
