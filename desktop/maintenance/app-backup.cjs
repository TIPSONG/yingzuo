'use strict';
// R13：应用数据备份（与 ComfyUI 环境备份分开）。范围：SQLite（VACUUM INTO，含 WAL 已提交内容）、工作区与草稿、
// 模板与表单、任务快照、参考图、收藏、配置。凭据（credentials.json）不进入备份；模型属外部资源不进入。
// 恢复不在运行中进行：先登记，下次启动时在打开数据库之前执行；当前数据整体保留为“失败现场”，不删除。
const fs = require('node:fs');
const path = require('node:path');
const {createBackup, readBackup, verifyBackup} = require('./backup.cjs');
const {RestoreEngine} = require('./restore.cjs');
const {AppError, CODES} = require('../core/errors.cjs');

const DIRS = ['drafts', 'closed-workflows', 'templates', 'task-snapshots', 'references', 'favorites'];
const FILES = [['workspace', 'workspace.json'], ['config', 'config.json']];
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
async function createAppBackup({layout, driver, now} = {}) {
  const sources = sourcesOf(layout);
  const databases = fs.existsSync(layout.database) ? [{id: 'app-db', path: layout.database}] : [];
  // 应用数据不按扩展名/目录名排除（参考图、收藏都是用户数据）
  return createBackup({backupRoot: appBackupRoot(layout), sources, databases, excludeDirs: new Set(), excludeExt: [], driver, ...(now ? {now} : {}), manifest: {scope: 'app-data', excludes: ['credentials.json（系统加密，单独保存）', '模型（外部资源）']}});
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
/** 启动早期调用（打开数据库之前）。返回 null 或结果；失败不重复尝试（标记改名为 .failed）。 */
async function applyPendingAppRestore(layout) {
  const f = pendingFile(layout); if (!fs.existsSync(f)) return null;
  const {dir} = JSON.parse(fs.readFileSync(f, 'utf8'));
  const engine = new RestoreEngine({journalDir: path.join(layout.migrations, 'app-restore')});
  try {
    const j = await engine.prepare(dir);
    const r = await engine.run(j.id);
    fs.rmSync(f, {force: true});
    return {status: 'restored', dir, restoreId: j.id, result: r};
  } catch (e) {
    fs.renameSync(f, `${f}.failed-${Date.now()}`);
    return {status: 'failed', dir, error: e.message};
  }
}
module.exports = {createAppBackup, listAppBackups, scheduleAppRestore, applyPendingAppRestore, sourcesOf, appBackupRoot};
