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

async function handle(message, metadata, msgId) {
  await acquire();
  try {
    return await _download(message, metadata, msgId);
  } finally {
    release();
  }
}

async function _download(message, metadata, msgId) {
  let media;
  try {
    media = await message.downloadMedia();
  } catch (err) {
    logger.warn(`[mediaHandler] downloadMedia() failed for ${msgId || '?'}: ${err.message}`);
    health.metrics.incMediaFail();
    return metadata;
  }

  if (!media || !media.data) {
    logger.warn(`[mediaHandler] Empty payload for ${msgId || '?'} — skipping.`);
    health.metrics.incMediaFail();
    return metadata;
  }

  const maxBytes    = config.maxMediaSizeMb * 1024 * 1024;
  const approxBytes = estimatedBytes(media.data);

  if (approxBytes > maxBytes) {
    logger.warn(
      `[mediaHandler] Skipping oversized media: ~${(approxBytes / 1024 / 1024).toFixed(1)} MB ` +
      `> limit ${config.maxMediaSizeMb} MB (msg ${msgId || '?'})`
    );
    health.metrics.incMediaOversized();
    metadata.mediaSkipped  = true;
    metadata.mediaMimetype = media.mimetype || null;
    metadata.mediaSize     = approxBytes;
    return metadata;
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

  const rawBase      = media.filename ? path.basename(media.filename, path.extname(media.filename)) : 'media';
  const filename     = `${timestampPrefix()}_${safePart(metadata.chatName)}_${safePart(rawBase)}.${ext}`;
  const uniqueSuffix = msgId ? String(msgId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : undefined;

  try {
    const { filePath, fileSize } = storageService.saveMedia(media.data, targetDir, filename, uniqueSuffix);
    metadata.mediaFilename = path.basename(filePath);
    metadata.mediaMimetype = media.mimetype || null;
    metadata.mediaSize     = fileSize;
    metadata.filePath      = filePath;
    metadata.mediaSkipped  = false;
    health.metrics.incMediaOk();
  } catch (err) {
    logger.error(`[mediaHandler] Failed to write media to disk: ${err.message}`);
    health.metrics.incMediaFail();
  }

  return metadata;
}

function queueStats() {
  return { active: _active, queued: _queue.length };
}

module.exports = { handle, queueStats };
