'use strict';

function createMediaQueue({ concurrency, maxQueued, timeoutMs, now = Date.now }) {
  const queued = [], active = new Set();
  let stopped = false;
  function pump() {
    while (!stopped && active.size < concurrency && queued.length) execute(queued.shift());
  }
  function execute(job) {
    const controller = new AbortController();
    let timeout, completed = false;
    const activeJob = { controller, promise: job.promise };
    active.add(activeJob);
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    timeout = setTimeout(() => controller.abort(Object.assign(new Error('Media download deadline exceeded'), { code: 'MEDIA_TIMEOUT' })), timeoutMs);
    // Observe both branches. A late result cannot save data: the worker checks the signal.
    Promise.race([Promise.resolve().then(() => job.work(controller.signal)), aborted])
      .then(job.resolve, job.reject).finally(() => {
        if (completed) return;
        completed = true; clearTimeout(timeout); active.delete(activeJob); pump();
      }).catch(() => {});
  }
  function run(work) {
    if (stopped) return Promise.reject(Object.assign(new Error('Media queue stopped'), { code: 'STOPPING' }));
    if (active.size >= concurrency && queued.length >= maxQueued) {
      return Promise.reject(Object.assign(new Error('Media queue full; media skipped'), { code: 'MEDIA_QUEUE_FULL' }));
    }
    const job = { work, at: now() };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (active.size < concurrency) execute(job); else queued.push(job);
    return job.promise;
  }
  function beginStop() {
    if (stopped) return;
    stopped = true;
    const error = Object.assign(new Error('Media cancelled during shutdown'), { code: 'STOPPING' });
    for (const job of queued.splice(0)) job.reject(error);
    for (const job of active) job.controller.abort(error);
  }
  return { run, beginStop,
    async stop() { beginStop(); await Promise.allSettled([...active].map(job => job.promise)); },
    stats: () => ({ mediaActive: active.size, mediaQueued: queued.length,
      mediaQueueOldestAge: queued.length ? now() - queued[0].at : 0 }),
  };
}
module.exports = { createMediaQueue };
