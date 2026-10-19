'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const { openMediaStream } = require('../src/utils/mediaStream');
const { createMediaQueue } = require('../src/utils/mediaQueue');
const { load, logger, metrics, flush, removeTemp } = require('./helpers');

function storage() {
  return load('src/services/storageService.js', { '../config': {}, '../utils/logger': logger });
}
function wrapper(baileys) {
  return load('src/utils/baileysWrapper.js', { '../config': { maxGroupCache: 10, groupCacheTtlMs: 1000 },
    './logger': logger, '@whiskeysockets/baileys': baileys });
}
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('storage streams byte limits, cleans partial files, preserves names and never overwrites', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-test-'));
  const service = storage();
  try {
    const signal = new AbortController().signal;
    const result = await service.saveMediaStream(Readable.from([Buffer.from('hello')]), dir, 'image.jpg', { signal, maxBytes: 5 });
    assert.equal(result.fileSize, 5); assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'hello');
    const next = await service.saveMediaStream(Readable.from([Buffer.from('new')]), dir, 'image.jpg', { signal, maxBytes: 5 });
    assert.equal(path.basename(next.filePath), 'image_1.jpg'); assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'hello');
    await assert.rejects(service.saveMediaStream(Readable.from([Buffer.alloc(6)]), dir, 'oversize.jpg', { signal, maxBytes: 5 }), { code: 'MEDIA_OVERSIZED' });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['image.jpg', 'image_1.jpg']);
  } finally { removeTemp(dir); }
});
test('declared oversize is rejected before any media network API call', async () => {
  let downloaded = 0;
  const { BaileysMessageWrapper } = wrapper({ downloadMediaMessage() { downloaded++; } });
  const msg = new BaileysMessageWrapper({ key: { remoteJid: 'test', id: 'x' }, message: { imageMessage: { fileLength: 101 } } }, {});
  await assert.rejects(msg.downloadMedia({ signal: new AbortController().signal, maxBytes: 100 }), { code: 'MEDIA_OVERSIZED' });
  assert.equal(downloaded, 0);
});
test('Baileys media keys decrypt verified localhost ciphertext to file without base64 copies', async () => {
  const baileys = require('@whiskeysockets/baileys'); // No socket factory invoked.
  const key = crypto.randomBytes(32), plain = Buffer.from('verified local media payload');
  const keys = await baileys.getMediaKeys(key, 'image');
  const cipher = crypto.createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10);
  const encrypted = Buffer.concat([ciphertext, mac]);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(encrypted); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stream-test-'));
  try {
    const { BaileysMessageWrapper } = wrapper(baileys);
    const message = new BaileysMessageWrapper({ key: { remoteJid: 'test', id: 'm' },
      message: { imageMessage: { url: `http://127.0.0.1:${server.address().port}/media`, mediaKey: key,
        mimetype: 'image/jpeg', fileLength: plain.length } } }, {});
    const signal = new AbortController().signal;
    const media = await message.downloadMedia({ signal, maxBytes: 1000 });
    assert(!media.data); assert(media.stream);
    const result = await storage().saveMediaStream(media.stream, dir, 'media.jpg', { signal, maxBytes: 1000 });
    assert.deepEqual(fs.readFileSync(result.filePath), plain);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); removeTemp(dir); }
});
test('stalled localhost headers abort actual HTTP request and allow next queue job', async () => {
  let requestStarted, requestClosed;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const closed = new Promise(resolve => { requestClosed = resolve; });
  const server = http.createServer((req, res) => { requestStarted(); req.on('close', requestClosed); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const q = createMediaQueue({ concurrency: 1, maxQueued: 2, timeoutMs: 100 });
  try {
    const a = q.run(async signal => fetch(`http://127.0.0.1:${server.address().port}/stalled`, { signal }));
    const failure = assert.rejects(a, { code: 'MEDIA_TIMEOUT' });
    await started;
    const b = q.run(async () => 'next'); await failure;
    assert.equal(await b, 'next');
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Request did not close')), 1000).unref())]);
  } finally { await q.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('media shutdown aborts a partial stream and does not publish/archive success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cancel-test-'));
  const controller = new AbortController(), stream = new Readable({ read() {} });
  try {
    const task = storage().saveMediaStream(stream, dir, 'partial.jpg', { signal: controller.signal, maxBytes: 1000 });
    const rejected = assert.rejects(task, { name: 'AbortError' });
    stream.push(Buffer.from('partial'));
    controller.abort(new Error('shutdown')); await rejected;
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { removeTemp(dir); }
});
test('stalled encrypted response body aborts and frees the media slot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stalled-body-test-'));
  const q = createMediaQueue({ concurrency: 1, maxQueued: 2, timeoutMs: 100 });
  try {
    await withServer((req, res) => { res.writeHead(200); res.write(Buffer.alloc(32)); }, async url => {
      const task = q.run(async signal => {
        const stream = await openMediaStream({ url, mediaKey: crypto.randomBytes(32) }, 'image', { signal, maxBytes: 1000 });
        return storage().saveMediaStream(stream, dir, 'stalled.jpg', { signal, maxBytes: 1000 });
      });
      const next = q.run(async () => 'next');
      await assert.rejects(task, { code: 'MEDIA_TIMEOUT' }); assert.equal(await next, 'next');
      // Let the cancelled pipeline finish deleting its temporary file.
      for (let i = 0; i < 20 && fs.readdirSync(dir).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  } finally { await q.stop(); removeTemp(dir); }
});
test('HTTP body disconnect is a caught operation error, not an uncaught stream error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-broken-body-test-'));
  try {
    await withServer((req, res) => {
      res.writeHead(200); res.write(Buffer.alloc(64)); setTimeout(() => res.destroy(), 10);
    }, async url => {
      const signal = new AbortController().signal;
      const stream = await openMediaStream({ url, mediaKey: crypto.randomBytes(32) }, 'image', { signal, maxBytes: 1000 });
      await assert.rejects(storage().saveMediaStream(stream, dir, 'broken.jpg', { signal, maxBytes: 1000 }));
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  } finally { removeTemp(dir); }
});
test('corrupt MAC cannot publish media or leave partial archive files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-integrity-test-'));
  try {
    await withServer((req, res) => res.end(Buffer.alloc(42)), async url => {
      const signal = new AbortController().signal;
      const stream = await openMediaStream({ url, mediaKey: crypto.randomBytes(32) }, 'image', { signal, maxBytes: 1000 });
      await assert.rejects(storage().saveMediaStream(stream, dir, 'bad.jpg', { signal, maxBytes: 1000 }), { code: 'MEDIA_INTEGRITY' });
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  } finally { removeTemp(dir); }
});
test('message handler shutdown clears album timers, cache cap applies and import never migrates archive', async () => {
  let writes = 0;
  const handler = load('src/handlers/messageHandler.js', {
    '../config': { maxSeenAlbums: 3, seenAlbumTtlMs: 1000, maxAlbumBuffers: 2, maxAlbumItems: 2,
      listenGroups: true, listenDMs: true, listenBroadcasts: true, groupKeywords: [] },
    '../utils/logger': logger, '../utils/healthMonitor': { metrics }, '../utils/groupFilter': { isAllowed: () => true },
    './mediaHandler': { handle() {}, handleAlbum() {} }, '../services/jsonStorageService': { save: async () => { writes++; return true; } },
  });
  const msg = i => ({ id: { id: String(i) }, from: 'test', author: 'sender', hasMedia: true, timestamp: i * 10 + 1,
    getChat: async () => ({ isGroup: false, name: 'test' }), getContact: async () => ({}) });
  for (let i = 0; i < 10; i++) await handler.handle(msg(i), {});
  assert.equal(handler.stats().albumBuffers, 2); handler.beginStop(); await handler.stop();
  assert.equal(handler.stats().albumBuffers, 0); assert.equal(writes, 0);
  assert(!fs.readFileSync(path.resolve(__dirname, '../src/services/jsonStorageService.js'), 'utf8').includes('\nrunMigration();'));
});
test('album deadline preserves earlier successful files and NDJSON archive schema', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-archive-test-'));
  const config = { archiveBase: dir, maxMediaSizeMb: 1, mediaConcurrency: 1, maxMediaQueue: 2, mediaDownloadTimeoutMs: 100 };
  const service = load('src/services/storageService.js', { '../config': config, '../utils/logger': logger });
  const handler = load('src/handlers/mediaHandler.js', { '../config': config, '../utils/logger': logger,
    '../services/storageService': service, '../utils/healthMonitor': { metrics } });
  let persisted = 0;
  const json = load('src/services/jsonStorageService.js', { '../config': config, '../utils/logger': logger,
    './storageService': service, '../utils/healthMonitor': { metrics, markPersisted: () => persisted++ } });
  try {
    const messages = [
      { id: { id: 'one' }, downloadMedia: async () => ({ stream: Readable.from([Buffer.from('one')]), mimetype: 'image/jpeg' }) },
      { id: { id: 'two' }, downloadMedia: async () => ({ stream: new Readable({ read() {} }), mimetype: 'image/jpeg' }) },
    ];
    const record = await handler.handleAlbum(messages, { chatType: 'dm', chatName: 'Synthetic', sender: 'Synthetic', type: 'album', body: 'synthetic', timestamp: 1780708232 });
    assert(!record.mediaItems[0].skipped); assert(record.mediaItems[1].skipped);
    assert.equal(await json.save(record), true); assert.equal(persisted, 1);
    const msgDir = path.join(dir, 'dms', 'Synthetic', 'messages');
    const saved = JSON.parse(fs.readFileSync(path.join(msgDir, fs.readdirSync(msgDir)[0]), 'utf8').trim());
    assert.equal(saved.mediaCount, 2); assert.equal(saved.body, 'synthetic');
    assert.equal(saved.mediaItems[0].path, saved.mediaItems[0].filename); assert(!saved.mediaItems[0].messageId);
    assert.equal(fs.readFileSync(record.mediaItems[0].path, 'utf8'), 'one');
    await handler.stop();
    const images = path.join(dir, 'dms', 'Synthetic', 'images');
    for (let i = 0; i < 20 && fs.readdirSync(images).some(f => f.endsWith('.part')); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fs.readdirSync(images).length, 1);
  } finally { await handler.stop(); removeTemp(dir); }
});
