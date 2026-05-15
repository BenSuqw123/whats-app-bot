'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

function sanitizeForFolder(str) {
  return String(str || 'unknown')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[^a-zA-Z0-9_\-.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\-]+|[_\-]+$/g, '')
    .slice(0, 60) || 'unknown';
}

function resolveChatArchivePath(metadata) {
  const chatTypeFolder =
    metadata.chatType === 'group' ? 'groups' :
    metadata.chatType === 'dm'    ? 'dms'    :
    'other';

  const rawName = (metadata.chatName && metadata.chatName !== 'Unknown')
    ? metadata.chatName
    : (metadata.chatId || 'unknown');

  return path.join(config.archiveBase, chatTypeFolder, sanitizeForFolder(rawName));
}

function sanitizeFilename(filename) {
  return path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function ensureDirectories() {
  try {
    fs.mkdirSync(path.resolve(config.archiveBase), { recursive: true });
  } catch (err) {
    logger.error(`[storageService] Cannot create archiveBase "${config.archiveBase}": ${err.message}`);
  }
  logger.debug('[storageService] Archive root verified/created.');
}

function saveMedia(base64Data, directory, filename, uniqueSuffix) {
  const resolvedDir  = path.resolve(directory);
  const safeFilename = sanitizeFilename(filename);

  const suffix    = uniqueSuffix || crypto.randomBytes(4).toString('hex');
  const ext       = path.extname(safeFilename);
  const base      = path.basename(safeFilename, ext);
  const finalName = `${base}_${suffix}${ext}`;

  fs.mkdirSync(resolvedDir, { recursive: true });

  const buffer   = Buffer.from(base64Data, 'base64');
  const fullPath = path.join(resolvedDir, finalName);

  fs.writeFileSync(fullPath, buffer);
  logger.info(`[storageService] Saved → ${fullPath} (${buffer.length} bytes)`);

  return { filePath: fullPath, fileSize: buffer.length };
}

module.exports = { ensureDirectories, saveMedia, sanitizeFilename, sanitizeForFolder, resolveChatArchivePath };
