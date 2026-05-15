// src/utils/healthMonitor.js
'use strict';

/**
 * WHY THIS MODULE EXISTS:
 *
 * A bot running 24/7 can silently degrade — memory climbs, the event loop
 * stalls, reconnects accumulate, media downloads start failing — all without
 * any obvious error. Without periodic telemetry, these conditions go undetected
 * until the process crashes or the user notices data is no longer being saved.
 *
 * This module maintains runtime counters and prints a structured health summary
 * every N minutes (default: 5). It also exposes the counters so that
 * shutdownManager.js can include them in the final shutdown report.
 */

const logger = require('./logger');

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/** Start time of the current process. */
const START_TIME = Date.now();

/**
 * Live counters — mutated directly by callers via the increment helpers below.
 * Exported as a frozen-view snapshot by getStats().
 */
const _counters = {
  messagesProcessed:   0,
  messagesSkipped:     0,
  mediaDownloaded:     0,
  mediaFailed:         0,
  mediaSkippedOversized: 0,
  jsonWritten:         0,
  jsonFailed:          0,
  reconnects:          0,
  authFailures:        0,
  dedupHits:           0,
};

// ── Increment helpers ────────────────────────────────────────────────────────
const inc = (key) => () => { _counters[key]++; };

const metrics = {
  incMessage:          inc('messagesProcessed'),
  incSkipped:          inc('messagesSkipped'),
  incMediaOk:          inc('mediaDownloaded'),
  incMediaFail:        inc('mediaFailed'),
  incMediaOversized:   inc('mediaSkippedOversized'),
  incJsonOk:           inc('jsonWritten'),
  incJsonFail:         inc('jsonFailed'),
  incReconnect:        inc('reconnects'),
  incAuthFailure:      inc('authFailures'),
  incDedup:            inc('dedupHits'),
};

/**
 * Measures the current Node.js event-loop lag in milliseconds by scheduling a
 * zero-delay timer and measuring how long it actually takes to fire.
 * Lag > 100 ms indicates the event loop is being blocked by synchronous work.
 *
 * @returns {Promise<number>} Lag in ms.
 */
function measureEventLoopLag() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6; // ns → ms
      resolve(Math.round(lag));
    });
  });
}

/**
 * Returns a point-in-time snapshot of all health metrics.
 *
 * @returns {object}
 */
function getStats() {
  const mem     = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;

  return {
    uptime:    `${h}h ${m}m ${s}s`,
    uptimeSec,
    heapUsedMB:  (mem.heapUsed  / 1024 / 1024).toFixed(1),
    heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
    rssMB:       (mem.rss       / 1024 / 1024).toFixed(1),
    ..._counters,
  };
}

/**
 * Prints a single-line health summary to the logger at INFO level.
 * Called automatically on the periodic interval.
 */
async function printHealthSummary() {
  const lag   = await measureEventLoopLag();
  const stats = getStats();

  logger.info(
    `[health] uptime=${stats.uptime} | heap=${stats.heapUsedMB}/${stats.heapTotalMB}MB ` +
    `rss=${stats.rssMB}MB | evLoop=${lag}ms | ` +
    `msgs=${stats.messagesProcessed} skip=${stats.messagesSkipped} dedup=${stats.dedupHits} | ` +
    `media=ok:${stats.mediaDownloaded} fail:${stats.mediaFailed} big:${stats.mediaSkippedOversized} | ` +
    `json=ok:${stats.jsonWritten} fail:${stats.jsonFailed} | ` +
    `reconnects=${stats.reconnects} authFail=${stats.authFailures}`
  );

  if (lag > 200) {
    logger.warn(`[health] ⚠ Event loop lag is HIGH: ${lag}ms — check for blocking synchronous I/O`);
  }
  if (parseFloat(stats.heapUsedMB) > 300) {
    logger.warn(`[health] ⚠ Heap usage is HIGH: ${stats.heapUsedMB}MB — possible memory leak`);
  }
}

/**
 * Starts the periodic health-summary timer.
 *
 * @param {number} [intervalMs=300_000] Interval between summaries (default 5 min).
 */
function start(intervalMs = 300_000) {
  if (_timer) return; // idempotent
  _timer = setInterval(async () => {
    try { await printHealthSummary(); } catch (_) { /* never crash health monitor */ }
  }, intervalMs);

  // Don't let the timer keep the process alive on its own.
  if (_timer.unref) _timer.unref();

  logger.debug(`[health] Health monitor started (interval=${intervalMs}ms)`);
}

/**
 * Stops the periodic timer. Safe to call multiple times.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.debug('[health] Health monitor stopped.');
  }
}

module.exports = { start, stop, getStats, printHealthSummary, metrics };
