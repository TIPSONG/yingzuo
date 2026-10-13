'use strict';
// F04：数据根选择（安装版 userData / 便携版 data/ / 开发 .local/data）与旧 .local 一次性导入。
const fs = require('node:fs');
const path = require('node:path');
const {writeJsonAtomic, sha256} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');
const SUBDIRS = ['drafts', 'closed-workflows', 'templates', 'task-snapshots', 'references', 'favorites', 'thumbnails', 'downloads', 'logs', 'backups', 'migrations', 'trash'];

/**
 * 便携模式：可执行文件目录存在 `portable.flag`（或 electron-builder 便携包提供的
 * PORTABLE_EXECUTABLE_DIR 目录中存在该标记）时，使用其中可写的 data/。
 */
function resolveDataRoot({isPackaged, exePath, userData, devRoot, env = process.env}) {
  if (env.YINGZUO_DATA_ROOT) return {mode: 'override', root: path.resolve(env.YINGZUO_DATA_ROOT)};
  if (!isPackaged) return {mode: 'development', root: path.join(devRoot, '.local', 'data')};
  const candidates = [env.PORTABLE_EXECUTABLE_DIR, exePath && path.dirname(exePath)].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'portable.flag'))) {
      const root = path.join(dir, 'data');
      try { fs.mkdirSync(root, {recursive: true}); fs.accessSync(root, fs.constants.W_OK); }
      catch (error) { throw new AppError(CODES.FORBIDDEN, `便携数据目录不可写：${root}（${error.message}）。请把映作放到可写目录。`); }
      return {mode: 'portable', root};
    }
  }
  return {mode: 'installed', root: path.join(userData, 'data')};
}
/** RV05：只描述路径，不创建任何目录（恢复前使用，避免重建正在恢复的目标）。 */
function describeLayout(root) {
  return Object.fromEntries([['root', root], ...SUBDIRS.map(d => [d, path.join(root, d)]), ['config', path.join(root, 'config.json')], ['workspace', path.join(root, 'workspace.json')], ['database', path.join(root, 'yingzuo.sqlite')]]);
}
function ensureLayout(root) {
  fs.mkdirSync(root, {recursive: true});
  for (const d of SUBDIRS) fs.mkdirSync(path.join(root, d), {recursive: true});
  return describeLayout(root);
}

/**
 * 旧开发数据导入。规则：只复制不删除源；有标记则不重复导入；目标已有同名文件先备份；
 * 任一步失败则按 journal 回滚本次新建文件并恢复备份。
 * convertWorkspace(rawJson) 把旧工作区转换为当前写入函数可接受的内存结构，并负责写入。
 */
function importLegacy({legacyDir, layout, writeWorkspace, readLegacyWorkspace, now = () => new Date().toISOString()}) {
  const marker = path.join(layout.migrations, 'legacy-local-import.json');
  if (fs.existsSync(marker)) return {status: 'already-imported', marker: JSON.parse(fs.readFileSync(marker, 'utf8'))};
  const sources = {workspace: path.join(legacyDir, 'desktop-workspace.json'), closed: path.join(legacyDir, 'closed-workflows'), config: path.join(legacyDir, '..', 'desktop', 'config.local.json')};
  const present = {workspace: fs.existsSync(sources.workspace), closed: fs.existsSync(sources.closed)};
  if (!present.workspace && !present.closed) return {status: 'nothing-to-import'};
  const stamp = now().replace(/[:.]/g, '-');
  const backupDir = path.join(layout.backups, `pre-legacy-import-${stamp}`);
  const journal = [];
  const created = [];
  try {
    // 1. 备份目标已有文件
    if (fs.existsSync(layout.workspace)) {
      fs.mkdirSync(backupDir, {recursive: true});
      fs.copyFileSync(layout.workspace, path.join(backupDir, 'workspace.json'));
      if (fs.existsSync(layout.drafts)) fs.cpSync(layout.drafts, path.join(backupDir, 'drafts'), {recursive: true});
      journal.push({step: 'backup', path: backupDir});
    }
    // 2. 工作区
    let workspaceInfo = null;
    if (present.workspace) {
      const legacy = readLegacyWorkspace(sources.workspace);
      writeWorkspace(layout.workspace, legacy);
      workspaceInfo = {tabs: legacy.tabs.length, sourceHash: sha256(fs.readFileSync(sources.workspace))};
      journal.push({step: 'workspace', tabs: legacy.tabs.length});
    }
    // 3. 关闭恢复副本：只复制目标不存在的文件
    let copied = 0;
    if (present.closed) for (const name of fs.readdirSync(sources.closed)) {
      if (!name.endsWith('.json')) continue;
      const target = path.join(layout['closed-workflows'], name);
      if (fs.existsSync(target)) continue;
      fs.copyFileSync(sources.closed + path.sep + name, target, fs.constants.COPYFILE_EXCL); created.push(target); copied++;
    }
    journal.push({step: 'closed-workflows', copied});
    const record = {version: 1, importedAt: now(), legacyDir, workspace: workspaceInfo, closedCopied: copied, backup: journal.some(j => j.step === 'backup') ? backupDir : null, sourceKept: true};
    writeJsonAtomic(marker, record);
    return {status: 'imported', marker: record};
  } catch (error) {
    // 回滚：删除本次新建的副本，恢复备份的工作区与草稿
    for (const file of created) { try { fs.rmSync(file, {force: true}); } catch { /* 尽力 */ } }
    if (fs.existsSync(path.join(backupDir, 'workspace.json'))) {
      fs.copyFileSync(path.join(backupDir, 'workspace.json'), layout.workspace);
      if (fs.existsSync(path.join(backupDir, 'drafts'))) { fs.rmSync(layout.drafts, {recursive: true, force: true}); fs.cpSync(path.join(backupDir, 'drafts'), layout.drafts, {recursive: true}); }
    } else if (journal.some(j => j.step === 'workspace')) fs.rmSync(layout.workspace, {force: true});
    throw new AppError(CODES.MIGRATION_FAILED, `旧数据导入失败，已恢复导入前状态，源文件未改动：${error.message}`, {details: {legacyDir}});
  }
}
module.exports = {describeLayout, resolveDataRoot, ensureLayout, importLegacy, SUBDIRS};
