'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
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

  fs.mkdirSync(resolvedDir, { recursive: true });

  const ext       = path.extname(safeFilename);
  const base      = path.basename(safeFilename, ext);
  
  let finalName = safeFilename;
  let counter = 1;
  while (fs.existsSync(path.join(resolvedDir, finalName))) {
    finalName = `${base}_${counter}${ext}`;
    counter++;
  }

  const buffer   = Buffer.from(base64Data, 'base64');
  const fullPath = path.join(resolvedDir, finalName);

  fs.writeFileSync(fullPath, buffer);
  logger.info(`[storageService] Saved → ${fullPath} (${buffer.length} bytes)`);

  return { filePath: fullPath, fileSize: buffer.length };
}

async function saveMediaStream(stream, directory, filename, { signal, maxBytes }) {
  const resolvedDir = path.resolve(directory);
  await fs.promises.mkdir(resolvedDir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const temporary = path.join(resolvedDir, `.${crypto.randomUUID()}.part`);
  let size = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) callback(Object.assign(new Error('Media stream exceeds size limit'), { code: 'MEDIA_OVERSIZED' }));
    else callback(null, chunk);
  } });
  try {
    await pipeline(stream, limit, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
    signal.throwIfAborted();
    let filePath, counter = 0;
    while (true) {
      signal.throwIfAborted();
      const ext = path.extname(safe), base = path.basename(safe, ext);
      filePath = path.join(resolvedDir, counter ? `${base}_${counter}${ext}` : safe);
      try {
        // Atomic no-overwrite publication on NTFS; partial files are never archived as successes.
        await fs.promises.link(temporary, filePath);
        break;
      } catch (error) { if (error.code !== 'EEXIST') throw error; counter++; }
    }
    if (signal.aborted) { await fs.promises.unlink(filePath); signal.throwIfAborted(); }
    return { filePath, fileSize: size };
  } finally {
    stream.destroy();
    await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

module.exports = { ensureDirectories, saveMedia, saveMediaStream, sanitizeFilename, sanitizeForFolder, resolveChatArchivePath };
