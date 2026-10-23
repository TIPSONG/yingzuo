'use strict';
// R13：应用数据备份（与 ComfyUI 环境备份分开）。范围：SQLite（VACUUM INTO，含 WAL 已提交内容）、工作区与草稿、
// 模板与表单、任务快照、参考图、收藏、配置。凭据（credentials.json）不进入备份；模型属外部资源不进入。
// 恢复不在运行中进行：先登记，下次启动时在打开数据库之前执行；当前数据整体保留为“失败现场”，不删除。
const fs = require('node:fs');
const path = require('node:path');
const {createBackup, readBackup, verifyBackup} = require('./backup.cjs');
const {RestoreEngine} = require('./restore.cjs');
const {AppError, CODES} = require('../core/errors.cjs');

const DIRS = ['drafts', 'closed-workflows', 'templates', 'task-snapshots', 'task-submissions', 'references', 'favorites'];
const FILES = [['workspace', 'workspace.json'], ['config', 'config.json'], ['reference-relations', 'reference-relations.json'], ['maintenance-holds', 'maintenance-holds.json']];
const appBackupRoot = layout => path.join(layout.backups, 'app');
const pendingFile = layout => path.join(layout.root, 'pending-app-restore.json');

/** 备份根不能落在被备份目录内（去重嵌套）。 */
function sourcesOf(layout) {
  const root = path.resolve(appBackupRoot(layout));
  const out = [];
  for (const d of DIRS) { const p = path.join(layout.root, d); if (fs.existsSync(p) && !root.startsWith(path.resolve(p) + path.sep)) out.push({id: d, path: p, kind: 'app-data'}); }
  for (const [id, f] of FILES) { const p = path.join(layout.root, f); if (fs.existsSync(p)) out.push({id, path: p, kind: 'app-data'}); }
  return out;
}
/**
 * S06：一致性。先在同一时刻用 VACUUM INTO 固定数据库（databasesFirst），再复制内容寻址、只增不改的文件目录；
 * 复制完成后用备份内的数据库核对引用闭包（任务快照、模板图/表单、关系文件里的素材），任何缺失都使备份失败。
 * barrier：调用方提供的短暂写入屏障（暂停提交、编辑器串行队列），在固定数据库与复制工作区/配置期间持有。
 */
async function createAppBackup({layout, driver, now, hashImpl, barrier = async f => f()} = {}) {
  return barrier(async () => {
    const sources = sourcesOf(layout);
    const databases = fs.existsSync(layout.database) ? [{id: 'app-db', path: layout.database}] : [];
    return createBackup({backupRoot: appBackupRoot(layout), sources, databases, databasesFirst: true, excludeDirs: new Set(), excludeExt: [], driver, ...(hashImpl ? {hashImpl} : {}), ...(now ? {now} : {}),
      manifest: {scope: 'app-data', excludes: ['credentials.json（系统加密，单独保存；模板/任务中的敏感输入在新机器上需重新填写）', '模型（外部资源）']},
      postCheck: (staging, record) => checkClosure(staging, record, {driver, liveRefs: path.join(layout.root, 'references')})});
  });
}
/** 备份内引用闭包核对：返回缺失清单；非空时抛错。 */
function checkClosure(staging, record, {driver, liveRefs = null} = {}) {
  const missing = [];
  const has = (src, rel) => fs.existsSync(path.join(staging, 'data', src, ...rel.split('/')));
  const db = record.databases.find(d => d.id === 'app-db');
  if (db) {
    const {loadDriver} = require('../repositories/database.cjs');
    const h = loadDriver(driver).open(path.join(staging, db.file), {readonly: true});
    try {
      const tables = new Set(h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      if (tables.has('tasks')) for (const r of h.prepare('SELECT DISTINCT snapshot_ref FROM tasks').all()) { const rel = String(r.snapshot_ref).replace(/^task-snapshots\//, ''); if (!has('task-snapshots', rel)) missing.push(`任务快照 ${r.snapshot_ref}`); }
      if (tables.has('template_versions')) for (const r of h.prepare('SELECT graph_ref, form_schema_ref FROM template_versions').all()) {
        if (!has('templates', r.graph_ref)) missing.push(`模板图 ${r.graph_ref}`);
        if (r.form_schema_ref && !has('templates', r.form_schema_ref.split('#')[0])) missing.push(`模板表单 ${r.form_schema_ref}`);
      }
    } finally { h.close(); }
  }
  const rel = record.sources.find(x => x.id === 'reference-relations');
  if (rel) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(staging, 'data', 'reference-relations'), 'utf8'));
      for (const tab of Object.values(data.tabs ?? {})) for (const r of tab?.items ?? []) {
        if (typeof r?.refId !== 'string' || !/^[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/i.test(r.refId)) continue;
        const relPath = `${r.refId.slice(0, 2)}/${r.refId}`;
        // 原本就已丢失的素材不算备份缺口（界面已提示）；本机存在而包内没有才是不一致
        if (!has('references', relPath) && liveRefs && fs.existsSync(path.join(liveRefs, ...relPath.split('/')))) missing.push(`参考图 ${r.refId}`);
      }
    } catch (e) { missing.push(`参考关系文件不可读：${e.message}`); }
  }
  if (missing.length) throw new AppError(CODES.INTEGRITY, `应用数据备份引用不完整：${missing.slice(0, 3).join('；')}${missing.length > 3 ? ` 等 ${missing.length} 项` : ''}`, {details: {missing}});
}
function listAppBackups(layout) {
  const root = appBackupRoot(layout); if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(n => !n.endsWith('.partial')).map(n => path.join(root, n)).filter(d => fs.existsSync(path.join(d, 'COMPLETE')))
    .map(d => { const r = readBackup(d); return {dir: d, id: r.id, createdAt: r.createdAt, sources: r.sources.map(s => s.id), databases: r.databases.map(x => x.id), bytes: r.sources.reduce((n, s) => n + s.bytes, 0) + r.databases.reduce((n, x) => n + x.size, 0)}; })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** 登记恢复：校验完整后写待执行标记；实际恢复在下次启动、数据库打开之前。 */
async function scheduleAppRestore(layout, dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(appBackupRoot(layout)) + path.sep)) throw new AppError(CODES.INVALID_ARGUMENT, '只能恢复本应用的应用数据备份。');
  const v = await verifyBackup(resolved);
  const problems = Array.isArray(v) ? v : v?.problems ?? [];
  if (problems.length) throw new AppError(CODES.INTEGRITY, `备份校验失败：${problems.slice(0, 3).join('；')}`);
  fs.writeFileSync(pendingFile(layout), JSON.stringify({dir: resolved, scheduledAt: new Date().toISOString()}));
  return {scheduled: true, dir: resolved, note: '退出并重新打开映作后执行；当前数据会保留为失败现场。'};
}
/**
 * 启动早期调用（打开数据库之前）。pending.action：restore（首次）/ resume（继续同一 journal）/ rollback（回退同一 journal）。
 * S06：失败时不再改名丢弃，而是保留 pending（action=null、记录 journalId 与错误），应用以恢复模式启动：
 * 暂停提交、阻断维护与服务启动，直到用户选择继续或回退并重启。
 */
