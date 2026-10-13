'use strict';
// U02：可恢复备份。实际复制文件（含未提交修改）、逐文件 sha256、manifest、SQLite 一致性备份（VACUUM INTO）。
// 排除模型权重；记录原绝对路径、依赖清单与外部前置条件。备份完成后才写 COMPLETE 标记，未完成的备份不可用于恢复。
const fs = require('node:fs');
const path = require('node:path');
const {sha256File, writeJsonAtomic} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');
const {WEIGHT_EXTENSIONS} = require('./env-manifest.cjs');

const BACKUP_VERSION = 1;
const DEFAULT_EXCLUDE_DIRS = new Set(['__pycache__', 'models', 'output', 'input', 'temp']);

function shouldExclude(rel, name, isDir, {excludeDirs, excludeExt}) {
  if (isDir) return excludeDirs.has(name);
  return excludeExt.includes(path.extname(name).toLowerCase());
}

/** 遍历目录，不跟随符号链接（记录链接目标）。 */
function walk(root, opts, out = [], rel = '') {
  for (const d of fs.readdirSync(path.join(root, rel), {withFileTypes: true})) {
    const r = rel ? path.join(rel, d.name) : d.name;
    if (d.isSymbolicLink()) { out.push({rel: r, type: 'symlink', target: fs.readlinkSync(path.join(root, r))}); continue; }
    if (shouldExclude(r, d.name, d.isDirectory(), opts)) { out.push({rel: r, type: 'excluded', dir: d.isDirectory()}); continue; }
    if (d.isDirectory()) { out.push({rel: r, type: 'dir'}); walk(root, opts, out, r); }
    else if (d.isFile()) out.push({rel: r, type: 'file'});
  }
  return out;
}

/** SQLite 一致性备份：用 VACUUM INTO 生成单文件快照（包含 WAL 中已提交内容），再 integrity_check。 */
function backupSqlite(src, dest, {driver} = {}) {
  const {loadDriver} = require('../repositories/database.cjs');
  const drv = loadDriver(driver);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  if (fs.existsSync(dest)) fs.rmSync(dest);
  const db = drv.open(src, {readonly: false});
  try { db.exec('PRAGMA busy_timeout = 5000'); db.prepare('VACUUM INTO ?').run(dest); } finally { db.close(); }
  const check = drv.open(dest, {readonly: true});
  try {
    const row = check.prepare('PRAGMA integrity_check').get();
    const v = row && Object.values(row)[0];
    if (v !== 'ok') throw new AppError(CODES.INTEGRITY, `SQLite 备份校验失败：${v}`);
  } finally { check.close(); }
}

/**
 * @param {object} o
 * @param {string} o.backupRoot     备份存放目录（每次备份建子目录）
 * @param {object} o.manifest       U01 环境清单
 * @param {{id:string,path:string,kind?:string}[]} o.sources  要备份的目录或文件（原绝对路径）
 * @param {{id:string,path:string}[]} [o.databases] SQLite 数据库
 */
