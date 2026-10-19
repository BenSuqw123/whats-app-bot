'use strict';
require('dotenv').config();
const path = require('path');
const { integer } = require('./utils/configValues');
const env = process.env;
const reconnectInitialDelayMs = integer(env, 'RECONNECT_INITIAL_DELAY_MS', env.RECONNECT_DELAY_MS || 5000, 500);
const reconnectMaxDelayMs = integer(env, 'RECONNECT_MAX_DELAY_MS', 120000, reconnectInitialDelayMs);
if (env.RECONNECT_MAX_RETRIES !== undefined) integer(env, 'RECONNECT_MAX_RETRIES', 10);
module.exports = Object.freeze({
  groupKeywords: (env.GROUP_KEYWORDS || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
  listenGroups: env.LISTEN_GROUPS !== 'false',
  listenDMs: env.LISTEN_DMS !== 'false',
  listenBroadcasts: env.LISTEN_BROADCASTS !== 'false',
  archiveBase: path.resolve(env.ARCHIVE_BASE || './archive'),
  authPath: path.resolve(env.AUTH_PATH || './.baileys_auth'),
  logLevel: env.LOG_LEVEL || 'info',
  logPath: path.resolve(env.LOG_PATH || './logs'),
  reconnectInitialDelayMs, reconnectMaxDelayMs,
  stableConnectionMs: integer(env, 'STABLE_CONNECTION_MS', 60000),
  connectionReadyTimeoutMs: integer(env, 'CONNECTION_READY_TIMEOUT_MS', 60000),
  socketEndTimeoutMs: integer(env, 'SOCKET_END_TIMEOUT_MS', 10000),
  maxMediaSizeMb: integer(env, 'MAX_MEDIA_SIZE_MB', 100, 1, 4096),
  mediaConcurrency: integer(env, 'MEDIA_CONCURRENCY', 1, 1, 16),
  healthIntervalMs: integer(env, 'HEALTH_INTERVAL_MS', 300000, 1000),
  mediaDownloadTimeoutMs: integer(env, 'MEDIA_DOWNLOAD_TIMEOUT_MS', 120000),
  maxMediaQueue: integer(env, 'MAX_MEDIA_QUEUE', 100),
  maxSeenAlbums: integer(env, 'MAX_SEEN_ALBUMS', 5000),
  seenAlbumTtlMs: integer(env, 'SEEN_ALBUM_TTL_MS', 1200000),
  maxAlbumBuffers: integer(env, 'MAX_ALBUM_BUFFERS', 100),
  maxAlbumItems: integer(env, 'MAX_ALBUM_ITEMS', 100),
  maxGroupCache: integer(env, 'MAX_GROUP_CACHE', 1000),
  groupCacheTtlMs: integer(env, 'GROUP_CACHE_TTL_MS', 900000),
});
