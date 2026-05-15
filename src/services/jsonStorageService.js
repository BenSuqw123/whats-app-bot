// src/services/jsonStorageService.js
'use strict';

/**
 * WHY NDJSON (Newline-Delimited JSON):
 *
 * The previous architecture read the entire JSON array → pushed → rewrote the
 * entire file on every single message. At 1000 messages/day with 500-byte
 * records, the daily file reaches 500 KB — meaning every save reads AND writes
 * 500 KB of data. At 10,000 messages/day: 5 MB read+write per save. At 100,000
 * messages/day: 50 MB per save. This is O(n²) I/O complexity and will
 * eventually block the event loop long enough to cause missed messages.
 *
 * NDJSON fixes this permanently:
 *  - Each record is ONE line: { ...metadata }\n
 *  - Appending is O(1) regardless of file size — fs.appendFileSync is atomic
 *    at the OS level for small writes (< pipe buffer size ~64 KB on Linux).
 *  - No read-parse-rewrite cycle. No temp file needed.
 *  - No concurrent-write queue needed — appendFile is safe for single-process use.
 *  - Files are streamable (grep, jq, etc.) without loading the whole thing.
 *
 * File naming: {chatType}_{sanitizedChatName}_{YYYY-MM-DD}.ndjson
 * Query tool:  jq -c 'select(.sender == "John")' data/messages/*.ndjson
 *
 * MIGRATION NOTE: Old .json files (from the previous format) are left untouched.
 * The bot will create new .ndjson files going forward. Old files can be read
 * with: jq -s '.' old_file.json
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const health = require('../utils/healthMonitor');

/** One-time flag: set to true after the data directory is confirmed to exist. */
let dataDirEnsured = false;

function ensureDataDir() {
  if (dataDirEnsured) return;
  fs.mkdirSync(path.resolve(config.dataPath), { recursive: true });
  dataDirEnsured = true;
}

/**
 * Sanitizes a string for safe inclusion in a filename.
 * Preserves only ASCII alphanumerics, hyphen, underscore, dot.
 * Unicode/emoji in chat names are replaced with underscores — they are
 * preserved INSIDE the NDJSON records themselves.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  const s = String(name || 'unknown').trim();
  return s
    .replace(/\s+/g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[^a-zA-Z0-9_\-.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\-]+|[_\-]+$/g, '')
    .slice(0, 80) || 'unknown';
}

/**
 * Returns today's date string as 'YYYY-MM-DD' in LOCAL time.
 *
 * @returns {string}
 */
function todayString() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Appends a single metadata record to the appropriate daily NDJSON file.
 * Each call is an O(1) append — no read, no parse, no full rewrite.
 *
 * File naming: {chatType}_{sanitizedChatName}_{YYYY-MM-DD}.ndjson
 *
 * @param {object} metadata
 * @returns {Promise<void>}
 */
async function save(metadata) {
  try {
    ensureDataDir();

    const chatType = String(metadata.chatType || 'unknown');
    const safeName = sanitizeName(metadata.chatName);
    const dateStr  = todayString();
    const filename = `${chatType}_${safeName}_${dateStr}.ndjson`;
    const filePath = path.resolve(config.dataPath, filename);

    // Serialize to a single JSON line — no pretty-printing (saves ~40% space)
    const line = JSON.stringify(metadata) + '\n';

    // fs.appendFileSync is safe for single-process append.
    // On Linux/macOS, writes < 4096 bytes to a regular file are atomic (POSIX).
    // On Windows, NTFS guarantees atomic append for single-process writes.
    fs.appendFileSync(filePath, line, 'utf-8');

    logger.debug(`[jsonStorage] → ${filename}`);
    health.metrics.incJsonOk();
  } catch (err) {
    logger.error(`[jsonStorage] Failed to save record: ${err.message}`);
    health.metrics.incJsonFail();
  }
}

/**
 * Reads all records from a specific NDJSON file.
 * Useful for ad-hoc queries; not called during normal bot operation.
 *
 * @param {string} filePath - Absolute path to a .ndjson file.
 * @returns {object[]}
 */
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
