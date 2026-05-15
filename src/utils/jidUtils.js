// src/utils/jidUtils.js
'use strict';

/**
 * WHY THIS MODULE EXISTS:
 *
 * Runtime testing revealed that modern WhatsApp uses @lid (Linked ID) JIDs
 * for all chats — indistinguishable from DM JIDs by suffix alone. Any code
 * that uses `jid.endsWith('@g.us')` as the sole group-detection mechanism
 * will silently misclassify groups as DMs for the majority of users on
 * current WhatsApp versions.
 *
 * This module centralises ALL JID reasoning so that:
 *  - Suffix-based heuristics are clearly marked as hints, not facts.
 *  - The authoritative source (chat.isGroup / chat.isBroadcast) is always
 *    preferred when a chat object is available.
 *  - Callers never do raw string operations on JIDs.
 */

/**
 * Known JID suffixes and their meanings.
 * @readonly
 */
const JID_SUFFIX = Object.freeze({
  GROUP:     '@g.us',
  STATUS:    'status@broadcast',
  BROADCAST: '@broadcast',
  LID:       '@lid',       // Linked ID — modern WhatsApp, ambiguous type
  LEGACY:    '@c.us',      // Legacy phone-number JIDs
  NEWSID:    '@newsletter',// WhatsApp Channels / newsletters
});

/**
 * Strips the domain suffix from a JID string, leaving only the local part.
 * Examples:
 *   "1234567890@c.us"           → "1234567890"
 *   "265652485013639@lid"       → "265652485013639"
 *   "120363000000000@g.us"      → "120363000000000"
 *
 * @param {string|null|undefined} jid
 * @returns {string}
 */
function stripJidSuffix(jid) {
  return String(jid || '').replace(/@[^@]+$/, '');
}

/**
 * Normalises a JID to a consistent string, trimming whitespace and lower-casing
 * the domain portion (local part is left as-is — numeric IDs are case-neutral).
 *
 * @param {string|null|undefined} jid
 * @returns {string}
 */
function normalizeJid(jid) {
  const str = String(jid || '').trim();
  const atIdx = str.lastIndexOf('@');
  if (atIdx === -1) return str;
  return str.slice(0, atIdx) + '@' + str.slice(atIdx + 1).toLowerCase();
}

/**
 * Derives the PRELIMINARY chat type from a JID string alone.
 * This is a HINT only — should always be confirmed with detectChatType()
 * once a chat object is available.
 *
 * @param {string|null|undefined} jid
 * @returns {'group'|'broadcast'|'dm'|'unknown'}
 */
function jidTypeHint(jid) {
  const norm = normalizeJid(jid);
  if (norm === JID_SUFFIX.STATUS)            return 'broadcast';
  if (norm.endsWith(JID_SUFFIX.BROADCAST))   return 'broadcast';
  if (norm.endsWith(JID_SUFFIX.GROUP))       return 'group';
  if (norm.endsWith(JID_SUFFIX.NEWSID))      return 'broadcast';
  if (norm.endsWith(JID_SUFFIX.LID))         return 'unknown'; // ambiguous
  if (norm.endsWith(JID_SUFFIX.LEGACY))      return 'dm';
  return 'unknown';
}

/**
 * Returns the AUTHORITATIVE chat type by combining the JID hint with the
 * chat object's properties. The chat object (when available) always wins.
 *
 * Use this function wherever a chat object has been retrieved via getChat().
 *
 * @param {string|null|undefined} fromJid   - message.from
 * @param {object|null}           chat      - result of message.getChat(), or null
 * @returns {{ chatType: 'group'|'broadcast'|'dm', isGroup: boolean, isBroadcast: boolean, isDM: boolean }}
 */
function detectChatType(fromJid, chat) {
  const hint = jidTypeHint(fromJid);

  // Status broadcasts never have a valid chat object — trust the JID
  if (hint === 'broadcast') {
    return { chatType: 'broadcast', isGroup: false, isBroadcast: true, isDM: false };
  }

  // If we have a chat object, use it as the authoritative source
  if (chat) {
    if (chat.isGroup     === true) return { chatType: 'group',     isGroup: true,  isBroadcast: false, isDM: false };
    if (chat.isBroadcast === true) return { chatType: 'broadcast', isGroup: false, isBroadcast: true,  isDM: false };
    // Explicit false or undefined → DM
    return { chatType: 'dm', isGroup: false, isBroadcast: false, isDM: true };
  }

  // No chat object — fall back to JID hint
  if (hint === 'group') return { chatType: 'group',     isGroup: true,  isBroadcast: false, isDM: false };
  if (hint === 'dm')    return { chatType: 'dm',        isGroup: false, isBroadcast: false, isDM: true  };

  // Truly unknown (e.g. @lid with no chat object) — treat as DM conservatively
  return { chatType: 'dm', isGroup: false, isBroadcast: false, isDM: true };
}

/**
 * Returns true if the JID is a WhatsApp Status / broadcast and should be
 * handled before attempting getChat() (which may throw for these JIDs).
 *
 * @param {string|null|undefined} jid
 * @returns {boolean}
 */
function isStatusJid(jid) {
  const norm = normalizeJid(jid);
  return norm === JID_SUFFIX.STATUS || norm.startsWith('status@');
}

module.exports = { stripJidSuffix, normalizeJid, jidTypeHint, detectChatType, isStatusJid, JID_SUFFIX };
