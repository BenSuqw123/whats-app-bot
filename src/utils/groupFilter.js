// src/utils/groupFilter.js
'use strict';

/**
 * BUGS FIXED:
 *  1. chat.name can be undefined/null for archived or unnamed groups. Calling
 *     toLowerCase() on undefined throws "Cannot read properties of undefined".
 *     FIX: already guarded with `(groupName || '')`, which is retained.
 *
 *  2. Unicode / emoji group names: JavaScript's String.prototype.toLowerCase()
 *     handles Unicode correctly for BMP characters. Emoji are passed through
 *     unchanged, and the includes() check works correctly because config
 *     keywords are always ASCII lowercase. No fix needed — confirmed safe.
 *
 *  3. Keywords with leading/trailing spaces from env were already trimmed in
 *     config.js. Confirmed safe.
 *
 *  4. The function was logging at debug level for every single message in
 *     high-volume chats. Under 1000 msg/min this could flood the log file and
 *     cause synchronous I/O to block the event loop. FIX: Only log for BLOCKED
 *     groups (actionable), not for every ALLOWED pass-through.
 */

const config = require('../config');
const logger = require('./logger');

/**
 * Determines whether a group chat should be processed based on the configured
 * keyword whitelist. If no keywords are configured, ALL groups are allowed.
 *
 * Keywords in config are already lower-cased at load time.
 *
 * @param {string|undefined|null} groupName - The display name of the WhatsApp group.
 * @returns {boolean} `true` if the group should be collected; `false` to skip it.
 */
function isAllowed(groupName) {
  // Empty keyword list → accept everything
  if (!config.groupKeywords || config.groupKeywords.length === 0) {
    return true;
  }

  // Safely normalise — handles null/undefined/emoji/unicode
  const lowerName = (groupName || '').toLowerCase();

  for (const keyword of config.groupKeywords) {
    if (lowerName.includes(keyword)) {
      return true;
    }
  }

  logger.debug(
    `[groupFilter] BLOCKED: "${groupName}" — no match in [${config.groupKeywords.join(', ')}]`
  );
  return false;
}

module.exports = { isAllowed };
