'use strict';
// U04：维护事务与环境锁。
// 计划 → 磁盘空间 → 服务 ownership → 获取环境锁 → 暂停提交并等待空闲 → 停止本应用拥有的服务 → 备份 → staging → 应用 → 健康检查 → 完成；
// 任一步失败 → 恢复 → 恢复检查。外部（非本应用拥有）服务仍在运行且与计划冲突时直接阻止。
const fs = require('node:fs');
const crypto = require('node:crypto');
const {AppError, CODES} = require('../core/errors.cjs');

const PHASES = ['plan', 'disk', 'services', 'lock', 'pause', 'stop', 'backup', 'staging', 'apply', 'check', 'done'];

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/**
 * @param {object} deps
 * @param {{environment: import('../core/locks.cjs').Mutex}} deps.locks
 * @param {() => Promise<{id:string, owned:boolean, running:boolean, roots?:string[]}[]>} deps.services  服务状态
 * @param {(id:string) => Promise<void>} deps.stopService   只会对 owned 服务调用
 * @param {(id:string) => Promise<void>} [deps.startService]
 * @param {{pauseSubmissions(reason):Function, waitForIdle(o?):Promise<void>}} [deps.queue] pauseSubmissions 返回租约释放函数
 * @param {(h:{id,lease,stopped}) => void} [deps.onHold] 恢复失败时接管租约
 * @param {(plan) => Promise<{dir:string}>} deps.backup     U02 备份
 * @param {(backupDir:string, plan) => Promise<object>} deps.restore U03 恢复（含恢复检查）
 */
class MaintenanceTransaction {
  constructor(deps) {
    this.deps = {freeBytes, ...deps};
    this.events = [];
    this.onEvent = deps.onEvent ?? (() => {});
  }
  emit(phase, state, extra = {}) { const e = {phase, state, at: new Date().toISOString(), ...extra}; this.events.push(e); this.onEvent(e); }

  /**
   * plan: {id?, title, roots: string[] 受影响目录, requiredBytes, stage(ctx), apply(ctx), check(ctx)}
   */
  async execute(plan) {
    const d = this.deps;
    const id = plan.id ?? `mt-${crypto.randomBytes(5).toString('hex')}`;
    const ctx = {id, plan, backupDir: null, stopped: [], log: []};
    let release = null, lease = null, applied = false, outcome = null;
    try {
      this.emit('plan', 'done', {title: plan.title});
      if (!plan.roots?.length || typeof plan.apply !== 'function') throw new AppError(CODES.INVALID_ARGUMENT, '维护计划缺少受影响目录或 apply 步骤。');

      const free = d.freeBytes(plan.spaceDir ?? plan.roots[0]);
      if (free !== null && plan.requiredBytes && free < plan.requiredBytes) throw new AppError(CODES.DISK_SPACE, `磁盘空间不足：需要 ${plan.requiredBytes}，可用 ${free}`, {details: {free, required: plan.requiredBytes}});
      this.emit('disk', 'done', {free});

      const services = await d.services();
      const conflicts = services.filter(s => s.running && !s.owned && (!s.roots || s.roots.some(r => plan.roots.some(p => p.startsWith(r) || r.startsWith(p)))));
      if (conflicts.length) throw new AppError(CODES.NOT_OWNED, `外部服务仍在运行，阻止维护：${conflicts.map(s => s.id).join('、')}`, {details: {conflicts: conflicts.map(s => s.id)}});
      this.emit('services', 'done');

      release = d.locks.environment.tryAcquire(`maintenance:${id}`);
      if (!release) throw new AppError(CODES.LOCKED, `环境维护锁正被 ${d.locks.environment.holder} 占用。`);
      this.emit('lock', 'done');

      if (d.queue) { lease = d.queue.pauseSubmissions(`maintenance:${id}`); await d.queue.waitForIdle({timeoutMs: plan.idleTimeoutMs ?? 600000}); }
      this.emit('pause', 'done');

      for (const s of services.filter(s => s.running && s.owned)) { await d.stopService(s.id); ctx.stopped.push(s.id); }
      this.emit('stop', 'done', {stopped: ctx.stopped});

      const bk = await d.backup(plan);
      ctx.backupDir = bk.dir;
      this.emit('backup', 'done', {dir: bk.dir});

      if (plan.stage) await plan.stage(ctx);
      this.emit('staging', 'done');

      applied = true;
      await plan.apply(ctx);
      this.emit('apply', 'done');

      if (plan.check) { const ok = await plan.check(ctx); if (ok === false) throw new AppError(CODES.INVALID_STATE, '程序健康检查未通过。'); }
      this.emit('check', 'done');
      this.emit('done', 'done');
      return {id, status: 'done', backupDir: ctx.backupDir, events: this.events};
    } catch (error) {
      this.emit('failed', 'error', {code: error.code, message: error.message});
      if (applied && ctx.backupDir) {
        try {
          this.emit('restore', 'running');
          const r = await d.restore(ctx.backupDir, plan);
          this.emit('restore-check', 'done', {restoreId: r?.id});
          return {id, status: 'restored', error: {code: error.code, message: error.message}, backupDir: ctx.backupDir, events: this.events};
        } catch (re) {
          this.emit('restore-check', 'error', {message: re.message});
          outcome = 'restore-failed';
          return {id, status: 'restore-failed', held: true, error: {code: error.code, message: error.message}, restoreError: {code: re.code, message: re.message}, backupDir: ctx.backupDir, events: this.events};
        }
      }
      return {id, status: 'blocked', error: {code: error.code ?? CODES.INTERNAL, message: error.message}, events: this.events};
    } finally {
      // D05：恢复失败时环境不可信——不启动服务、不恢复提交；租约交给调用方，直到用户完成恢复。
      if (outcome === 'restore-failed') { this.emit('hold', 'error', {stopped: ctx.stopped}); d.onHold?.({id, lease, stopped: ctx.stopped}); }
      else {
        for (const sid of ctx.stopped) { try { await d.startService?.(sid); } catch { /* 由服务页显示 */ } }
        if (typeof lease === 'function') lease();
      }
      release?.();
    }
  }
}

module.exports = {MaintenanceTransaction, PHASES, freeBytes};
