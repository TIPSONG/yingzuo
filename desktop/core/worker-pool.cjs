'use strict';
// R17/S09/C08：主进程外的文件工作执行层。每个任务独占一个 worker（简单、可通过 terminate 立即取消）；并发受 size 限制，超出排队。
// C08 生命周期：open → closing → closed。close() 一开始就拒绝新任务、停止从队列启动 worker；重复 close 共用同一 Promise；
// 完成时所有任务 Promise 都已终态、活动 worker 为零。每个任务独立持有 worker、监听器与取消状态，结束一次即全部清理。
// 临时产物由主进程登记（job.args.tmp / dest 的临时名），worker 被 terminate 时 catch 不会执行，由 onKilled 清理。
const path = require('node:path');
const fs = require('node:fs');
const {Worker} = require('node:worker_threads');

const WORKER = path.join(__dirname, 'workers', 'file-worker.cjs');
const cancelled = (msg = '已取消') => Object.assign(new Error(msg), {code: 'CANCELLED'});
class WorkerPool {
  constructor({size = 2, script = WORKER} = {}) { this.size = size; this.script = script; this.active = new Set(); this.waiting = []; this.seq = 0; this.state = 'open'; this.closing = null; }
  get activeCount() { return this.active.size; }
  /** run(kind, args, {onProgress, signal, temps}) → Promise<result>；signal 中止时终止 worker 并以 CANCELLED 拒绝。temps：中途被终止时要清理的临时文件。 */
  run(kind, args, {onProgress, signal, temps = []} = {}) {
    if (this.state !== 'open') return Promise.reject(Object.assign(new Error('文件工作线程正在关闭，未接受新任务。'), {code: 'CLOSED'}));
    return new Promise((resolve, reject) => {
      const job = {kind, args, onProgress, signal, temps, settled: false, worker: null, cleanup: []};
      job.finish = (ok, v) => {
        if (job.settled) return; job.settled = true;
        for (const f of job.cleanup.splice(0)) { try { f(); } catch { /* 忽略 */ } }
        const i = this.waiting.indexOf(job); if (i >= 0) this.waiting.splice(i, 1);
        if (job.worker) { this.active.delete(job.worker); job.worker.terminate().catch(() => {}); }
        if (!ok && job.worker) for (const t of job.temps) { try { fs.rmSync(t, {force: true}); } catch { /* 忽略 */ } } // 被终止的 worker 不会执行自身 catch
        (ok ? resolve : reject)(v);
        if (this.state === 'open') this._next();
      };
      if (signal?.aborted) return job.finish(false, cancelled());
      if (signal) { const onAbort = () => job.finish(false, cancelled()); signal.addEventListener('abort', onAbort, {once: true}); job.cleanup.push(() => signal.removeEventListener('abort', onAbort)); }
      this.waiting.push(job); this._next();
    });
  }
  _next() {
    while (this.state === 'open' && this.active.size < this.size && this.waiting.length) {
      const job = this.waiting.shift(), id = ++this.seq, w = new Worker(this.script);
      job.worker = w; this.active.add(w);
      const onMessage = m => {
        if (m.id !== id) return;
        if (m.progress) return job.onProgress?.(m.progress);
        if (m.error) job.finish(false, Object.assign(new Error(m.error.message), {code: m.error.code})); else job.finish(true, m.result);
      };
      const onError = e => job.finish(false, Object.assign(e, {code: e.code ?? 'WORKER_CRASHED'}));
      const onExit = c => job.finish(false, Object.assign(new Error(`worker 意外退出（${c}）`), {code: 'WORKER_EXITED'}));
      w.on('message', onMessage); w.on('error', onError); w.on('exit', onExit);
      job.cleanup.push(() => { w.off('message', onMessage); w.off('error', onError); w.off('exit', onExit); });
      w.postMessage({id, kind: job.kind, args: job.args});
      this._jobs ??= new Set(); this._jobs.add(job); job.cleanup.push(() => this._jobs.delete(job));
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.state = 'closing';
    const jobs = [...this.waiting.splice(0), ...(this._jobs ?? [])];
    this.closing = (async () => {
      const exits = [...this.active].map(w => new Promise(r => { if (w.threadId === -1) return r(); w.once('exit', r); }));
      for (const j of jobs) j.finish(false, cancelled('文件工作线程已关闭，任务已取消。'));
      await Promise.race([Promise.all(exits), new Promise(r => setTimeout(r, 5000))]);
      this.active.clear(); this.state = 'closed';
    })();
    return this.closing;
  }
}
let shared = null;
/** S09：全应用共享一个池（并发上限 2），退出时 closeShared() 终止全部 worker。关闭后再取会得到新池。 */
const sharedPool = () => (shared && shared.state === 'open' ? shared : (shared = new WorkerPool({size: 2})));
async function closeShared() { const p = shared; shared = null; if (p) await p.close(); }
module.exports = {WorkerPool, WORKER, sharedPool, closeShared};
