'use strict';

const logger = require('./logger');

let _timer = null;

const START_TIME = Date.now();

const _counters = {
  messagesProcessed:     0,
  messagesSkipped:       0,
  mediaDownloaded:       0,
  mediaFailed:           0,
  mediaSkippedOversized: 0,
  jsonWritten:           0,
  jsonFailed:            0,
  reconnects:            0,
  authFailures:          0,
  dedupHits:             0,
};

const inc = (key) => () => { _counters[key]++; };

const metrics = {
  incMessage:        inc('messagesProcessed'),
  incSkipped:        inc('messagesSkipped'),
  incMediaOk:        inc('mediaDownloaded'),
  incMediaFail:      inc('mediaFailed'),
  incMediaOversized: inc('mediaSkippedOversized'),
  incJsonOk:         inc('jsonWritten'),
  incJsonFail:       inc('jsonFailed'),
  incReconnect:      inc('reconnects'),
  incAuthFailure:    inc('authFailures'),
  incDedup:          inc('dedupHits'),
};

function measureEventLoopLag() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6;
      resolve(Math.round(lag));
    });
  });
}

function getStats() {
  const mem       = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;

  return {
    uptime:      `${h}h ${m}m ${s}s`,
    uptimeSec,
    heapUsedMB:  (mem.heapUsed  / 1024 / 1024).toFixed(1),
    heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
    rssMB:       (mem.rss       / 1024 / 1024).toFixed(1),
    ..._counters,
  };
}

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

function start(intervalMs = 300_000) {
  if (_timer) return;
  _timer = setInterval(async () => {
    try { await printHealthSummary(); } catch (_) {}
  }, intervalMs);

  if (_timer.unref) _timer.unref();

  logger.debug(`[health] Health monitor started (interval=${intervalMs}ms)`);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.debug('[health] Health monitor stopped.');
  }
}

module.exports = { start, stop, getStats, printHealthSummary, metrics };
