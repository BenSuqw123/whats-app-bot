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

function formatTimeAEST(timestamp) {
  const date = new Date(timestamp * 1000);
  const options = {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  const formatter = new Intl.DateTimeFormat('en-CA', options);
  const parts = formatter.formatToParts(date);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  const second = parts.find(p => p.type === 'second').value;
  
  return `${year}-${month}-${day} ${hour}:${minute}:${second} AEST`;
}

function formatRecord(metadata) {
  const isDebug = process.env.DEBUG_EXPORT === 'true';

  const id = metadata.id || (metadata._meta && metadata._meta.id);
  const timestamp = metadata.timestamp || (metadata._meta && metadata._meta.timestamp);

  const time = timestamp ? formatTimeAEST(timestamp) : (metadata.time || undefined);
  const timezone = timestamp ? "Australia/Sydney" : (metadata.timezone || undefined);

  const isAbsolute = (p) => p && (p.includes('\\') || p.includes('/') || /^[a-zA-Z]:/.test(p));

  let mediaItems = undefined;
  if (metadata.mediaItems) {
    mediaItems = metadata.mediaItems.map(item => {
      const newItem = { ...item };
      const currentPath = newItem.path || newItem.filename;
      if (currentPath) {
        if (isDebug && isAbsolute(newItem.path)) {
          newItem.debugPath = newItem.path;
        }
        newItem.path = newItem.filename || path.basename(currentPath);
      }
      if (!isDebug) {
        delete newItem.messageId;
      }
      return newItem;
    });
  }

  let media = undefined;
  if (metadata.media) {
    media = { ...metadata.media };
    const currentPath = media.path || media.filename;
    if (currentPath) {
      if (isDebug && isAbsolute(media.path)) {
        media.debugPath = media.path;
      }
      media.path = media.filename || path.basename(currentPath);
    }
  }

  // Construct record in logical key order for human readability
  const exported = {};

  if (time !== undefined) exported.time = time;
  if (timezone !== undefined) exported.timezone = timezone;
  if (metadata.chatType !== undefined) exported.chatType = metadata.chatType;
  if (metadata.chatName !== undefined) exported.chatName = metadata.chatName;
  if (metadata.sender !== undefined) exported.sender = metadata.sender;
  if (metadata.type !== undefined) exported.type = metadata.type;
  exported.body = metadata.body || "";
  exported.mediaCount = mediaItems ? mediaItems.length : 0;
  if (mediaItems !== undefined) exported.mediaItems = mediaItems;

  // Backward compatibility fields
  if (media !== undefined) exported.media = media;
  if (metadata.chatId !== undefined) exported.chatId = metadata.chatId;

  if (isDebug) {
    exported._meta = {
      id: id || null,
      timestamp: timestamp || null
    };
  }

  return exported;
}

async function save(metadata) {
  try {
    const chatDir  = resolveChatArchivePath(metadata);
    const msgDir   = path.join(chatDir, 'messages');
    const filePath = path.join(msgDir, `${todayString()}.ndjson`);

    fs.mkdirSync(path.resolve(msgDir), { recursive: true });

    const formatted = formatRecord(metadata);
    const line = JSON.stringify(formatted) + '\n';
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

// ── Historical NDJSON Migration ──────────────────────────────────────────────

function migrateFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const newLines = [];
    let modified = false;

    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (_) {
        newLines.push(line);
        continue;
      }

      const formatted = formatRecord(record);
      // Determine if changes were made
      if (JSON.stringify(formatted) !== JSON.stringify(record)) {
        modified = true;
      }
      newLines.push(JSON.stringify(formatted));
    }

    if (modified) {
      fs.writeFileSync(filePath, newLines.join('\n') + '\n', 'utf-8');
      logger.info(`[jsonStorage] Migrated historical file: ${filePath}`);
    }
  } catch (err) {
    logger.error(`[jsonStorage] Migration failed for ${filePath}: ${err.message}`);
  }
}

function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      walkDir(fullPath);
    } else if (file.endsWith('.ndjson')) {
      migrateFile(fullPath);
    }
  }
}

function runMigration() {
  try {
    const archiveDir = path.resolve(config.archiveBase);
    logger.info(`[jsonStorage] Running historical NDJSON migration in "${archiveDir}"...`);
    walkDir(archiveDir);
    logger.info('[jsonStorage] Historical NDJSON migration completed.');
  } catch (err) {
    logger.error(`[jsonStorage] Historical migration failed: ${err.message}`);
  }
}

// Automatically trigger migration on startup
runMigration();

module.exports = { save, readNdjson, runMigration };
