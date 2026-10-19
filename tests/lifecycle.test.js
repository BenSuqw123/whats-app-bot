'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle, classifyDisconnect } = require('../src/utils/socketLifecycle');
const { Clock, flush, socket, config } = require('./helpers');
function setup(options = {}) {
  const clock = new Clock(), sockets = [], events = [], fatals = [];
  const lifecycle = createLifecycle({ config, timers: clock, now: clock.now,
    buildSocket: async () => { const s = socket(); sockets.push(s); return { socket: s, saveCreds: async () => {} }; },
    onMessage: async () => {}, onFatal: error => fatals.push(error), log: (level, event) => events.push(event), ...options });
  return { clock, sockets, events, fatals, lifecycle };
}
function close(s, status = 408, message = 'network unavailable') {
  s.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message, output: { statusCode: status } } } });
}
test('network outage retries beyond ten attempts and returns READY without fatal exit', async () => {
  const h = setup(); await h.lifecycle.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' }); await flush();
  for (let i = 0; i < 24; i++) {
    const s = h.sockets.at(-1); close(s); await flush();
    assert.equal(h.lifecycle.stats().reconnectPending, true);
    const delay = h.events.at(-1).reconnectDelay;
    assert.equal(delay, Math.min(5000 * 2 ** Math.min(i, 30), 120000));
    await h.clock.tick(delay);
    assert.equal(s.ended, 1);
  }
  h.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await flush();
  assert.equal(h.lifecycle.stats().connectionState, 'READY');
  assert.equal(h.fatals.length, 0); await h.lifecycle.stop();
});
test('duplicate close and stale open/close/messages cannot affect replacement socket', async () => {
  let received = 0;
  const h = setup({ onMessage: () => received++ }); await h.lifecycle.start();
  const a = h.sockets[0];
  const stale = a.ev.listeners('connection.update')[0];
  const staleMessage = a.ev.listeners('messages.upsert')[0];
  for (let i = 0; i < 30; i++) close(a);
  await flush(); assert.equal(h.lifecycle.stats().reconnectAttempt, 1);
  assert.equal(h.clock.tasks.size, 1);
  await h.clock.tick(5000);
  const b = h.sockets[1]; b.ev.emit('connection.update', { connection: 'open' }); await flush();
  stale({ connection: 'open' }); stale({ connection: 'close' });
  staleMessage({ type: 'notify', messages: [{}] }); await flush();
  assert.equal(h.lifecycle.stats().connectionState, 'READY'); assert.equal(received, 0);
  assert.equal(a.ev.listenerCount('connection.update'), 0); await h.lifecycle.stop();
});
test('failure budget resets only after stable threshold', async () => {
  const h = setup(); await h.lifecycle.start(); close(h.sockets[0]); await flush(); await h.clock.tick(5000);
  h.sockets[1].ev.emit('connection.update', { connection: 'open' }); await flush(); await h.clock.tick(10000);
  close(h.sockets[1]); await flush(); assert.equal(h.events.at(-1).reconnectDelay, 10000);
  await h.clock.tick(10000); h.sockets[2].ev.emit('connection.update', { connection: 'open' }); await flush();
  await h.clock.tick(60000); assert.equal(h.lifecycle.stats().reconnectAttempt, 0);
  close(h.sockets[2]); await flush(); assert.equal(h.events.at(-1).reconnectDelay, 5000); await h.lifecycle.stop();
});
test('startup factory failure retries', async () => {
  let builds = 0; const s = socket();
  const h = setup({ buildSocket: async () => { if (++builds < 3) throw new Error('ECONNRESET'); return { socket: s, saveCreds: async () => {} }; } });
  await h.lifecycle.start(); await h.clock.tick(5000); await h.clock.tick(10000);
  assert.equal(builds, 3); assert.equal(h.fatals.length, 0); await h.lifecycle.stop();
});
test('terminal auth reasons stop retries and remain AUTH_REQUIRED', async () => {
  for (const code of [401, 403, 411, 500]) {
    const h = setup(); await h.lifecycle.start(); close(h.sockets[0], code); await flush();
    assert.equal(h.lifecycle.stats().connectionState, 'AUTH_REQUIRED'); assert.equal(h.clock.tasks.size, 0);
    await h.clock.tick(3600000); assert.equal(h.sockets.length, 1); assert.equal(h.fatals.length, 0); await h.lifecycle.stop();
  }
});
test('conflict is explicit, closes local socket and does not compete through retries', async () => {
  assert.equal(classifyDisconnect({ message: 'Stream Errored (conflict)' }).kind, 'CONFLICT');
  const h = setup(); await h.lifecycle.start(); close(h.sockets[0], 440, 'conflict'); await flush();
  assert(h.events.some(e => e.operation === 'CONFLICT' && e.instruction.includes('possible duplicate')));
  assert.equal(h.sockets[0].ended, 1); assert.equal(h.lifecycle.stats().reconnectPending, false); await h.lifecycle.stop();
});
test('ready watchdog retires a socket before retry', async () => {
  const h = setup(); await h.lifecycle.start(); await h.clock.tick(60000);
  assert.equal(h.sockets[0].ended, 1); assert.equal(h.lifecycle.stats().connectionState, 'RECONNECTING');
  await h.clock.tick(5000); assert.equal(h.sockets.length, 2); await h.lifecycle.stop();
});
test('all async listeners catch rejection; message failure logs, auth failure requests fatal recovery', async () => {
  const s = socket();
  const h = setup({ buildSocket: async () => ({ socket: s, saveCreds: async () => { throw new Error('write failed'); } }),
    onMessage: async () => { throw new Error('bad message'); } });
  await h.lifecycle.start(); s.ev.emit('connection.update', { connection: 'open' }); await flush();
  s.ev.emit('messages.upsert', { type: 'notify', messages: [{}] }); await flush();
  assert(h.events.some(e => e.operation === 'messages.upsert' && e.stack && e.pid && e.eventGeneration));
  s.ev.emit('creds.update', {}); await flush(); assert.equal(h.fatals.length, 1);
  await assert.rejects(h.lifecycle.stop(), /write failed/);
});
test('shutdown during reconnect cancels timers and prevents any later build', async () => {
  const h = setup(); await h.lifecycle.start(); close(h.sockets[0]); await flush();
  h.lifecycle.beginStop(); await h.lifecycle.stop(); await h.clock.tick(86400000);
  assert.equal(h.sockets.length, 1); assert.equal(h.clock.tasks.size, 0);
});
test('socket end failure never permits replacement or successful session release', async () => {
  const s = socket(); s.end = async () => { throw new Error('teardown failed'); };
  const h = setup({ buildSocket: async () => ({ socket: s, saveCreds: async () => {} }) });
  await h.lifecycle.start(); close(s); await flush(); assert.equal(h.fatals.length, 1);
  await assert.rejects(h.lifecycle.stop(), /teardown failed/); assert.equal(h.clock.tasks.size, 0);
});
test('hung build requests fatal recovery; a late factory result is ended without becoming active', async () => {
  let resolve; const s = socket();
  const h = setup({ buildSocket: () => new Promise(r => { resolve = r; }) });
  const start = h.lifecycle.start(); await flush(); await h.clock.tick(60000);
  assert.equal(h.fatals.length, 1); assert.equal(h.lifecycle.stats().connectionState, 'STOPPING');
  const stop = h.lifecycle.stop(); resolve({ socket: s, saveCreds: async () => {} });
  await start; await stop; assert.equal(s.ended, 1); assert.equal(h.lifecycle.stats().activeSockets, 0);
});
test('auth writes are serialized and teardown waits for the outstanding write', async () => {
  const s = socket(); let release, writes = 0;
  const h = setup({ buildSocket: async () => ({ socket: s, saveCreds: () => {
    writes++; return writes === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  } }) });
  await h.lifecycle.start(); s.ev.emit('creds.update'); s.ev.emit('creds.update'); await flush();
  assert.equal(writes, 1); close(s); await flush(); assert.equal(h.lifecycle.stats().reconnectPending, false);
  release(); await flush(); assert.equal(writes, 2); assert.equal(h.lifecycle.stats().reconnectPending, true);
  await h.lifecycle.stop();
});
test('QR and connection callback failures do not leak unhandled rejections', async () => {
  const h = setup({ onAuth: () => { throw new Error('auth callback failure'); } });
  await h.lifecycle.start(); h.sockets[0].ev.emit('connection.update', { qr: 'private-qr' }); await flush();
  assert.equal(h.fatals.length, 1); assert(h.events.some(e => e.operation === 'connection.update' && e.stack));
  assert(!JSON.stringify(h.events).includes('private-qr')); await h.lifecycle.stop();
});
