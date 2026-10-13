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
// RV10：临时产物由主进程预先分配并登记（worker 只使用给定的临时名）。按任务种类生成：
const TEMP_PLAN = {
  copyFile: (a, id) => { a.tmp ??= `${a.dest}.yz-copy-${process.pid}-${id}-${Date.now()}`; return [a.tmp]; },
  packBuild: (a, id) => { a.tmp ??= `${a.target}.yz-pack-${process.pid}-${id}-${Date.now()}`; return [a.tmp]; },
  thumbnail: a => (a.tmp ? [a.tmp] : []),
};
/** RV10：可恢复的临时文件登记（JSON 文件）。只记录本应用分配的路径；启动时只清理这些路径。 */
class TempJournal {
  constructor(file) { this.file = file; }
  read() { try { const v = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(v?.items) ? v.items : []; } catch { return []; } }
  write(items) {
    if (!this.file) return;
    if (!items.length) { try { fs.rmSync(this.file, {force: true}); } catch { /* 下次再试 */ } return; }
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({items})); fs.renameSync(tmp, this.file);
  }
  add(paths, info = {}) { if (!this.file || !paths.length) return; const items = this.read(); for (const p of paths) if (!items.some(i => i.path === p)) items.push({path: p, at: new Date().toISOString(), ...info}); this.write(items); }
  remove(paths) { if (!this.file || !paths.length) return; this.write(this.read().filter(i => !paths.includes(i.path))); }
  /** 启动恢复：逐项删除登记的未提交临时文件；删不掉的保留在登记中。 */
  recover() {
    const left = [], removed = [];
    for (const it of this.read()) { try { fs.rmSync(it.path, {force: true}); removed.push(it.path); } catch { left.push(it); } }
    this.write(left); return {removed, pending: left.map(i => i.path)};
  }
}
class WorkerPool {
  constructor({size = 2, script = WORKER, journalFile = null} = {}) { this.size = size; this.script = script; this.active = new Set(); this.waiting = []; this.seq = 0; this.state = 'open'; this.closing = null; this.journal = new TempJournal(journalFile); this.cleanups = new Set(); }
  get activeCount() { return this.active.size; }
  /** RV10：等待已结束任务的临时文件清理完成（worker 已真实退出之后执行）。 */
  async cleaned() { while (this.cleanups.size) await Promise.all([...this.cleanups]); }
  /** run(kind, args, {onProgress, signal, temps}) → Promise<result>；signal 中止时终止 worker 并以 CANCELLED 拒绝。temps：中途被终止时要清理的临时文件。 */
  run(kind, args, {onProgress, signal, temps = []} = {}) {
    if (this.state !== 'open') return Promise.reject(Object.assign(new Error('文件工作线程正在关闭，未接受新任务。'), {code: 'CLOSED'}));
    return new Promise((resolve, reject) => {
      const job = {kind, args, onProgress, signal, temps, settled: false, worker: null, cleanup: []};
      job.finish = (ok, v) => {
        if (job.settled) return; job.settled = true;
        for (const f of job.cleanup.splice(0)) { try { f(); } catch { /* 忽略 */ } }
        const i = this.waiting.indexOf(job); if (i >= 0) this.waiting.splice(i, 1);
        if (job.worker) {
          const w = job.worker; this.active.delete(w);
          // RV10：先确认 worker 真正退出（句柄已关闭）再清理登记的临时文件；清理失败保留可恢复记录
          const exited = new Promise(r => { if (w.threadId === -1) return r(); w.once('exit', r); });
          w.terminate().catch(() => {});
          const temps = job.temps.slice();
          const c = exited.then(() => {
            const failed = [];
            for (const t of temps) { if (ok && !fs.existsSync(t)) continue; try { fs.rmSync(t, {force: true}); } catch { failed.push(t); } }
            try { this.journal.remove(temps.filter(t => !failed.includes(t))); } catch { /* 记录保留，下次启动处理 */ }
          });
          this.cleanups.add(c); c.finally(() => this.cleanups.delete(c));
        }
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
      const job = this.waiting.shift(), id = ++this.seq;
      // RV10：启动 worker 前在主进程分配并登记临时路径
      const planned = TEMP_PLAN[job.kind]?.(job.args ??= {}, id) ?? [];
      job.temps = [...new Set([...job.temps, ...planned])];
      try { this.journal.add(job.temps, {kind: job.kind}); } catch (e) { job.finish(false, Object.assign(new Error(`无法登记临时文件：${e.message}`), {code: 'TEMP_JOURNAL'})); continue; }
      const w = new Worker(this.script);
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
      await Promise.race([Promise.all([...this.cleanups]), new Promise(r => setTimeout(r, 5000))]);
      this.active.clear(); this.state = 'closed';
    })();
    return this.closing;
  }
}
let shared = null, sharedJournal = null;
/** S09：全应用共享一个池（并发上限 2），退出时 closeShared() 终止全部 worker。
 * RV10：关闭中/关闭后返回同一个已关闭的池（晚到调用得到 CLOSED），不会再创建新池写数据；只有 reopenShared() 才重建。 */
const sharedPool = () => (shared ??= new WorkerPool({size: 2, journalFile: sharedJournal}));
/** RV10：主进程启动时设置登记文件并清理上次遗留的已登记临时文件。 */
function configureShared({journalFile}) { sharedJournal = journalFile; return new TempJournal(journalFile).recover(); }
async function closeShared() { const p = shared; if (p) await p.close(); }
function reopenShared() { if (shared && shared.state !== 'closed') return shared; shared = null; return sharedPool(); }
module.exports = {WorkerPool, TempJournal, WORKER, sharedPool, closeShared, configureShared, reopenShared};
