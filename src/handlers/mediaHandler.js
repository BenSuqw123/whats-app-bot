// src/handlers/mediaHandler.js
'use strict';

/**
 * PRODUCTION HARDENING IN THIS VERSION:
 *
 * 1. OOM PREVENTION — MAX MEDIA SIZE:
 *    A 100 MB video arrives as base64 in memory. Buffer.from(base64) allocates
 *    another 100 MB. Peak RAM for a single download = 200 MB. With 3 concurrent
 *    downloads: 600 MB spike → OOM kill on a 1 GB VPS.
 *    FIX: Check media.data length BEFORE allocating the Buffer. Base64 encoding
 *    inflates by ~33%, so: maxBytes = maxMediaSizeMb * 1024 * 1024 * 1.34.
 *    If the encoded string exceeds this, skip the download and log a warning.
 *
 * 2. BACKPRESSURE — BOUNDED CONCURRENCY QUEUE:
 *    Without a queue, 50 media messages arriving simultaneously would trigger
 *    50 concurrent downloadMedia() calls, each loading the full payload into RAM.
 *    FIX: A semaphore-style queue limits concurrent downloads to config.mediaConcurrency.
 *    Excess requests wait in a FIFO queue. The queue depth is tracked in healthMonitor.
 *
 * 3. HEALTH METRICS:
 *    mediaHandler now calls health.metrics.incMediaOk/Fail/Oversized so that
 *    the periodic health summary reflects real download statistics.
 */

const path           = require('path');
const config         = require('../config');
const storageService = require('../services/storageService');
const logger         = require('../utils/logger');
const health         = require('../utils/healthMonitor');

// ── Concurrency semaphore ────────────────────────────────────────────────────

/** Number of media downloads currently in progress. */
let _active = 0;

/** FIFO queue of pending download tasks: Array<{ run: () => void }> */
const _queue = [];

/**
 * Acquires a concurrency slot. If all slots are taken, the caller waits
 * until one becomes available.
 *
 * @returns {Promise<void>}
 */
function acquire() {
  if (_active < config.mediaConcurrency) {
    _active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _queue.push({ run: resolve });
  });
}

/**
 * Releases a concurrency slot, unblocking the next waiting task if any.
 */
function release() {
  const next = _queue.shift();
  if (next) {
    next.run();         // immediately pass the slot to the next waiter
  } else {
    _active = Math.max(0, _active - 1);
  }
}

// ── MIME helpers (unchanged from previous version) ──────────────────────────

function resolveDirectory(mimetype) {
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

// ── Max-size guard ───────────────────────────────────────────────────────────

/**
 * Returns the estimated decoded byte count from a base64 string length.
 * Base64 encodes 3 bytes as 4 characters; padding may add 1–2 chars.
 *
 * @param {string} b64
 * @returns {number}
 */
function estimatedBytes(b64) {
  const len = (b64 || '').length;
  // Remove padding chars before calculation
  const padded = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  return Math.floor(((len - padded) * 3) / 4);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Downloads and saves media for a WhatsApp message, enforcing the configured
 * max size limit and bounded concurrency.
 *
 * @param {import('whatsapp-web.js').Message} message
 * @param {object} metadata
 * @param {string} [msgId]
 * @returns {Promise<object>} Updated metadata.
 */
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

  // ── Size guard ─────────────────────────────────────────────────────────────
  const maxBytes = config.maxMediaSizeMb * 1024 * 1024;
  const approxBytes = estimatedBytes(media.data);

  if (approxBytes > maxBytes) {
    logger.warn(
      `[mediaHandler] Skipping oversized media: ~${(approxBytes / 1024 / 1024).toFixed(1)} MB ` +
      `> limit ${config.maxMediaSizeMb} MB (msg ${msgId || '?'})`
    );
    health.metrics.incMediaOversized();
    // Still record that media existed, just not downloaded
    metadata.mediaSkipped   = true;
    metadata.mediaMimetype  = media.mimetype || null;
    metadata.mediaSize      = approxBytes;
    return metadata;
  }

  // ── Determine destination ──────────────────────────────────────────────────
  const VALID_KEYS = new Set(Object.keys(config.downloadPaths));
  const dirKey     = resolveDirectory(media.mimetype);
  const safeKey    = VALID_KEYS.has(dirKey) ? dirKey : 'files';
  const targetDir  = config.downloadPaths[safeKey];

  // ── Build filename ─────────────────────────────────────────────────────────
  let ext = 'bin';
  if (media.filename) {
    const rawExt = path.extname(media.filename).replace(/^\./, '');
    ext = rawExt || mimeToExt(media.mimetype);
  } else {
    ext = mimeToExt(media.mimetype);
  }
  ext = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';

  const rawBase  = media.filename ? path.basename(media.filename, path.extname(media.filename)) : 'media';
  const filename = `${timestampPrefix()}_${safePart(metadata.chatName)}_${safePart(rawBase)}.${ext}`;
  const uniqueSuffix = msgId ? String(msgId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : undefined;

  // ── Write to disk ──────────────────────────────────────────────────────────
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

/**
 * Returns current queue depth and active download count for monitoring.
 *
 * @returns {{ active: number, queued: number }}
 */
function queueStats() {
  return { active: _active, queued: _queue.length };
}

module.exports = { handle, queueStats };
