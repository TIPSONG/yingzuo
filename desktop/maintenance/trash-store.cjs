'use strict';
// R14：回收区登记与空间管理。只管理通过本模块登记的条目（trashDir/.registry.json），
// 永久清理需显式确认并在执行时再次核对：路径必须在 trashDir 内、未被保护（在用备份/未完成恢复/仍被引用）。
// 接入钩子（主线）：maintenance.pruneBackups、plugin-ops.removePlan、favorites 的 renameSync 改用 trash.move()；IPC 增加 trash.list/restore/planPurge/purge。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sizeOf(p) {
  let st; try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0; for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e)); return n;
}
const inside = (root, p) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

class TrashStore {
  constructor({trashDir, now = () => Date.now()}) { this.dir = path.resolve(trashDir); this.now = now; this.file = path.join(this.dir, '.registry.json'); }
  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {items: []}; } }
  _save(d) { fs.mkdirSync(this.dir, {recursive: true}); const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, this.file); }
  /** 移入回收区并登记。kind: backup|plugin|favorite|other。 */
  move(src, {kind = 'other', note = null} = {}) {
    const from = path.resolve(src);
    if (!fs.existsSync(from)) throw Object.assign(new Error(`来源不存在：${from}`), {code: 'NOT_FOUND'});
    if (from === this.dir || inside(from, this.dir) || inside(this.dir, from)) throw Object.assign(new Error('不能把回收区自身或其中内容再次移入回收区。'), {code: 'INVALID_PATH'});
    const id = `tr_${crypto.randomUUID()}`, stored = path.join(this.dir, kind, `${id}-${path.basename(from)}`);
    fs.mkdirSync(path.dirname(stored), {recursive: true});
    const bytes = sizeOf(from);
    try { fs.renameSync(from, stored); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(from, stored, {recursive: true}); fs.rmSync(from, {recursive: true, force: true}); } // 跨盘：复制后删源
    const d = this._load(); const entry = {id, kind, origin: from, stored, bytes, at: this.now(), note}; d.items.push(entry); this._save(d);
    return entry;
  }
  /** 列表：附带实际存在与当前大小（真实空间）。 */
  list() { return this._load().items.map(e => ({...e, exists: fs.existsSync(e.stored), bytes: fs.existsSync(e.stored) ? sizeOf(e.stored) : 0})); }
  restore(id) {
    const d = this._load(), e = d.items.find(x => x.id === id);
    if (!e) throw Object.assign(new Error('回收条目不存在。'), {code: 'NOT_FOUND'});
    if (!fs.existsSync(e.stored)) throw Object.assign(new Error('回收区中的文件已不存在。'), {code: 'NOT_FOUND'});
    if (fs.existsSync(e.origin)) throw Object.assign(new Error(`原位置已有同名内容：${e.origin}`), {code: 'CONFLICT'});
    fs.mkdirSync(path.dirname(e.origin), {recursive: true}); fs.renameSync(e.stored, e.origin);
    d.items = d.items.filter(x => x.id !== id); this._save(d); return e;
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
    if (!inside(this.dir, path.resolve(e.stored))) return '登记路径不在回收区内，拒绝删除';
    try { if (fs.existsSync(e.stored) && !inside(fs.realpathSync(this.dir), fs.realpathSync(e.stored))) return '实际路径（链接）越出回收区，拒绝删除'; } catch { return '无法核对路径'; }
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
