'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle } = require('../src/utils/socketLifecycle');
const { createMediaQueue } = require('../src/utils/mediaQueue');
const { BoundedCache } = require('../src/utils/boundedCache');
const { Clock, socket, config, flush } = require('./helpers');
test('offline soak: 16000+ lifecycle events, 100000 album IDs and 10000 media jobs stay bounded', async () => {
  const clock = new Clock(); let active, maxLive = 0, live = 0, eventCount = 0, builds = 0;
  const lifecycle = createLifecycle({ config, timers: clock, now: clock.now, onMessage: async () => {}, log: () => {},
    onFatal: error => { throw error; }, buildSocket: async () => {
      active = socket(); const current = active; builds++; live++; maxLive = Math.max(maxLive, live);
      current.end = async () => { current.ended++; live--; };
      return { socket: current, saveCreds: async () => {} };
    } });
  await lifecycle.start();
  for (let i = 0; i < 4000; i++) {
    const current = active, stale = current.ev.listeners('connection.update')[0];
    current.ev.emit('connection.update', { connection: 'open' }); eventCount++; await flush();
    current.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 'network outage', output: { statusCode: 408 } } } }); eventCount++;
    await flush(); stale({ connection: 'open' }); stale({ connection: 'close' }); eventCount += 2; await flush();
    assert.equal(current.ev.eventNames().length, 0); assert(clock.tasks.size <= 1);
    await clock.tick(Math.min(5000 * 2 ** Math.min(i, 30), 120000));
    assert(lifecycle.stats().activeSockets <= 1); assert(lifecycle.stats().lifecycleTimers <= 1);
  }
  assert.equal(maxLive, 1); assert.equal(builds, 4001); assert(eventCount >= 10000);
  await lifecycle.stop(); assert.equal(clock.tasks.size, 0); assert.equal(live, 0); assert(clock.peak <= 2);
  const cache = new BoundedCache(5000, 1200000, clock.now);
  for (let i = 0; i < 100000; i++) { cache.add('album-' + i); assert(cache.size <= 5000); }
  await clock.tick(1200001); assert.equal(cache.size, 0);
  const q = createMediaQueue({ concurrency: 2, maxQueued: 100, timeoutMs: 10000 });
  const outcomes = []; let peakQueue = 0;
  for (let i = 0; i < 10000; i++) {
    outcomes.push(q.run(async () => i).then(() => 'ok', error => error.code));
    peakQueue = Math.max(peakQueue, q.stats().mediaQueued);
  }
  const results = await Promise.all(outcomes); await flush();
  assert.equal(peakQueue, 100); assert.equal(results.filter(x => x === 'ok').length, 102);
  assert.equal(results.filter(x => x === 'MEDIA_QUEUE_FULL').length, 9898);
  await q.stop(); assert.equal(q.stats().mediaActive, 0); assert.equal(q.stats().mediaQueued, 0);
});
