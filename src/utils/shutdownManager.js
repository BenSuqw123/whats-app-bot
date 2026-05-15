'use strict';

const logger = require('./logger');
const health = require('./healthMonitor');

const SHUTDOWN_TIMEOUT_MS = 15_000;

let _shutdownInProgress = false;

const _cleanupTasks = [];

function registerCleanup(name, fn) {
  _cleanupTasks.push({ name, fn });
}

async function shutdown(signal, code = 0) {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;

  logger.info(`[shutdown] 🛑 Shutdown triggered by "${signal}". Running cleanup tasks...`);

  try {
    await health.printHealthSummary();
  } catch (_) {}
  health.stop();

  const killer = setTimeout(() => {
    logger.error(`[shutdown] ⚠ Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit.`);
    process.exit(code || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (killer.unref) killer.unref();

  for (const task of _cleanupTasks) {
    try {
      logger.debug(`[shutdown] Running cleanup: "${task.name}"`);
      await Promise.resolve(task.fn());
      logger.debug(`[shutdown] ✓ "${task.name}" complete`);
    } catch (err) {
      logger.error(`[shutdown] ✗ "${task.name}" failed: ${err.message}`);
    }
  }

  await new Promise((resolve) => {
    logger.info('[shutdown] ✅ All cleanup complete. Goodbye.');
    logger.end();
    logger.once('finish', resolve);
    setTimeout(resolve, 2000);
  });

  clearTimeout(killer);
  process.exit(code);
}

function register(opts = {}) {
  process.once('SIGINT',  () => shutdown('SIGINT',  0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));

  process.on('uncaughtException', (err) => {
    logger.error('[process] Uncaught exception:', err);
    shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[process] Unhandled rejection:', reason);
  });

  logger.debug('[shutdown] Signal handlers registered.');
}

module.exports = { register, registerCleanup, shutdown };
