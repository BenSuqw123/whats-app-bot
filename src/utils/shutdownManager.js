'use strict';
const logger = require('./logger');
const health = require('./healthMonitor');
const stopHooks = [], cleanupTasks = [];
let shuttingDown = false, registered = false, shutdownPromise;
function registerStop(fn) { stopHooks.push(fn); }
function registerCleanup(name, fn) { cleanupTasks.push({ name, fn }); }
function shutdown(signal, code = 0) {
  if (shuttingDown) return shutdownPromise || Promise.resolve();
  shuttingDown = true;
  // Stop ingress/retries synchronously, before the first await or logger flush.
  for (const fn of stopHooks) { try { fn(); } catch (error) { console.error('[shutdown] stop hook failed', error); code = 1; } }
  shutdownPromise = (async () => {
    const killer = setTimeout(() => process.exit(1), 15000);
    logger.info('[shutdown] signal=' + signal + ' pid=' + process.pid);
    try {
      for (const task of cleanupTasks) {
        try { await task.fn(); }
        catch (error) { code = 1; logger.error('[shutdown] cleanup=' + task.name + ' ' + error.message, { stack: error.stack }); }
      }
      await health.printHealthSummary();
      health.stop();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        logger.once('finish', () => { clearTimeout(timer); resolve(); });
        logger.end();
      });
    } finally { clearTimeout(killer); process.exit(code); }
  })();
  return shutdownPromise;
}
function register() {
  if (registered) return;
  registered = true;
  process.once('SIGINT', () => { shutdown('SIGINT', 0); });
  process.once('SIGTERM', () => { shutdown('SIGTERM', 0); });
  // PM2 on Windows can use shutdown_with_message instead of Unix signals.
  process.on('message', message => { if (message === 'shutdown') shutdown('PM2 shutdown', 0); });
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, reason => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      logger.error('[process] ' + event + ' pid=' + process.pid + ' ' + error.message, { stack: error.stack });
      shutdown(event, 1);
    });
  }
  logger.on('error', error => { console.error('[logger] transport failure', error); shutdown('logger-fatal', 1); });
}
module.exports = { register, registerCleanup, registerStop, shutdown, isShuttingDown: () => shuttingDown };
