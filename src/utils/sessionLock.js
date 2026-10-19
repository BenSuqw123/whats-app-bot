'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
function lockError(message) { return Object.assign(new Error(message), { code: 'SESSION_LOCKED' }); }
function acquireSessionLock(sessionPath, { pid = process.pid, isAlive = pidExists } = {}) {
  fs.mkdirSync(sessionPath, { recursive: true });
  sessionPath = fs.realpathSync(sessionPath);
  const lockPath = path.join(sessionPath, 'bot.lock');
  const guardPath = path.join(sessionPath, 'bot.lock.guard');
  const owner = { pid, token: randomUUID(), startedAt: new Date().toISOString(),
    cwd: process.cwd(), sessionPath, hostname: os.hostname() };
  // Serialize acquire/stale removal/release. Never reclaim a guard while another
  // contender might be between verifying and unlinking a lock (Windows included).
  function guarded(fn) {
    let fd;
    try { fd = fs.openSync(guardPath, 'wx'); }
    catch (error) { throw lockError(`Session ownership guard unavailable (${error.code}); retry later or inspect bot.lock.guard manually.`); }
    try { fs.writeFileSync(fd, JSON.stringify(owner)); return fn(); }
    finally { fs.closeSync(fd); fs.unlinkSync(guardPath); }
  }
  guarded(() => {
    if (fs.existsSync(lockPath)) {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
      catch { throw lockError('Unreadable bot.lock; refusing unsafe session takeover. Inspect it manually.'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || previous.hostname !== owner.hostname) {
        throw lockError('Unverifiable session owner; refusing session takeover.');
      }
      // A recycled/live PID also blocks takeover: false positives are safer than duplicate sockets.
      if (isAlive(previous.pid)) throw lockError(`Session already owned by live PID ${previous.pid}; refusing second bot start.`);
      fs.unlinkSync(lockPath);
    }
    const fd = fs.openSync(lockPath, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(owner)); } finally { fs.closeSync(fd); }
  });
  let released = false;
  return { owner, release() {
    if (released) return;
    guarded(() => {
      if (!fs.existsSync(lockPath)) return;
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (current.token === owner.token && current.pid === pid) fs.unlinkSync(lockPath);
    });
    released = true;
  } };
}
module.exports = { acquireSessionLock };
