'use strict';

function classifyDisconnect(error) {
  const status = error?.output?.statusCode ?? error?.statusCode;
  if (status === 440 || /conflict|replaced/i.test(error?.message || '')) return { kind: 'CONFLICT', status };
  if ([401, 403, 411, 500].includes(status)) return { kind: 'AUTH_REQUIRES_ACTION', status };
  return { kind: 'TRANSIENT', status };
}

// Pure controller: tests supply fake sockets and a clock, without touching WhatsApp or sessions.
function createLifecycle({ config, buildSocket, onMessage, onFatal, log, now = Date.now,
  timers = { setTimeout, clearTimeout }, pid = process.pid, onReconnect = () => {}, onAuth = () => {} }) {
  let generation = 0, record = null, buildPromise = null, stopPromise = null;
  let reconnectTimer = null, stableTimer = null, readyTimer = null;
  let stopping = false, started = false, fatal = false;
  let state = 'STARTING', attempt = 0, lastOpen = null, lastReceived = null;
  let teardownError = null;
  const retiring = new Set();

  function info(level, operation, detail = {}) {
    log(level, { operation, pid, generation, connectionState: state, ...detail });
  }
  function clear(name) {
    if (name === 'ready') { timers.clearTimeout(readyTimer); readyTimer = null; }
    if (name === 'stable') { timers.clearTimeout(stableTimer); stableTimer = null; }
    if (name === 'retry') { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
  }
  function beginStop() {
    if (stopping) return;
    stopping = true; state = 'STOPPING'; generation++;
    clear('retry'); clear('stable'); clear('ready');
  }
  function fatalError(operation, error) {
    if (fatal || stopping) return;
    fatal = true; beginStop();
    info('error', operation, { error: error.message, stack: error.stack });
    Promise.resolve().then(() => onFatal(error)).catch(err => info('error', 'fatal-handler', { error: err.message, stack: err.stack }));
  }
  function endRecord(old) {
    if (!old) return Promise.resolve();
    if (old.ending) return old.ending;
    for (const [event, fn] of old.listeners) old.socket.ev.off(event, fn);
    old.ending = (async () => {
      let deadline;
      try {
        await Promise.race([
          (async () => {
            await old.socket.end(new Error('Local socket retirement'));
            await old.credsPromise;
          })(),
          new Promise((_, reject) => { deadline = timers.setTimeout(() => reject(new Error('Socket teardown/auth flush deadline exceeded')), config.socketEndTimeoutMs); }),
        ]);
      } catch (error) { teardownError = error; throw error; }
      finally { timers.clearTimeout(deadline); }
    })();
    retiring.add(old.ending);
    old.ending.then(() => retiring.delete(old.ending), () => retiring.delete(old.ending));
    return old.ending;
  }
  function bind(old, event, fn, failurePolicy) {
    const listener = (...args) => {
      if (stopping || record !== old || old.generation !== generation) return;
      Promise.resolve().then(() => {
        if (stopping || record !== old || old.generation !== generation) return;
        return fn(...args);
      }).catch(error => {
        info('error', event, { eventGeneration: old.generation, error: error.message, stack: error.stack });
        if (failurePolicy === 'fatal') fatalError(event, error);
      });
    };
    old.listeners.push([event, listener]); old.socket.ev.on(event, listener);
  }
  function schedule(reason) {
    if (stopping || fatal || state === 'AUTH_REQUIRED' || reconnectTimer !== null) return;
    state = 'RECONNECTING';
    const delay = Math.min(config.reconnectMaxDelayMs, config.reconnectInitialDelayMs * (2 ** Math.min(attempt, 30)));
    attempt = Math.min(attempt + 1, Number.MAX_SAFE_INTEGER);
    onReconnect();
    info('warn', 'reconnect-scheduled', { reason, reconnectAttempt: attempt, reconnectDelay: delay });
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect().catch(error => fatalError('reconnect', error));
    }, delay); // Referenced: prolonged network outages keep Node alive.
  }
  async function retireAndRecover(old, reason) {
    if (record !== old || stopping) return;
    clear('ready'); clear('stable');
    generation++; record = null; state = 'RECONNECTING';
    try { await endRecord(old); } catch (error) { fatalError('socket-end', error); return; }
    schedule(reason);
  }
  async function connection(old, update) {
    if (update.qr) {
      info('warn', 'QR_REQUIRED', { instruction: 'Use a controlled manual pairing workflow; QR content is not logged.' });
      clear('ready'); clear('stable'); clear('retry'); state = 'AUTH_REQUIRED'; onAuth('QR_REQUIRED');
      generation++; record = null;
      try { await endRecord(old); } catch (error) { fatalError('socket-end', error); }
      return;
    }
    if (update.connection === 'open') {
      clear('ready'); clear('retry'); clear('stable'); state = 'READY'; lastOpen = now();
      info('info', 'connection-open', { lastConnectionOpenAt: lastOpen });
      stableTimer = timers.setTimeout(() => {
        stableTimer = null;
        if (!stopping && record === old && generation === old.generation && state === 'READY') {
          attempt = 0; info('info', 'connection-stable', { reconnectAttempt: attempt });
        }
      }, config.stableConnectionMs);
    } else if (update.connection === 'close') {
      const error = update.lastDisconnect?.error;
      const classification = classifyDisconnect(error);
      info('warn', 'connection-close', { disconnectStatus: classification.status ?? null,
        disconnectKind: classification.kind, reason: error?.message || 'connection closed' });
      if (classification.kind !== 'TRANSIENT') {
        clear('ready'); clear('stable'); clear('retry'); state = 'AUTH_REQUIRED'; onAuth(classification.kind);
        info('error', classification.kind, { instruction: classification.kind === 'CONFLICT'
          ? 'possible duplicate WhatsApp session/socket; check every owner before restarting'
          : 'Check linked devices/session permissions; re-pair manually if necessary. Session was not deleted.' });
        generation++; record = null;
        try { await endRecord(old); } catch (err) { fatalError('socket-end', err); }
      } else await retireAndRecover(old, error?.message || 'connection closed');
    }
  }
  function connect() {
    if (stopping || fatal || state === 'AUTH_REQUIRED') return Promise.resolve();
    if (buildPromise) return buildPromise;
    buildPromise = (async () => {
      const old = record; record = null;
      const current = ++generation;
      clear('ready'); clear('stable');
      try { await endRecord(old); } catch (error) { fatalError('socket-end', error); return; }
      if (stopping) return;
      state = 'CONNECTING'; info('info', 'socket-build');
      readyTimer = timers.setTimeout(() => {
        readyTimer = null;
        if (stopping || generation !== current) return;
        // A hung build cannot safely be overlapped with another factory invocation.
        if (!record) fatalError('socket-build-timeout', new Error('Socket build deadline exceeded'));
        else retireAndRecover(record, 'ready watchdog timeout').catch(error => fatalError('ready-watchdog', error));
      }, config.connectionReadyTimeoutMs);
      let built;
      try { built = await buildSocket(current); }
      catch (error) {
        clear('ready');
        if (!stopping) {
          info('error', 'socket-build', { error: error.message, stack: error.stack });
          if (['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM'].includes(error.code)
              || error instanceof TypeError || error instanceof SyntaxError) fatalError('socket-build-fatal', error);
          else schedule('startup/build failure');
        }
        return;
      }
      const next = { socket: built.socket, generation: current, listeners: [], credsPromise: Promise.resolve() };
      if (stopping || generation !== current) { await endRecord(next); return; }
      record = next;
      bind(next, 'connection.update', update => connection(next, update), 'fatal');
      bind(next, 'creds.update', () => {
        next.credsPromise = next.credsPromise.then(() => built.saveCreds());
        return next.credsPromise;
      }, 'fatal');
      bind(next, 'messages.upsert', async m => {
        if (m.type !== 'notify' || state !== 'READY') return;
        lastReceived = now();
        for (const msg of m.messages) {
          if (stopping || record !== next || generation !== current) break;
          await onMessage(msg, next.socket, current);
        }
      }, 'log');
    })().finally(() => { buildPromise = null; });
    return buildPromise;
  }
  function stop() {
    beginStop();
    if (!stopPromise) stopPromise = (async () => {
      if (buildPromise) await buildPromise;
      const old = record; record = null;
      await endRecord(old);
      await Promise.all([...retiring]);
      if (teardownError) throw teardownError;
    })();
    return stopPromise;
  }
  return {
    start() { if (started) return buildPromise || Promise.resolve(); started = true; return connect(); },
    beginStop, stop,
    stats: () => ({ socketGeneration: generation, connectionState: state, reconnectAttempt: attempt,
      lastConnectionOpenAt: lastOpen, lastMessageReceivedAt: lastReceived,
      reconnectPending: reconnectTimer !== null, activeSockets: record ? 1 : 0,
      lifecycleTimers: [readyTimer, stableTimer, reconnectTimer].filter(t => t !== null).length }),
  };
}
module.exports = { createLifecycle, classifyDisconnect };
