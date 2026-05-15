'use strict';

const JID_SUFFIX = Object.freeze({
  GROUP:     '@g.us',
  STATUS:    'status@broadcast',
  BROADCAST: '@broadcast',
  LID:       '@lid',
  LEGACY:    '@c.us',
  NEWSID:    '@newsletter',
});

function stripJidSuffix(jid) {
  return String(jid || '').replace(/@[^@]+$/, '');
}

function normalizeJid(jid) {
  const str   = String(jid || '').trim();
  const atIdx = str.lastIndexOf('@');
  if (atIdx === -1) return str;
  return str.slice(0, atIdx) + '@' + str.slice(atIdx + 1).toLowerCase();
}

function jidTypeHint(jid) {
  const norm = normalizeJid(jid);
  if (norm === JID_SUFFIX.STATUS)           return 'broadcast';
  if (norm.endsWith(JID_SUFFIX.BROADCAST))  return 'broadcast';
  if (norm.endsWith(JID_SUFFIX.GROUP))      return 'group';
  if (norm.endsWith(JID_SUFFIX.NEWSID))     return 'broadcast';
  if (norm.endsWith(JID_SUFFIX.LID))        return 'unknown';
  if (norm.endsWith(JID_SUFFIX.LEGACY))     return 'dm';
  return 'unknown';
}

function detectChatType(fromJid, chat) {
  const hint = jidTypeHint(fromJid);

  if (hint === 'broadcast') {
    return { chatType: 'broadcast', isGroup: false, isBroadcast: true, isDM: false };
  }

  if (chat) {
    if (chat.isGroup     === true) return { chatType: 'group',     isGroup: true,  isBroadcast: false, isDM: false };
    if (chat.isBroadcast === true) return { chatType: 'broadcast', isGroup: false, isBroadcast: true,  isDM: false };
    return { chatType: 'dm', isGroup: false, isBroadcast: false, isDM: true };
  }

  if (hint === 'group') return { chatType: 'group', isGroup: true,  isBroadcast: false, isDM: false };
  if (hint === 'dm')    return { chatType: 'dm',    isGroup: false, isBroadcast: false, isDM: true  };

  return { chatType: 'dm', isGroup: false, isBroadcast: false, isDM: true };
}

function isStatusJid(jid) {
  const norm = normalizeJid(jid);
  return norm === JID_SUFFIX.STATUS || norm.startsWith('status@');
}

module.exports = { stripJidSuffix, normalizeJid, jidTypeHint, detectChatType, isStatusJid, JID_SUFFIX };
