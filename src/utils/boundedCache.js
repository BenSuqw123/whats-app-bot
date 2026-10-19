'use strict';
class BoundedCache {
  constructor(maxSize, ttlMs, now = Date.now) {
    this.maxSize = maxSize; this.ttlMs = ttlMs; this.now = now; this.entries = new Map();
  }
  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at < this.ttlMs) break;
      this.entries.delete(key);
    }
  }
  set(key, value) {
    this.prune(); this.entries.delete(key); this.entries.set(key, { at: this.now(), value });
    while (this.entries.size > this.maxSize) this.entries.delete(this.entries.keys().next().value);
  }
  add(key) { this.set(key, true); }
  get(key) { this.prune(); return this.entries.get(key)?.value; }
  has(key) { this.prune(); return this.entries.has(key); }
  clear() { this.entries.clear(); }
  get size() { this.prune(); return this.entries.size; }
}
module.exports = { BoundedCache };
