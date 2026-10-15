'use strict';
// U03：恢复引擎。准备 → 逐来源（staging → 保留现场 → 搬回被排除的大文件 → 切换 → 校验）→ 完成。
// 每一步写 journal，中途退出后可用 resume() 继续；每步幂等。
// 安全规则：备份不完整／hash 不符时拒绝；备份内容为空而目标非空时拒绝（禁止空目录覆盖旧环境）；
// 只恢复到 originalPath；当前环境整体改名保留为“失败现场”，不删除。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {sha256File, writeJsonAtomic} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');
const {verifyBackup} = require('./backup.cjs');

const STEPS = ['stage', 'preserve', 'carry', 'swap', 'verify'];

function isNonEmpty(p) {
  if (!fs.existsSync(p)) return false;
  const st = fs.lstatSync(p);
  return st.isDirectory() ? fs.readdirSync(p).length > 0 : st.size > 0;
}

class RestoreEngine {
  constructor({journalDir, now = () => new Date().toISOString(), hooks = {}}) {
    this.journalDir = journalDir; this.now = now; this.hooks = hooks;
    fs.mkdirSync(journalDir, {recursive: true});
  }
  journalPath(id) { return path.join(this.journalDir, `${id}.json`); }
  load(id) {
    const f = this.journalPath(id);
    if (!fs.existsSync(f)) throw new AppError(CODES.NOT_FOUND, `恢复 journal 不存在：${id}`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  save(j) { j.updatedAt = this.now(); writeJsonAtomic(this.journalPath(j.id), j); }
  /** 列出未完成的恢复（启动时调用以提示继续）。 */
  pending() {
    return fs.readdirSync(this.journalDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(this.journalDir, f), 'utf8'))).filter(j => j.status !== 'done' && j.status !== 'aborted');
  }

  /** 准备：校验备份并生成 journal，不改动任何目标。 */
  async prepare(backupDir, {only} = {}) {
    const v = await verifyBackup(backupDir);
    if (!v.ok) throw new AppError(CODES.INTEGRITY, '备份校验失败，拒绝恢复。', {details: {problems: v.problems}});
    const rec = v.record;
    if (rec.platform && rec.platform !== process.platform) throw new AppError(CODES.UNSUPPORTED, `备份来自 ${rec.platform}，不能在 ${process.platform} 恢复。`);
    const id = `rs-${crypto.randomBytes(6).toString('hex')}`;
    const items = [];
    for (const s of rec.sources) {
      if (only && !only.includes(s.id)) continue;
      if (s.files.length === 0 && isNonEmpty(s.originalPath)) throw new AppError(CODES.INVALID_STATE, `备份中 ${s.id} 没有任何文件，拒绝用空内容覆盖现有 ${s.originalPath}。`);
      items.push({type: 'source', id: s.id, target: s.originalPath, staged: `${s.originalPath}.yz-restore-${id}`, scene: `${s.originalPath}.yz-scene-${id}`, steps: Object.fromEntries(STEPS.map(k => [k, 'pending']))});
    }
    for (const d of rec.databases) {
      if (only && !only.includes(d.id)) continue;
      items.push({type: 'database', id: d.id, target: d.originalPath, staged: `${d.originalPath}.yz-restore-${id}`, scene: `${d.originalPath}.yz-scene-${id}`, steps: Object.fromEntries(STEPS.map(k => [k, 'pending']))});
    }
    if (!items.length) throw new AppError(CODES.INVALID_ARGUMENT, '没有可恢复的项目。');
    const j = {id, backupDir: path.resolve(backupDir), backupId: rec.id, status: 'prepared', createdAt: this.now(), items, prerequisites: rec.prerequisites ?? null, warnings: []};
    if (rec.prerequisites?.basePython && !fs.existsSync(rec.prerequisites.basePython)) j.warnings.push(`外部基础 Python 不存在：${rec.prerequisites.basePython}，venv 恢复后可能无法运行。`);
    this.save(j);
    return j;
  }

