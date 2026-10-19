'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { load, flush, logger } = require('./helpers');

test('every numeric env is strictly validated by the production config module', () => {
  const keys = ['MEDIA_CONCURRENCY', 'MAX_MEDIA_SIZE_MB', 'HEALTH_INTERVAL_MS', 'RECONNECT_INITIAL_DELAY_MS',
    'RECONNECT_MAX_DELAY_MS', 'STABLE_CONNECTION_MS', 'CONNECTION_READY_TIMEOUT_MS', 'MEDIA_DOWNLOAD_TIMEOUT_MS',
    'MAX_MEDIA_QUEUE', 'MAX_SEEN_ALBUMS', 'SEEN_ALBUM_TTL_MS', 'MAX_ALBUM_BUFFERS', 'MAX_ALBUM_ITEMS',
    'MAX_GROUP_CACHE', 'GROUP_CACHE_TTL_MS', 'SOCKET_END_TIMEOUT_MS'];
  for (const key of keys) for (const value of ['10abc', 'NaN', '0', '-1']) {
    assert.throws(() => load('src/config.js', { dotenv: { config() {} }, $process: { env: { [key]: value } } }), new RegExp(key));
  }
  const defaults = load('src/config.js', { dotenv: { config() {} }, $process: { env: {} } });
  assert.equal(defaults.reconnectMaxDelayMs, 120000); assert.equal(defaults.maxMediaQueue, 100);
});
test('fatal policy exits 1 and synchronous stop hooks disable ingress before cleanup awaits', async () => {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    const proc = new EventEmitter(), log = new EventEmitter(); const exits = [];
    proc.pid = 123; proc.exit = code => exits.push(code);
    Object.assign(log, logger, { end() { this.emit('finish'); } });
    let stopped = false, resolveCleanup;
    const manager = load('src/utils/shutdownManager.js', { './logger': log,
      './healthMonitor': { printHealthSummary: async () => {}, stop() {} }, $process: proc });
    manager.registerStop(() => { stopped = true; });
    manager.registerCleanup('test', () => new Promise(resolve => { resolveCleanup = resolve; }));
    manager.register(); proc.emit(event, new Error('fatal')); assert(stopped); assert(manager.isShuttingDown());
    await flush(); assert.deepEqual(exits, []); resolveCleanup(); await flush(); assert.deepEqual(exits, [1]);
  }
});
test('Windows PM2 shutdown IPC uses the graceful path once', async () => {
  const proc = new EventEmitter(), log = new EventEmitter(); const exits = []; let cleanups = 0;
  proc.exit = code => exits.push(code); Object.assign(log, logger, { end() { this.emit('finish'); } });
  const manager = load('src/utils/shutdownManager.js', { './logger': log, $process: proc,
    './healthMonitor': { printHealthSummary: async () => {}, stop() {} } });
  manager.registerCleanup('test', async () => { cleanups++; }); manager.register();
  proc.emit('message', 'shutdown'); proc.emit('message', 'shutdown'); await flush();
  assert.equal(cleanups, 1); assert.deepEqual(exits, [0]);
});
test('health distinguishes auth-required/no traffic and records successful persistence only', async () => {
  const logs = [];
  const health = load('src/utils/healthMonitor.js', { './logger': { ...logger, info: text => logs.push(text) } });
  health.registerProvider('socket', () => ({ connectionState: 'AUTH_REQUIRED', lastMessageReceivedAt: null, reconnectAttempt: 12 }));
  health.registerProvider('queue', () => ({ mediaQueued: 4, mediaActive: 1 }));
  assert.equal(health.getStats().lastMessagePersistedAt, null); health.markPersisted();
  const stats = health.getStats(); assert.equal(stats.connectionState, 'AUTH_REQUIRED'); assert(stats.lastMessagePersistedAt);
  assert(stats.externalMB); assert(stats.arrayBuffersMB); await health.printHealthSummary(); assert.equal(logs.length, 1);
});
