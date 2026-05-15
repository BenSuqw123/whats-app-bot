// src/utils/shutdownManager.js
'use strict';

/**
 * WHY THIS MODULE EXISTS:
 *
 * Without a coordinated shutdown:
 *  - In-flight JSON writes are abandoned mid-rename → corrupt .tmp files left on disk
 *  - Active media downloads are killed → partial binary files with valid filenames
 *  - The Puppeteer browser is not destroyed → zombie Chrome processes on the OS
 *  - The winston file transport buffer is not flushed → last N log lines are lost
 *  - Pending queue items simply vanish → data silently dropped
 *
 * This module is the single authority for all shutdown logic. It registers
 * signal handlers and exposes registerCleanup() so other modules can hook in
 * their own teardown without each needing to listen to process signals.
 */

const logger = require('./logger');
const health = require('./healthMonitor');

/** Maximum time (ms) to wait for all cleanup tasks to complete. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Whether a shutdown sequence is already in progress. */
let _shutdownInProgress = false;

/**
 * @type {Array<{ name: string, fn: () => Promise<void>|void }>}
 * Cleanup tasks registered by other modules, run in registration order.
 */
const _cleanupTasks = [];

/**
 * Registers a cleanup task to run during graceful shutdown.
 * Tasks are executed sequentially in the order they are registered.
 *
 * @param {string}                    name - Human-readable task name (for logs).
 * @param {() => Promise<void>|void}  fn   - Async or sync cleanup function.
 */
function registerCleanup(name, fn) {
  _cleanupTasks.push({ name, fn });
}

/**
 * Executes all registered cleanup tasks, then exits the process.
 * Enforces a hard timeout to prevent hanging on a stuck task.
 *
 * @param {string} signal - The signal or event that triggered shutdown.
 * @param {number} [code=0] - Exit code.
 */
async function shutdown(signal, code = 0) {
  if (_shutdownInProgress) return; // prevent re-entrant shutdown
  _shutdownInProgress = true;

  logger.info(`[shutdown] 🛑 Shutdown triggered by "${signal}". Running cleanup tasks...`);

  // Print final health snapshot before anything is torn down.
  try {
    await health.printHealthSummary();
  } catch (_) {}
  health.stop();

  // Set a hard timeout — if cleanup takes too long, force exit.
  const killer = setTimeout(() => {
    logger.error(`[shutdown] ⚠ Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit.`);
    process.exit(code || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (killer.unref) killer.unref();

  // Run each cleanup task in sequence.
  for (const task of _cleanupTasks) {
    try {
      logger.debug(`[shutdown] Running cleanup: "${task.name}"`);
      await Promise.resolve(task.fn());
      logger.debug(`[shutdown] ✓ "${task.name}" complete`);
    } catch (err) {
      logger.error(`[shutdown] ✗ "${task.name}" failed: ${err.message}`);
    }
  }

  // Flush winston transports — give file streams time to drain.
  await new Promise((resolve) => {
    logger.info('[shutdown] ✅ All cleanup complete. Goodbye.');
    logger.end();
    logger.once('finish', resolve);
    setTimeout(resolve, 2000); // safety net if 'finish' never fires
  });

  clearTimeout(killer);
  process.exit(code);
}

/**
 * Registers all OS signal handlers and the process error safety nets.
 * Call this ONCE from index.js, before bot.start().
 *
 * @param {{ getClient?: () => any }} [opts]
 */
function register(opts = {}) {
  // Graceful signals
  process.once('SIGINT',  () => shutdown('SIGINT',  0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));

  // Fatal errors — log and exit(1) after cleanup
  process.on('uncaughtException', (err) => {
    logger.error('[process] Uncaught exception:', err);
    shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[process] Unhandled rejection:', reason);
    // Do NOT shut down on every unhandledRejection — some are transient network
    // errors from whatsapp-web.js internals. Just log them.
  });

  logger.debug('[shutdown] Signal handlers registered.');
}

module.exports = { register, registerCleanup, shutdown };