async function createBackup({backupRoot, manifest, sources = [], databases = [], id, excludeDirs = DEFAULT_EXCLUDE_DIRS, excludeExt = WEIGHT_EXTENSIONS, driver, token, now = () => new Date().toISOString()}) {
  if (!sources.length && !databases.length) throw new AppError(CODES.INVALID_ARGUMENT, '备份内容为空。');
  const backupId = id ?? `bk-${now().replace(/[:.]/g, '-')}`;
  const dir = path.join(backupRoot, backupId);
  if (fs.existsSync(dir)) throw new AppError(CODES.CONFLICT, `备份目录已存在：${backupId}`);
  const staging = dir + '.partial';
  fs.rmSync(staging, {recursive: true, force: true});
  fs.mkdirSync(path.join(staging, 'data'), {recursive: true});
  const record = {backupVersion: BACKUP_VERSION, id: backupId, createdAt: now(), platform: process.platform, environment: manifest ?? null, sources: [], databases: [], excluded: {dirs: [...excludeDirs], extensions: excludeExt}};
  const seen = new Set();
  for (const s of sources) {
    if (!s.id || seen.has(s.id) || !/^[\w.-]+$/.test(s.id)) throw new AppError(CODES.INVALID_ARGUMENT, `来源 id 无效或重复：${s.id}`);
    seen.add(s.id);
    const abs = path.resolve(s.path);
    if (!fs.existsSync(abs)) throw new AppError(CODES.NOT_FOUND, `备份来源不存在：${abs}`);
    const st = fs.statSync(abs);
    const destBase = path.join(staging, 'data', s.id);
    const entry = {id: s.id, kind: s.kind ?? 'dir', originalPath: abs, isDirectory: st.isDirectory(), files: [], dirs: [], symlinks: [], excluded: [], bytes: 0};
    if (st.isDirectory()) {
      fs.mkdirSync(destBase, {recursive: true});
      for (const e of walk(abs, {excludeDirs, excludeExt})) {
        if (token?.cancelled) throw new AppError(CODES.CANCELLED, token.reason ?? '已取消');
        if (e.type === 'dir') { entry.dirs.push(e.rel); fs.mkdirSync(path.join(destBase, e.rel), {recursive: true}); }
        else if (e.type === 'symlink') entry.symlinks.push({rel: e.rel, target: e.target});
        else if (e.type === 'excluded') entry.excluded.push(e.rel);
        else {
          const src = path.join(abs, e.rel), dst = path.join(destBase, e.rel);
          fs.copyFileSync(src, dst);
          const sha = await sha256File(dst), size = fs.statSync(dst).size;
          entry.files.push({rel: e.rel, size, sha256: sha}); entry.bytes += size;
        }
      }
    } else {
      fs.copyFileSync(abs, destBase);
      const size = fs.statSync(destBase).size;
      entry.files.push({rel: '', size, sha256: await sha256File(destBase)}); entry.bytes = size;
    }
    record.sources.push(entry);
  }
  for (const d of databases) {
    if (!d.id || seen.has(d.id) || !/^[\w.-]+$/.test(d.id)) throw new AppError(CODES.INVALID_ARGUMENT, `数据库 id 无效或重复：${d.id}`);
    seen.add(d.id);
    const dst = path.join(staging, 'db', d.id + '.sqlite');
    backupSqlite(path.resolve(d.path), dst, {driver});
    record.databases.push({id: d.id, originalPath: path.resolve(d.path), file: path.relative(staging, dst), size: fs.statSync(dst).size, sha256: await sha256File(dst), method: 'VACUUM INTO'});
  }
  record.prerequisites = {
    basePython: manifest?.external?.basePython ?? null,
    modelDirs: manifest?.external?.modelDirs ?? [],
    pythonPackages: manifest?.python?.packages ?? null,
    note: '恢复只能回到 originalPath；venv 依赖外部基础 Python。',
  };
  writeJsonAtomic(path.join(staging, 'backup.json'), record);
  fs.writeFileSync(path.join(staging, 'COMPLETE'), record.createdAt);
  fs.renameSync(staging, dir);
  return {dir, record};
}

function readBackup(dir) {
  if (!fs.existsSync(path.join(dir, 'COMPLETE'))) throw new AppError(CODES.INTEGRITY, '备份不完整（缺少 COMPLETE 标记），不能用于恢复。');
  return JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8'));
}

/** 重新计算全部文件 hash；返回问题列表。 */
async function verifyBackup(dir) {
  const record = readBackup(dir);
  const problems = [];
  for (const s of record.sources) {
    for (const f of s.files) {
      const p = f.rel ? path.join(dir, 'data', s.id, f.rel) : path.join(dir, 'data', s.id);
      if (!fs.existsSync(p)) problems.push({source: s.id, rel: f.rel, problem: 'missing'});
      else if (await sha256File(p) !== f.sha256) problems.push({source: s.id, rel: f.rel, problem: 'hash'});
    }
  }
  for (const d of record.databases) {
    const p = path.join(dir, d.file);
    if (!fs.existsSync(p) || await sha256File(p) !== d.sha256) problems.push({database: d.id, problem: 'hash'});
  }
  return {ok: problems.length === 0, problems, record};
}

module.exports = {createBackup, readBackup, verifyBackup, backupSqlite, walk, BACKUP_VERSION, DEFAULT_EXCLUDE_DIRS};
