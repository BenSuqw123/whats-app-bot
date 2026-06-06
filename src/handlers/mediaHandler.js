'use strict';

const path           = require('path');
const config         = require('../config');
const storageService = require('../services/storageService');
const logger         = require('../utils/logger');
const health         = require('../utils/healthMonitor');

const { resolveChatArchivePath } = storageService;

let _active = 0;
const _queue = [];

function acquire() {
  if (_active < config.mediaConcurrency) {
    _active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _queue.push({ run: resolve });
  });
}

function release() {
  const next = _queue.shift();
  if (next) {
    next.run();
  } else {
    _active = Math.max(0, _active - 1);
  }
}

function resolveMediaType(mimetype) {
  if (!mimetype) return 'files';
  const m = mimetype.toLowerCase().split(';')[0].trim();
  if (m.startsWith('image/'))  return 'images';
  if (m === 'application/pdf') return 'pdfs';
  if (m.startsWith('video/'))  return 'videos';
  if (m.startsWith('audio/'))  return 'audio';
  return 'files';
}

function mimeToExt(mimetype) {
  const MIME_MAP = {
    'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/bmp':'bmp',
    'video/mp4':'mp4','video/3gpp':'3gp','video/3gpp2':'3g2','video/quicktime':'mov','video/webm':'webm',
    'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/opus':'opus','audio/wav':'wav','audio/aac':'aac','audio/webm':'weba',
    'application/pdf':'pdf','application/zip':'zip','application/x-zip-compressed':'zip',
    'application/msword':'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
    'application/vnd.ms-excel':'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
    'application/vnd.ms-powerpoint':'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
    'text/plain':'txt','text/csv':'csv',
  };
  const key = (mimetype || '').toLowerCase().split(';')[0].trim();
  return MIME_MAP[key] || 'bin';
}

function timestampPrefix() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safePart(str, maxLen = 40) {
  return String(str || 'unknown')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLen) || 'unknown';
}

function estimatedBytes(b64) {
  const len    = (b64 || '').length;
  const padded = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  return Math.floor(((len - padded) * 3) / 4);
}

/*
 * FALLBACK NOTE FOR ALBUM SUPPORT:
 * If whatsapp-web.js (wwebjs) cannot expose album child messages reliably due to WhatsApp Web internal changes,
 * it is recommended to transition to Baileys or Evolution API, which provide native/full protocol-level support 
 * for multi-media/album messages and allow reliable collection of all children.
 */

async function handle(message, metadata, msgId) {
  await acquire();
  try {
    metadata.mediaItems = [];
    const item = await _downloadItem(message, metadata, msgId, 0);
    if (item) {
      metadata.mediaItems.push(item);
      if (!item.skipped) {
        metadata.media = {
          filename: item.filename,
          mimetype: item.mimetype,
          size:     item.size,
          path:     item.path,
        };
      } else {
        metadata.media = {
          mimetype: item.mimetype || undefined,
          size:     item.size || 0,
          skipped:  true,
        };
      }
      logger.info(`[mediaHandler] Number of media items saved: 1`);
    } else {
      logger.info(`[mediaHandler] Number of media items saved: 0`);
    }
    return metadata;
  } finally {
    release();
  }
}

async function handleAlbum(messages, metadata) {
  metadata.mediaItems = [];
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const childId = msg.id?._serialized || msg.id?.id || `fallback_${Date.now()}_${Math.random()}`;
    await acquire();
    try {
      const item = await _downloadItem(msg, metadata, childId, i);
      if (item) {
        metadata.mediaItems.push(item);
      }
    } finally {
      release();
    }
  }

  // Populate metadata.media with the first item (backward compatibility)
  if (metadata.mediaItems.length > 0) {
    const firstItem = metadata.mediaItems[0];
    if (!firstItem.skipped) {
      metadata.media = {
        filename: firstItem.filename,
        mimetype: firstItem.mimetype,
        size:     firstItem.size,
        path:     firstItem.path,
      };
    } else {
      metadata.media = {
        mimetype: firstItem.mimetype || undefined,
        size:     firstItem.size || 0,
        skipped:  true,
      };
    }
  }

  logger.info(`[mediaHandler] Number of media items saved: ${metadata.mediaItems.length}`);
  return metadata;
}

function timestampPrefixWithMs() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const padMs = (n) => String(n).padStart(3, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${padMs(d.getMilliseconds())}`;
}

function getShortHash(str) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(String(str)).digest('hex').slice(0, 6);
}

async function _downloadItem(message, metadata, msgId, index = 0) {
  let media;
  try {
    media = await message.downloadMedia();
  } catch (err) {
    logger.error(`[mediaHandler] Failed media item: ${msgId}`);
    health.metrics.incMediaFail();
    return { messageId: msgId, index, skipped: true, error: err.message };
  }

  if (!media || !media.data) {
    logger.error(`[mediaHandler] Failed media item: ${msgId}`);
    health.metrics.incMediaFail();
    return { messageId: msgId, index, skipped: true, error: 'Empty payload' };
  }

  const maxBytes    = config.maxMediaSizeMb * 1024 * 1024;
  const approxBytes = estimatedBytes(media.data);

  if (approxBytes > maxBytes) {
    logger.warn(
      `[mediaHandler] Skipping oversized media: ~${(approxBytes / 1024 / 1024).toFixed(1)} MB ` +
      `> limit ${config.maxMediaSizeMb} MB (msg ${msgId || '?'})`
    );
    health.metrics.incMediaOversized();
    return { mimetype: media.mimetype || undefined, size: approxBytes, skipped: true, messageId: msgId, index };
  }

  const mediaType = resolveMediaType(media.mimetype);
  const targetDir = path.join(resolveChatArchivePath(metadata), mediaType);

  let ext = 'bin';
  if (media.filename) {
    const rawExt = path.extname(media.filename).replace(/^\./, '');
    ext = rawExt || mimeToExt(media.mimetype);
  } else {
    ext = mimeToExt(media.mimetype);
  }
  ext = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';

  const chatSafe = safePart(metadata.chatName);
  const formattedIndex = String(index + 1).padStart(4, '0');
  const msgHash = getShortHash(msgId);
  const filename = `${timestampPrefixWithMs()}_${chatSafe}_album_${formattedIndex}_${msgHash}.${ext}`;

  try {
    const { filePath, fileSize } = storageService.saveMedia(media.data, targetDir, filename);
    health.metrics.incMediaOk();
    const savedName = path.basename(filePath);
    logger.info(`[mediaHandler] Single media saved: ${savedName}`);
    return {
      filename: savedName,
      mimetype: media.mimetype || undefined,
      size:     fileSize,
      path:     filePath,
      messageId: msgId,
      index
    };
  } catch (err) {
    logger.error(`[mediaHandler] Failed media item: ${msgId}`);
    health.metrics.incMediaFail();
    return { messageId: msgId, index, skipped: true, error: err.message };
  }
}

function queueStats() {
  return { active: _active, queued: _queue.length };
}

module.exports = { handle, handleAlbum, queueStats };
