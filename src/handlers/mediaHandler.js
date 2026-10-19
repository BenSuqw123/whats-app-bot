'use strict';

const path           = require('path');
const config         = require('../config');
const storageService = require('../services/storageService');
const logger         = require('../utils/logger');
const health         = require('../utils/healthMonitor');

const { resolveChatArchivePath } = storageService;

const { createMediaQueue } = require('../utils/mediaQueue');
const queue = createMediaQueue({ concurrency: config.mediaConcurrency,
  maxQueued: config.maxMediaQueue, timeoutMs: config.mediaDownloadTimeoutMs });

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

function applyMedia(metadata) {
  const item = metadata.mediaItems[0];
  if (item) metadata.media = item.skipped
    ? { mimetype: item.mimetype, size: item.size || 0, skipped: true }
    : { filename: item.filename, mimetype: item.mimetype, size: item.size, path: item.path };
  return metadata;
}
async function runBatch(messages, metadata, ids) {
  const completed = [];
  try {
    metadata.mediaItems = await queue.run(async signal => {
      for (let i = 0; i < messages.length; i++) {
        signal.throwIfAborted();
        const item = await _downloadItem(messages[i], metadata, ids[i], i, signal);
        signal.throwIfAborted();
        completed.push(item);
      }
      signal.throwIfAborted();
      return completed;
    });
  } catch (error) {
    logger.warn('[mediaHandler] Media batch skipped: ' + error.code + ' pid=' + process.pid);
    health.metrics.incMediaFail();
    // Preserve earlier successes if a later item in an album hits the batch deadline.
    metadata.mediaItems = ids.map((id, index) => completed[index] ||
      ({ messageId: id, index, skipped: true, error: error.code || 'MEDIA_FAILED' }));
  }
  return applyMedia(metadata);
}
function handle(message, metadata, msgId) { return runBatch([message], metadata, [msgId]); }
function handleAlbum(messages, metadata) {
  return runBatch(messages, metadata, messages.map(msg => msg.id?._serialized || msg.id?.id || 'unknown'));
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

async function _downloadItem(message, metadata, msgId, index, signal) {
  let media;
  try {
    const maxBytes = config.maxMediaSizeMb * 1024 * 1024;
    signal.throwIfAborted();
    media = await message.downloadMedia({ signal, maxBytes });
    signal.throwIfAborted();
    if (!media?.stream) throw new Error('Empty media stream');
    const mediaType = resolveMediaType(media.mimetype);
    const targetDir = path.join(resolveChatArchivePath(metadata), mediaType);
    let ext = media.filename ? path.extname(media.filename).replace(/^\./, '') : mimeToExt(media.mimetype);
    ext = (ext || mimeToExt(media.mimetype)).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
    const filename = timestampPrefixWithMs() + '_' + safePart(metadata.chatName) + '_album_' +
      String(index + 1).padStart(4, '0') + '_' + getShortHash(msgId) + '.' + ext;
    const { filePath, fileSize } = await storageService.saveMediaStream(media.stream, targetDir, filename, { signal, maxBytes });
    signal.throwIfAborted();
    health.metrics.incMediaOk();
    logger.info('[mediaHandler] Media saved bytes=' + fileSize + ' pid=' + process.pid);
    return { filename: path.basename(filePath), mimetype: media.mimetype, size: fileSize, path: filePath, messageId: msgId, index };
  } catch (error) {
    if (error.code === 'MEDIA_OVERSIZED') health.metrics.incMediaOversized();
    else health.metrics.incMediaFail();
    logger.warn('[mediaHandler] Download/save failed pid=' + process.pid + ' code=' + (error.code || 'MEDIA_FAILED'));
    return { messageId: msgId, index, skipped: true, error: error.code || 'MEDIA_FAILED' };
  } finally { media?.stream?.destroy(); }
}
module.exports = { handle, handleAlbum, queueStats: queue.stats, beginStop: queue.beginStop, stop: queue.stop };
