// src/config.js
'use strict';

/**
 * Production knobs — set via .env.
 * Validated at startup; bad values throw immediately rather than silently
 * degrading at runtime.
 */
/**
 * BUGS FIXED:
 *  1. dotenv.config() was called here, but logger.js was also requiring config,
 *     creating a potential partial-module cycle. logger.js now reads env vars
 *     directly, so config.js is the single source that loads dotenv.
 *
 *  2. groupKeywords were stored already lowercased here, which is correct, but
 *     the filter function was also lowercasing again unnecessarily. Kept the
 *     canonical lowercase here; filter now does a simple includes().
 *
 *  3. No validation existed — if an env var was set to a non-numeric value for
 *     RECONNECT_MAX_RETRIES or RECONNECT_DELAY_MS the parseInt would silently
 *     return NaN and the reconnect loop would never fire. Added validation.
 */

require('dotenv').config();

/** @type {string[]} */
const groupKeywords = process.env.GROUP_KEYWORDS
  ? process.env.GROUP_KEYWORDS
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)
  : [];

const reconnectMaxRetries = parseInt(process.env.RECONNECT_MAX_RETRIES || '10', 10);
const reconnectDelayMs    = parseInt(process.env.RECONNECT_DELAY_MS    || '5000', 10);

if (isNaN(reconnectMaxRetries) || reconnectMaxRetries < 1) {
  throw new Error('[config] RECONNECT_MAX_RETRIES must be a positive integer.');
}
if (isNaN(reconnectDelayMs) || reconnectDelayMs < 500) {
  throw new Error('[config] RECONNECT_DELAY_MS must be >= 500.');
}

/**
 * Central frozen configuration object.
 * @type {Readonly<object>}
 */
module.exports = Object.freeze({
  // ── Group filter ──────────────────────────────────────────────────────────
  // Already lowercased. Empty array = collect ALL groups.
  groupKeywords,

  // ── Chat type toggles ─────────────────────────────────────────────────────
  listenGroups:     process.env.LISTEN_GROUPS     !== 'false',
  listenDMs:        process.env.LISTEN_DMS        !== 'false',
  listenBroadcasts: process.env.LISTEN_BROADCASTS !== 'false',

  // ── Download directories ──────────────────────────────────────────────────
  downloadPaths: Object.freeze({
    images: './downloads/images',
    pdfs:   './downloads/pdfs',
    videos: './downloads/videos',
    audio:  './downloads/audio',
    files:  './downloads/files',
  }),

  // ── Metadata JSON output ──────────────────────────────────────────────────
  dataPath: './data/messages',

  // ── Auth session ──────────────────────────────────────────────────────────
  authPath: process.env.AUTH_PATH || './.wwebjs_auth',

  // ── Logging ───────────────────────────────────────────────────────────────
  logLevel: process.env.LOG_LEVEL || 'info',
  logPath:  process.env.LOG_PATH  || './logs',

  // ── Reconnect ─────────────────────────────────────────────────────────────
  reconnectMaxRetries,
  reconnectDelayMs,

  // ── Media safety ─────────────────────────────────────────────────────────
  // Maximum size (MB) of a single media file to download. Files larger than
  // this are skipped with a warning. Prevents OOM on 100 MB+ video floods.
  maxMediaSizeMb: parseInt(process.env.MAX_MEDIA_SIZE_MB || '50', 10),

  // Maximum number of media downloads processed concurrently.
  // Higher = faster but more RAM/disk pressure. Keep ≤ 3 on low-RAM servers.
  mediaConcurrency: parseInt(process.env.MEDIA_CONCURRENCY || '2', 10),

  // ── Health monitor ────────────────────────────────────────────────────────
  // How often (ms) to print a health summary line. Default: 5 min.
  healthIntervalMs: parseInt(process.env.HEALTH_INTERVAL_MS || '300000', 10),
});