  async run(id) { return this.resume(id); }

  async resume(id) {
    const j = this.load(id);
    if (j.status === 'done') return j;
    const rec = JSON.parse(fs.readFileSync(path.join(j.backupDir, 'backup.json'), 'utf8'));
    j.status = 'running'; this.save(j);
    try {
      for (const item of j.items) {
        for (const step of STEPS) {
          if (item.steps[step] === 'done') continue;
          item.steps[step] = 'running'; this.save(j);
          this._j = j; await this[`_${step}`](item, rec, j);
          item.steps[step] = 'done'; this.save(j);
          if (this.hooks.afterStep) await this.hooks.afterStep(item.id, step);
        }
      }
      j.status = 'done'; j.finishedAt = this.now(); this.save(j);
      return j;
    } catch (error) {
      j.status = 'interrupted'; j.lastError = {code: error.code ?? CODES.INTERNAL, message: error.message}; this.save(j);
      throw error;
    }
  }

  /**
   * S06/C04：回退一次未完成的恢复（可重入，每个动作先看现状再做，不依赖一轮 rename 全部成功）：
   * 1. 先把 _carry 从现场搬出的排除内容（模型、input/output 等）按 journal 从 staged 或已切换的新 target 搬回现场；
   *    现场同一路径已有内容（冲突）时停止并提示，不覆盖唯一内容；
   * 2. 再把已切换的目标移为 .yz-failed-<id>，把现场改回目标（数据库含 -wal/-shm）；原目标本不存在时只把新目标移开。
   */
  async rollback(id) {
    const j = this.load(id);
    if (j.status === 'done') throw new AppError(CODES.INVALID_STATE, '恢复已完成，不能回退；可另行恢复到更早的备份。');
    let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(j.backupDir, 'backup.json'), 'utf8')); } catch { /* 备份不可读时只按 journal 记录搬回 */ }
    j.status = 'rolling-back'; this.save(j);
    const freeName = base => { let p = base, n = 1; while (fs.existsSync(p)) p = `${base}-${n++}`; return p; };
    for (const item of [...j.items].reverse()) {
      if (item.rolledBack) continue;
      if (item.type === 'source') {
        const swapped = !fs.existsSync(item.staged) && fs.existsSync(item.scene);
        const rels = [...new Set([...(item.carried ?? []), ...((rec && this._source(item, rec)?.excluded) ?? [])])];
        item.carriedBack = item.carriedBack ?? [];
        for (const rel of rels) {
          if (item.carriedBack.includes(rel)) continue;
          const home = path.join(item.scene, rel);
          const where = [path.join(item.staged, rel), swapped ? path.join(item.target, rel) : null].find(p => p && fs.existsSync(p));
          if (!where) continue; // 从未搬出（仍在现场）或原本不存在
          if (fs.existsSync(home)) {
            j.status = 'interrupted'; j.lastError = {code: CODES.CONFLICT, message: `回退冲突：${home} 与 ${where} 都存在，已停止，两份都保留。`}; this.save(j);
            throw new AppError(CODES.CONFLICT, j.lastError.message, {details: {home, where}});
          }
          fs.mkdirSync(path.dirname(home), {recursive: true}); fs.renameSync(where, home);
          item.carriedBack.push(rel); this.save(j);
        }
      }
      const sufs = item.type === 'database' ? ['', '-wal', '-shm'] : [''];
      const hadScene = sufs.some(suf => fs.existsSync(item.scene + suf));
      for (const suf of sufs) {
        const target = item.target + suf, scene = item.scene + suf;
        if (fs.existsSync(scene)) {
          if (fs.existsSync(target)) fs.renameSync(target, freeName(`${target}.yz-failed-${id}`));
          fs.renameSync(scene, target);
        } else if (!hadScene && item.steps.preserve === 'done' && !(item.preserved ?? []).length && ['running', 'done'].includes(item.steps.swap) && fs.existsSync(target)) {
          fs.renameSync(target, freeName(`${target}.yz-failed-${id}`)); // 原目标本不存在：只移开新切换进来的内容
        }
      }
      if (fs.existsSync(item.staged)) fs.renameSync(item.staged, freeName(`${item.staged}.yz-failed`));
      item.rolledBack = true; this.save(j);
    }
    j.status = 'aborted'; j.rolledBackAt = this.now(); this.save(j);
    return j;
  }

  _source(item, rec) { return item.type === 'source' ? rec.sources.find(s => s.id === item.id) : rec.databases.find(d => d.id === item.id); }

  async _stage(item, rec, j) {
    fs.rmSync(item.staged, {recursive: true, force: true});
    const s = this._source(item, rec);
    if (item.type === 'database') {
      fs.copyFileSync(path.join(j.backupDir, s.file), item.staged);
      if (await sha256File(item.staged) !== s.sha256) throw new AppError(CODES.INTEGRITY, `数据库 ${s.id} staging hash 不符。`);
      return;
    }
    const base = path.join(j.backupDir, 'data', s.id);
    if (!s.isDirectory) { fs.copyFileSync(base, item.staged); return; }
    fs.mkdirSync(item.staged, {recursive: true});
    for (const d of s.dirs) fs.mkdirSync(path.join(item.staged, d), {recursive: true});
    for (const f of s.files) fs.copyFileSync(path.join(base, f.rel), path.join(item.staged, f.rel));
    for (const l of s.symlinks) { fs.mkdirSync(path.dirname(path.join(item.staged, l.rel)), {recursive: true}); fs.symlinkSync(l.target, path.join(item.staged, l.rel)); }
  }

  async _preserve(item) {
    const targets = item.type === 'database' ? [item.target, item.target + '-wal', item.target + '-shm'] : [item.target];
    item.preserved = item.preserved ?? [];
    for (const t of targets) {
      const sc = t === item.target ? item.scene : item.scene + t.slice(item.target.length);
      if (fs.existsSync(t) && !fs.existsSync(sc)) { fs.renameSync(t, sc); item.preserved.push(sc); this.save(this._j); }
    }
  }

  async _carry(item, rec) {
    // 备份时排除的内容（模型、output 等）原样从现场搬回新目录，不复制、不删除。
    if (item.type !== 'source') return;
    const s = this._source(item, rec);
    item.carried = item.carried ?? [];
    for (const rel of s.excluded ?? []) {
      const from = path.join(item.scene, rel), to = path.join(item.staged, rel);
      if (fs.existsSync(from) && !fs.existsSync(to)) { item.carried.push(rel); this.save(this._j); fs.mkdirSync(path.dirname(to), {recursive: true}); fs.renameSync(from, to); } // C04：写前记录每个 carry
    }
  }

  async _swap(item) {
    if (fs.existsSync(item.staged)) {
      if (fs.existsSync(item.target)) throw new AppError(CODES.CONFLICT, `目标仍存在，无法切换：${item.target}`);
      fs.renameSync(item.staged, item.target);
    } else if (!fs.existsSync(item.target)) throw new AppError(CODES.INVALID_STATE, `staging 与目标都不存在：${item.target}`);
  }

  async _verify(item, rec) {
    const s = this._source(item, rec);
    const problems = [];
    if (item.type === 'database' || !s.isDirectory) {
      const expected = s.sha256 ?? s.files[0].sha256;
      if (await sha256File(item.target) !== expected) problems.push(item.target);
    } else {
      for (const f of s.files) { const p = path.join(item.target, f.rel); if (!fs.existsSync(p) || await sha256File(p) !== f.sha256) problems.push(f.rel); }
    }
    if (problems.length) throw new AppError(CODES.INTEGRITY, `恢复后校验失败：${item.id}`, {details: {problems}});
  }
}

module.exports = {RestoreEngine, STEPS};
