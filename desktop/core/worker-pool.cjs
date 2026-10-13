'use strict';
// R17：主进程外的文件工作执行层。每个任务独占一个 worker（简单、可通过 terminate 立即取消）；并发受 size 限制，超出排队。
// 接入钩子（主线）：资源扫描/hash、图片元数据与缩略图、备份复制改为 pool.run(...)；打包需包含 desktop/core/workers/。
const path = require('node:path');
const {Worker} = require('node:worker_threads');

const WORKER = path.join(__dirname, 'workers', 'file-worker.cjs');
class WorkerPool {
  constructor({size = 2, script = WORKER} = {}) { this.size = size; this.script = script; this.active = new Set(); this.waiting = []; this.seq = 0; }
  /** run(kind, args, {onProgress, signal}) → Promise<result>；signal 中止时终止 worker 并以 CANCELLED 拒绝。 */
  run(kind, args, {onProgress, signal} = {}) {
    return new Promise((resolve, reject) => {
      const job = {kind, args, onProgress, signal, resolve, reject};
      if (signal?.aborted) return reject(cancelled());
      signal?.addEventListener('abort', () => { const i = this.waiting.indexOf(job); if (i >= 0) { this.waiting.splice(i, 1); reject(cancelled()); } }, {once: true});
      this.waiting.push(job); this._next();
    });
  }
  _next() {
    while (this.active.size < this.size && this.waiting.length) {
      const job = this.waiting.shift(), id = ++this.seq, w = new Worker(this.script);
      this.active.add(w);
      let settled = false;
      const finish = (fn, v) => { if (settled) return; settled = true; this.active.delete(w); w.terminate().catch(() => {}); fn(v); this._next(); };
      const onAbort = () => finish(job.reject, cancelled());
      job.signal?.addEventListener('abort', onAbort, {once: true});
      w.on('message', m => {
        if (m.id !== id) return;
        if (m.progress) return job.onProgress?.(m.progress);
        job.signal?.removeEventListener('abort', onAbort);
        if (m.error) finish(job.reject, Object.assign(new Error(m.error.message), {code: m.error.code})); else finish(job.resolve, m.result);
      });
      w.on('error', e => finish(job.reject, Object.assign(e, {code: e.code ?? 'WORKER_CRASHED'})));
      w.on('exit', c => finish(job.reject, Object.assign(new Error(`worker 意外退出（${c}）`), {code: 'WORKER_EXITED'})));
      w.postMessage({id, kind: job.kind, args: job.args});
    }
  }
  async close() { this.waiting.splice(0).forEach(j => j.reject(cancelled())); await Promise.all([...this.active].map(w => w.terminate())); this.active.clear(); }
}
const cancelled = () => Object.assign(new Error('已取消'), {code: 'CANCELLED'});
module.exports = {WorkerPool, WORKER};
