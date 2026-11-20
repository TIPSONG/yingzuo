'use strict';
// R14：回收区登记与空间管理。只管理通过本模块登记的条目（trashDir/.registry.json），
// 永久清理需显式确认并在执行时再次核对：路径必须在 trashDir 内、未被保护（在用备份/未完成恢复/仍被引用）。
// 接入钩子（主线）：maintenance.pruneBackups、plugin-ops.removePlan、favorites 的 renameSync 改用 trash.move()；IPC 增加 trash.list/restore/planPurge/purge。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {writeJsonAtomic} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');

function sizeOf(p) {
  let st; try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0; for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e)); return n;
}
const inside = (root, p) => { const r = path.relative(root, p); return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const kinds = new Set(['backup', 'plugin', 'favorite', 'other']);

// Record the precise file/directory that will be renamed, including the staged object on another volume.
function itemIdentity(file) {
  const st = fs.lstatSync(file, {bigint: true, throwIfNoEntry: false});
  return st && st.ino !== 0n ? [st.dev, st.ino, st.birthtimeNs].join('/') : null;
}

function moveToEmpty(from, to, beforePublish) {
  // lstat also detects a dangling link, which is still an occupied destination.
  if (fs.lstatSync(to, {throwIfNoEntry: false})) throw new AppError(CODES.CONFLICT, `目标位置已有同名内容：${to}`);
  beforePublish?.(from);
  try { fs.renameSync(from, to); return; } catch (error) { if (error.code !== 'EXDEV') throw error; }
  // Copy fully on the destination volume before publishing; a failed copy leaves the source untouched.
  const stage = fs.mkdtempSync(path.join(path.dirname(to), '.trash-stage-'));
  try {
    const payload = path.join(stage, 'payload');
    fs.cpSync(from, payload, {recursive: true, verbatimSymlinks: true, preserveTimestamps: true});
    if (fs.lstatSync(to, {throwIfNoEntry: false})) throw new AppError(CODES.CONFLICT, `目标位置已有同名内容：${to}`);
    beforePublish?.(payload);
    fs.renameSync(payload, to);
  } finally { fs.rmSync(stage, {recursive: true, force: true}); }
  fs.rmSync(from, {recursive: true});
}

class TrashStore {
  constructor({trashDir, now = () => Date.now()}) { this.dir = path.resolve(trashDir); this.now = now; this.file = path.join(this.dir, '.registry.json'); }
  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {items: []}; throw error; }
    let data;
    try { data = JSON.parse(raw); } catch { /* report the registry path for recovery */ }
    if (!Array.isArray(data?.items)) throw new AppError(CODES.CORRUPT_DATA, `回收区登记文件损坏：${this.file}。请从备份恢复。`);
    return data;
  }
  _save(d) { writeJsonAtomic(this.file, d); }
  /** 移入回收区并登记。kind: backup|plugin|favorite|other。 */
  move(src, {kind = 'other', note = null, favorite = null} = {}) {
    const from = path.resolve(src);
    if (!kinds.has(kind)) throw new AppError(CODES.INVALID_ARGUMENT, '未知回收条目类型。');
    if (!fs.existsSync(from)) throw Object.assign(new Error(`来源不存在：${from}`), {code: 'NOT_FOUND'});
    if (!path.relative(from, this.dir) || inside(from, this.dir) || inside(this.dir, from)) throw Object.assign(new Error('不能把回收区自身或其中内容再次移入回收区。'), {code: 'INVALID_PATH'});
    const id = `tr_${crypto.randomUUID()}`, stored = path.join(this.dir, kind, `${id}-${path.basename(from)}`);
    const d = this._load();
    const entry = {id, kind, origin: from, stored, bytes: sizeOf(from), at: this.now(), note, ...(favorite && {favorite})};
    fs.mkdirSync(path.dirname(stored), {recursive: true});
    // Persist the recovery location before removing the only reference to the old path.
    this._save({items: [...d.items, entry]});
    try { moveToEmpty(from, stored); } catch (error) {
      if (!fs.lstatSync(stored, {throwIfNoEntry: false})) this._save(d);
      throw error;
    }
    return entry;
  }
  /** 列表：附带实际存在与当前大小（真实空间）。 */
  list() {
    return this._load().items.map(e => {
      const exists = !this._unsafe(e) && fs.existsSync(e.stored);
      return {...e, exists, bytes: exists ? sizeOf(e.stored) : 0};
    });
  }
  restorable(id, d = this._load()) {
    const e = d.items.find(x => x.id === id);
    if (!e) throw Object.assign(new Error('回收条目不存在。'), {code: 'NOT_FOUND'});
    const unsafe = this._unsafe(e);
    if (unsafe) throw new AppError(CODES.INVALID_PATH, unsafe);
    if (!path.relative(e.origin, this.dir) || inside(this.dir, e.origin) || inside(e.origin, this.dir)) throw new AppError(CODES.INVALID_PATH, '回收条目的原位置无效。');
    if (!fs.existsSync(e.stored)) {
      if (e.restoringIdentity && itemIdentity(e.origin) === e.restoringIdentity) return e;
      throw Object.assign(new Error('回收区中的文件已不存在。'), {code: 'NOT_FOUND'});
    }
    if (fs.lstatSync(e.origin, {throwIfNoEntry: false})) throw new AppError(CODES.CONFLICT, `原位置已有同名内容：${e.origin}`);
    return e;
  }
  restore(id) {
    const d = this._load(), e = this.restorable(id, d);
    // A previous process may already have published the verified object and exited before deregistration.
    if (!fs.existsSync(e.stored)) {
      this._save({items: d.items.filter(x => x.id !== id)});
      return e;
    }
    fs.mkdirSync(path.dirname(e.origin), {recursive: true});
    moveToEmpty(e.stored, e.origin, payload => { e.restoringIdentity = itemIdentity(payload); this._save(d); });
    try { this._save({items: d.items.filter(x => x.id !== id)}); }
    catch (error) { moveToEmpty(e.origin, e.stored); throw error; }
    return e;
  }
  /**
   * 清理计划（不删除）：olderThanMs 或 ids 选择；isProtected(entry) → 原因字符串或 null。
   * 返回 {items, bytes, skipped:[{id, reason}]}。
   */
  planPurge({olderThanMs = null, ids = null, isProtected = () => null} = {}) {
    const items = [], skipped = [];
    for (const e of this.list()) {
      if (ids && !ids.includes(e.id)) continue;
      if (olderThanMs != null && this.now() - e.at < olderThanMs) continue;
      const why = this._unsafe(e) ?? isProtected(e);
      if (why) skipped.push({id: e.id, reason: why}); else items.push(e);
    }
    return {items, bytes: items.reduce((n, e) => n + e.bytes, 0), skipped};
  }
  _unsafe(e) {
    if (typeof e.stored !== 'string' || !path.isAbsolute(e.stored) || !inside(this.dir, e.stored)) return '登记路径不在回收区内';
    if (!kinds.has(e.kind) || !/^tr_[\da-f-]{36}$/i.test(e.id) || typeof e.origin !== 'string' || !path.isAbsolute(e.origin)) return '回收条目的身份或原位置无效';
    if (path.relative(path.join(this.dir, e.kind, `${e.id}-${path.basename(e.origin)}`), e.stored)) return '回收文件位置与登记的身份不符';
    try { if (fs.existsSync(e.stored) && !inside(fs.realpathSync(this.dir), fs.realpathSync(e.stored))) return '实际路径（链接）越出回收区'; } catch { return '无法核对路径'; }
    return null;
  }
  /** 永久清理：必须 confirm:true；执行时逐项再次核对。重复清理/已消失文件只注销登记。 */
  purge(plan, {confirm = false, isProtected = () => null} = {}) {
    if (confirm !== true) throw Object.assign(new Error('永久清理需要明确确认。'), {code: 'CONFIRM_REQUIRED'});
    const d = this._load(), purged = [], skipped = [];
    for (const p of plan.items) {
      const e = d.items.find(x => x.id === p.id);
      if (!e) { skipped.push({id: p.id, reason: '已不在登记中（可能已清理）'}); continue; }
      const why = this._unsafe(e) ?? isProtected(e);
      if (why) { skipped.push({id: e.id, reason: why}); continue; }
      fs.rmSync(e.stored, {recursive: true, force: true});
      d.items = d.items.filter(x => x.id !== e.id); purged.push(e.id);
    }
    this._save(d); return {purged, skipped};
  }
}
module.exports = {TrashStore, sizeOf};
