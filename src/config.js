'use strict';

require('dotenv').config();

const groupKeywords = process.env.GROUP_KEYWORDS
  ? process.env.GROUP_KEYWORDS
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
  : [];

const reconnectMaxRetries = parseInt(process.env.RECONNECT_MAX_RETRIES || '10', 10);
const reconnectDelayMs = parseInt(process.env.RECONNECT_DELAY_MS || '5000', 10);

if (isNaN(reconnectMaxRetries) || reconnectMaxRetries < 1) {
  throw new Error('[config] RECONNECT_MAX_RETRIES must be a positive integer.');
}
if (isNaN(reconnectDelayMs) || reconnectDelayMs < 500) {
  throw new Error('[config] RECONNECT_DELAY_MS must be >= 500.');
}

module.exports = Object.freeze({
  groupKeywords,

  listenGroups: process.env.LISTEN_GROUPS !== 'false',
  listenDMs: process.env.LISTEN_DMS !== 'false',
  listenBroadcasts: process.env.LISTEN_BROADCASTS !== 'false',

  archiveBase: process.env.ARCHIVE_BASE || './archive',

  authPath: process.env.AUTH_PATH || './.wwebjs_auth',

  logLevel: process.env.LOG_LEVEL || 'info',
  logPath: process.env.LOG_PATH || './logs',

  reconnectMaxRetries,
  reconnectDelayMs,

  maxMediaSizeMb: parseInt(process.env.MAX_MEDIA_SIZE_MB || '100', 10),
  mediaConcurrency: parseInt(process.env.MEDIA_CONCURRENCY || '1', 10),
  healthIntervalMs: parseInt(process.env.HEALTH_INTERVAL_MS || '300000', 10),
});