async function applyPendingAppRestore(layout, {hooks} = {}) {
  const f = pendingFile(layout); if (!fs.existsSync(f)) return null;
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  const action = p.action === undefined ? 'restore' : p.action;
  if (!action) return {status: 'failed', recovery: true, dir: p.dir, journalId: p.journalId ?? null, error: p.error ?? null};
  const engine = new RestoreEngine({journalDir: path.join(layout.migrations, 'app-restore'), hooks});
  let journalId = p.journalId ?? null;
  try {
    if (action === 'rollback') { if (!journalId) throw new AppError(CODES.INVALID_STATE, '没有可回退的恢复记录。'); await engine.rollback(journalId); fs.rmSync(f, {force: true}); return {status: 'rolled-back', dir: p.dir, journalId}; }
    if (action === 'resume' && journalId) { const r = await engine.resume(journalId); fs.rmSync(f, {force: true}); return {status: 'restored', dir: p.dir, restoreId: journalId, result: r}; }
    const j = await engine.prepare(p.dir); journalId = j.id;
    fs.writeFileSync(f, JSON.stringify({...p, action: 'resume', journalId})); // 中途断电：下次继续同一 journal
    const r = await engine.run(j.id);
    fs.rmSync(f, {force: true});
    return {status: 'restored', dir: p.dir, restoreId: j.id, result: r};
  } catch (e) {
    fs.writeFileSync(f, JSON.stringify({...p, action: null, journalId, error: e.message, failedAt: new Date().toISOString()}));
    return {status: 'failed', recovery: true, dir: p.dir, journalId, error: e.message};
  }
}
/** 读取恢复模式状态（main 启动时与界面使用）。 */
function appRecoveryState(layout) {
  const f = pendingFile(layout); if (!fs.existsSync(f)) return null;
  try { const p = JSON.parse(fs.readFileSync(f, 'utf8')); return p.action === null ? {dir: p.dir, journalId: p.journalId ?? null, error: p.error ?? null, failedAt: p.failedAt ?? null} : null; } catch { return {dir: null, journalId: null, error: '恢复标记损坏'}; }
}
/** 用户选择：下次启动继续（resume）或回退（rollback）同一 journal。 */
function chooseAppRecovery(layout, action) {
  if (!['resume', 'rollback'].includes(action)) throw new AppError(CODES.INVALID_ARGUMENT, '只能选择继续或回退。');
  const f = pendingFile(layout); if (!fs.existsSync(f)) throw new AppError(CODES.NOT_FOUND, '没有未完成的应用数据恢复。');
  let p; try { p = JSON.parse(fs.readFileSync(f, 'utf8')); if (!p || typeof p !== 'object') throw new Error('格式无效'); }
  catch { // C04：标记损坏时从未完成的 journal 重建，不能当成没有恢复
    const open = new RestoreEngine({journalDir: path.join(layout.migrations, 'app-restore')}).pending().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    p = open ? {dir: open.backupDir, journalId: open.id, rebuilt: true} : {dir: null, journalId: null, rebuilt: true};
  }
  if (action === 'rollback' && !p.journalId) { fs.rmSync(f, {force: true}); return {action, note: '恢复尚未改动任何数据，已取消登记。'}; }
  fs.writeFileSync(f, JSON.stringify({...p, action}));
  return {action, note: '请退出并重新打开映作以执行。'};
}
module.exports = {createAppBackup, checkClosure, appRecoveryState, chooseAppRecovery, listAppBackups, scheduleAppRestore, applyPendingAppRestore, sourcesOf, appBackupRoot};
