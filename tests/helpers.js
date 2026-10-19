'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const os = require('os');
function removeTemp(dir) {
  const target = path.resolve(dir);
  if (path.dirname(target).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()
      || !path.basename(target).startsWith('wa-')) throw new Error('Refusing cleanup outside the named test temporary directory');
  fs.rmSync(target, { recursive: true });
}
function load(file, mocks) {
  const filename = path.resolve(__dirname, '..', file);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const fn = vm.runInThisContext('(function(require,module,exports,__filename,__dirname,process,setTimeout,clearTimeout){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename });
  fn(name => Object.hasOwn(mocks, name) ? mocks[name] : nativeRequire(name), module, module.exports, filename, path.dirname(filename),
    mocks.$process || process, mocks.$setTimeout || setTimeout, mocks.$clearTimeout || clearTimeout);
  return module.exports;
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
class Clock {
  constructor() { this.time = 0; this.id = 0; this.tasks = new Map(); this.peak = 0; }
  now = () => this.time;
  setTimeout = (fn, delay) => {
    const id = ++this.id; this.tasks.set(id, { fn, at: this.time + delay });
    this.peak = Math.max(this.peak, this.tasks.size); return id;
  };
  clearTimeout = id => { this.tasks.delete(id); };
  async tick(ms) {
    const end = this.time + ms;
    await flush();
    while (true) {
      const next = [...this.tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.tasks.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = end; await flush();
  }
}
function socket() {
  return { ev: new EventEmitter(), ended: 0, async end() { this.ended++; } };
}
const config = { reconnectInitialDelayMs: 5000, reconnectMaxDelayMs: 120000,
  stableConnectionMs: 60000, connectionReadyTimeoutMs: 60000, socketEndTimeoutMs: 10000 };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const metrics = new Proxy({}, { get: () => () => {} });
module.exports = { load, flush, Clock, socket, config, logger, metrics, removeTemp };
