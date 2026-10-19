'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BoundedCache } = require('../src/utils/boundedCache');
const { createMediaQueue } = require('../src/utils/mediaQueue');
const { acquireSessionLock } = require('../src/utils/sessionLock');
const { integer } = require('../src/utils/configValues');
const { flush, removeTemp } = require('./helpers');
test('album IDs expire and evict oldest entries at hard cap', () => {
  let now = 0; const cache = new BoundedCache(3, 100, () => now);
  for (let i = 0; i < 100000; i++) cache.add('single-media-' + i);
  assert.equal(cache.size, 3); assert(!cache.has('single-media-0')); assert(cache.has('single-media-99999'));
  now = 101; assert.equal(cache.size, 0);
});
test('queue full rejects immediately, queue remains bounded and FIFO', async () => {
  const q = createMediaQueue({ concurrency: 1, maxQueued: 2, timeoutMs: 1000 });
  let resolve, order = [];
  const a = q.run(() => new Promise(r => { resolve = r; })); await flush();
  const b = q.run(async () => order.push(1)), c = q.run(async () => order.push(2));
  await assert.rejects(q.run(async () => {}), { code: 'MEDIA_QUEUE_FULL' });
  assert.equal(q.stats().mediaQueued, 2); resolve(); await Promise.all([a, b, c]); await flush();
  assert.deepEqual(order, [1, 2]); assert.equal(q.stats().mediaActive, 0); await q.stop();
});
test('stalled download times out, aborts and releases slot for next job', async () => {
  const q = createMediaQueue({ concurrency: 1, maxQueued: 2, timeoutMs: 20 });
  let signal;
  const a = q.run(s => { signal = s; return new Promise(() => {}); });
  const b = q.run(async () => 'next');
  await assert.rejects(a, { code: 'MEDIA_TIMEOUT' }); assert(signal.aborted);
  assert.equal(await b, 'next'); await flush(); assert.equal(q.stats().mediaActive, 0); await q.stop();
});
test('shutdown cancels queued and active media and refuses new work', async () => {
  const q = createMediaQueue({ concurrency: 1, maxQueued: 2, timeoutMs: 1000 });
  const a = q.run(() => new Promise(() => {})), b = q.run(async () => 'queued');
  const settled = Promise.allSettled([a, b]); await q.stop();
  assert((await settled).every(r => r.status === 'rejected'));
  await assert.rejects(q.run(async () => {}), { code: 'STOPPING' }); await flush();
  assert.equal(q.stats().mediaActive, 0); assert.equal(q.stats().mediaQueued, 0);
});
test('session lock refuses live owner, reclaims dead PID and never removes another owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lock-test-'));
  try {
    const first = acquireSessionLock(dir);
    assert.throws(() => acquireSessionLock(dir), /live PID/);
    first.release();
    fs.writeFileSync(path.join(dir, 'bot.lock'), JSON.stringify({ pid: 123456789, hostname: os.hostname() }));
    const second = acquireSessionLock(dir, { isAlive: () => false });
    fs.writeFileSync(path.join(dir, 'bot.lock'), JSON.stringify({ ...second.owner, token: 'other-owner' }));
    second.release(); assert(fs.existsSync(path.join(dir, 'bot.lock')));
  } finally { removeTemp(dir); }
});
test('malformed lock/guard fail closed without deleting foreign ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lock-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'bot.lock'), 'partial');
    assert.throws(() => acquireSessionLock(dir), /Unreadable/);
    assert.equal(fs.readFileSync(path.join(dir, 'bot.lock'), 'utf8'), 'partial');
    fs.writeFileSync(path.join(dir, 'bot.lock.guard'), 'other');
    assert.throws(() => acquireSessionLock(dir), /guard unavailable/);
  } finally { removeTemp(dir); }
});
test('numeric config rejects partial, NaN, zero, negative and unsafe values', () => {
  for (const raw of ['10abc', 'NaN', '0', '-1', '1.5', '', '999999999999999999']) {
    assert.throws(() => integer({ VALUE: raw }, 'VALUE', 10));
  }
  assert.equal(integer({}, 'VALUE', 10), 10); assert.equal(integer({ VALUE: '42' }, 'VALUE', 10), 42);
});
