'use strict';

const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const health = require('../utils/healthMonitor');
const { resolveChatArchivePath } = require('./storageService');

function todayString() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function save(metadata) {
  try {
    const chatDir  = resolveChatArchivePath(metadata);
    const msgDir   = path.join(chatDir, 'messages');
    const filePath = path.join(msgDir, `${todayString()}.ndjson`);

    fs.mkdirSync(path.resolve(msgDir), { recursive: true });

    const line = JSON.stringify(metadata) + '\n';
    fs.appendFileSync(path.resolve(filePath), line, 'utf-8');

    logger.debug(`[jsonStorage] → ${filePath}`);
    health.metrics.incJsonOk();
  } catch (err) {
    logger.error(`[jsonStorage] Failed to save record: ${err.message}`);
    health.metrics.incJsonFail();
  }
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); }
      catch (_) { return null; }
    })
    .filter(Boolean);
}

module.exports = { save, readNdjson };
