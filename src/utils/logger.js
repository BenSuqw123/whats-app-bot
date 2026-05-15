// src/utils/logger.js
'use strict';

/**
 * BUGS FIXED:
 *  1. CIRCULAR DEPENDENCY: logger.js required config.js, which itself would
 *     require logger.js the moment any module touched config first. Node's
 *     module cache partially resolves this, but the logger could receive an
 *     incomplete config object (e.g. logLevel = undefined → Winston defaults
 *     to 'silly', logging everything, including secrets).
 *     FIX: Read LOG_LEVEL and LOG_PATH directly from process.env here.
 *     dotenv is loaded by config.js which is required by index.js first, so
 *     process.env is already populated by the time any other module loads.
 *
 *  2. CRASH ON STARTUP: If the logs/ directory cannot be created (permission
 *     denied) the synchronous mkdirSync throws and the entire process exits
 *     before any log message is written. FIX: wrap in try/catch and fall back
 *     to console-only mode.
 *
 *  3. TIMESTAMP COLLISION: The printf format called level.toUpperCase() but
 *     Winston already stores the level in lowercase. Calling toUpperCase()
 *     inside printf is fine, but colorize() wraps the level string with ANSI
 *     codes BEFORE it reaches printf, so toUpperCase() of a colorized string
 *     is a no-op. FIX: Use separate formats for console vs file so that ANSI
 *     codes never appear in file logs and the manual toUpperCase() only runs
 *     on file output where it is needed.
 */

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

// Read directly from env — dotenv.config() has already run in config.js
// which is required before logger in every code path.
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_PATH  = process.env.LOG_PATH  || './logs';

// Ensure log directory exists; fall back gracefully if it cannot be created.
let logDirOk = false;
try {
  fs.mkdirSync(LOG_PATH, { recursive: true });
  logDirOk = true;
} catch (e) {
  // Will use console-only transport below.
}

// Shared format for file transports (no ANSI codes).
const fileFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, stack }) => {
    const lvl = level.toUpperCase().padEnd(5);
    return stack
      ? `[${timestamp}] [${lvl}] ${message}\n${stack}`
      : `[${timestamp}] [${lvl}] ${message}`;
  })
);

// Format for console: colorize first, then apply the same printf.
const consoleFormat = format.combine(
  format.colorize({ all: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, stack }) => {
    return stack
      ? `[${timestamp}] [${level}] ${message}\n${stack}`
      : `[${timestamp}] [${level}] ${message}`;
  })
);

const activeTransports = [
  new transports.Console({ format: consoleFormat }),
];

if (logDirOk) {
  activeTransports.push(
    new transports.File({
      filename: path.join(LOG_PATH, 'combined.log'),
      format:   fileFormat,
      maxsize:  20 * 1024 * 1024, // rotate at 20 MB
      maxFiles: 7,
    }),
    new transports.File({
      filename: path.join(LOG_PATH, 'error.log'),
      level:    'error',
      format:   fileFormat,
      maxsize:  10 * 1024 * 1024,
      maxFiles: 7,
    })
  );
} else {
  // eslint-disable-next-line no-console
  console.warn('[logger] Could not create log directory — logging to console only.');
}

/**
 * Shared winston logger instance.
 * @type {import('winston').Logger}
 */
const logger = createLogger({
  level:       LOG_LEVEL,
  transports:  activeTransports,
  exitOnError: false,
});

module.exports = logger;
