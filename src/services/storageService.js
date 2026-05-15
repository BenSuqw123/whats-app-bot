// src/services/storageService.js
'use strict';

/**
 * BUGS FIXED:
 *  1. PATH TRAVERSAL: The `filename` argument was never validated. A malicious
 *     or malformed WhatsApp filename like "../../etc/passwd" would write outside
 *     the intended directory. FIX: Strip any path separators and directory
 *     components from the filename before joining with the target directory.
 *
 *  2. DOUBLE BUFFER ALLOCATION: mediaHandler.js was calling
 *     `Buffer.from(media.data, 'base64')` a second time just to measure size
 *     after saveMedia() already decoded it. FIX: Return the byte count from
 *     saveMedia() so the caller never decodes twice.
 *
 *  3. MISSING AUDIO DOWNLOAD DIR: config.downloadPaths includes 'audio' but
 *     there was no `downloads/audio/` mkdir call in the original — only the
 *     dirs in the config object are iterated, so this was actually fine. But
 *     the log dir was NOT ensured here; that's done in logger.js. Confirmed no
 *     gap.
 *
 *  4. NO OVERWRITE GUARD: Two messages arriving at the same millisecond with
 *     the same chat name would produce identical filenames → file overwrite.
 *     The filename already contains a timestamp_chatName_baseName pattern, but
 *     the timestamp resolution is seconds, not ms. FIX: Append the first 8
 *     chars of the message id (passed as optional param) or a random hex
 *     suffix to guarantee uniqueness. The caller passes msgId.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Strips any directory-traversal components from a raw filename string so that
 * the final path always stays inside the intended target directory.
 *
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
  // path.basename removes all directory components on both POSIX and Windows.
  // Additional pass removes characters that are illegal on Windows NTFS.
  return path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

/**
 * Creates all download directories defined in config.downloadPaths plus the
 * JSON data directory. Safe to call multiple times.
 */
function ensureDirectories() {
  for (const dir of Object.values(config.downloadPaths)) {
    try {
      fs.mkdirSync(path.resolve(dir), { recursive: true });
    } catch (err) {
      logger.error(`[storageService] Cannot create directory "${dir}": ${err.message}`);
    }
  }
  try {
    fs.mkdirSync(path.resolve(config.dataPath), { recursive: true });
  } catch (err) {
    logger.error(`[storageService] Cannot create dataPath "${config.dataPath}": ${err.message}`);
  }
  logger.debug('[storageService] All directories verified/created.');
}

/**
 * Writes a base64-encoded media payload to disk.
 *
 * @param {string} base64Data   - Raw base64 string from whatsapp-web.js.
 * @param {string} directory    - Target folder (absolute or relative).
 * @param {string} filename     - Desired filename including extension.
 * @param {string} [uniqueSuffix] - Optional unique suffix to prevent collisions.
 * @returns {{ filePath: string, fileSize: number }}
 * @throws {Error} If the buffer cannot be written.
 */
function saveMedia(base64Data, directory, filename, uniqueSuffix) {
  // Harden directory and filename
  const resolvedDir  = path.resolve(directory);
  const safeFilename = sanitizeFilename(filename);

  // Insert uniqueSuffix before extension to avoid collisions
  const suffix = uniqueSuffix || crypto.randomBytes(4).toString('hex');
  const ext    = path.extname(safeFilename);
  const base   = path.basename(safeFilename, ext);
  const finalName = `${base}_${suffix}${ext}`;

  fs.mkdirSync(resolvedDir, { recursive: true });

  const buffer   = Buffer.from(base64Data, 'base64');
  const fullPath = path.join(resolvedDir, finalName);

  fs.writeFileSync(fullPath, buffer);
  logger.info(`[storageService] Saved → ${fullPath} (${buffer.length} bytes)`);

  return { filePath: fullPath, fileSize: buffer.length };
}

module.exports = { ensureDirectories, saveMedia, sanitizeFilename };
