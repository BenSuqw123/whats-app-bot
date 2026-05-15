'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_PATH  = process.env.LOG_PATH  || './logs';

let logDirOk = false;
try {
  fs.mkdirSync(LOG_PATH, { recursive: true });
  logDirOk = true;
} catch (e) {}

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
      maxsize:  20 * 1024 * 1024,
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
  console.warn('[logger] Could not create log directory — logging to console only.');
}

const logger = createLogger({
  level:       LOG_LEVEL,
  transports:  activeTransports,
  exitOnError: false,
});

module.exports = logger;
