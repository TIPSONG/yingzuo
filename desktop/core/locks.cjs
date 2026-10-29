'use strict';
// F06：命令串行、环境维护锁、GPU 工作锁、超时与取消 token。
const {AppError, CODES} = require('./errors.cjs');

class CancelToken {
  constructor() { this.cancelled = false; this.reason = null; this.listeners = new Set(); }
  cancel(reason = '已取消') {
    if (this.cancelled) return;
    this.cancelled = true; this.reason = reason;
    for (const fn of [...this.listeners]) { try { fn(reason); } catch { /* 监听器错误不影响取消 */ } }
    this.listeners.clear();
  }
  onCancel(fn) {
    if (this.cancelled) { fn(this.reason); return () => {}; }
    this.listeners.add(fn); return () => this.listeners.delete(fn);
  }
  throwIfCancelled() { if (this.cancelled) throw new AppError(CODES.CANCELLED, this.reason); }
  /** 供 fetch 等使用的 AbortSignal */
  get signal() {
    if (!this._controller) { this._controller = new AbortController(); this.onCancel(r => this._controller.abort(new AppError(CODES.CANCELLED, r))); }
    return this._controller.signal;
  }
}

/** 先进先出互斥锁；acquire 支持超时与取消，返回 release 函数。 */
class Mutex {
  constructor(name) { this.name = name; this.holder = null; this.waiters = []; }
  get locked() { return this.holder !== null; }
  acquire({owner = 'anonymous', timeoutMs = 0, token} = {}) {
    if (token?.cancelled) return Promise.reject(new AppError(CODES.CANCELLED, token.reason));
    if (!this.holder) { this.holder = owner; return Promise.resolve(this._release(owner)); }
    return new Promise((resolve, reject) => {
      const waiter = {owner, resolve, reject, timer: null, off: null};
      const remove = () => { const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1); clearTimeout(waiter.timer); waiter.off?.(); };
      if (timeoutMs > 0) waiter.timer = setTimeout(() => { remove(); reject(new AppError(CODES.LOCKED, `${this.name} 正被 ${this.holder} 占用，等待超时。`, {details: {holder: this.holder}})); }, timeoutMs);
      if (token) waiter.off = token.onCancel(reason => { remove(); reject(new AppError(CODES.CANCELLED, reason)); });
      waiter.done = () => { clearTimeout(waiter.timer); waiter.off?.(); };
      this.waiters.push(waiter);
    });
  }
  tryAcquire(owner = 'anonymous') { if (this.holder) return null; this.holder = owner; return this._release(owner); }
  _release(owner) {
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = this.waiters.shift();
      if (next) { next.done(); this.holder = next.owner; next.resolve(this._release(next.owner)); }
      else this.holder = null;
    };
  }
  async run(fn, options) { const release = await this.acquire(options); try { return await fn(); } finally { release(); } }
}

/** 串行命令队列：前一个失败不影响后一个。 */
class SerialQueue {
  constructor() { this.tail = Promise.resolve(); this.pending = 0; }
  enqueue(operation) {
    this.pending++;
    const task = this.tail.then(operation);
    this.tail = task.catch(() => {}).finally(() => { this.pending--; });
    return task;
  }
}

function withTimeout(promise, ms, message = '操作超时') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new AppError(CODES.TIMEOUT, message)), ms); })]).finally(() => clearTimeout(timer));
}

/** 应用级锁集合：维护（环境）锁与 GPU 工作锁。 */
function createLocks() {
  return {environment: new Mutex('环境维护锁'), gpu: new Mutex('GPU 工作锁'), commands: new SerialQueue()};
}
module.exports = {CancelToken, Mutex, SerialQueue, withTimeout, createLocks};
