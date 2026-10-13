'use strict';
// F05：SQLite 仓库。单写入者、WAL、事务、版本化迁移、一致性备份（VACUUM INTO）、
// 损坏时只读恢复入口。驱动优先 better-sqlite3（打包时按 Electron ABI 重建），
// 若原生模块 ABI 不匹配（例如开发时未重建），回退到 Node/Electron 内置 node:sqlite。
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../core/errors.cjs');

function loadDriver(preferred) {
  const errors = [];
  const order = preferred ? [preferred] : ['better-sqlite3', 'node:sqlite'];
  for (const name of order) {
    try {
      if (name === 'better-sqlite3') {
        const Database = require('better-sqlite3');
        return {name, open: (file, {readonly}) => new Database(file, {readonly, fileMustExist: readonly})};
      }
      if (name === 'node:sqlite') {
        const {DatabaseSync} = require('node:sqlite');
        return {name, open: (file, {readonly}) => new DatabaseSync(file, {readOnly: !!readonly})};
      }
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  throw new AppError(CODES.UNSUPPORTED, `没有可用的 SQLite 驱动：${errors.join('；')}`);
}

/** 迁移列表：按顺序执行，每项一个事务。只追加，不修改已发布的迁移。 */
const MIGRATIONS = [
  {version: 1, name: 'core-records', sql: `
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, workflow_id TEXT NOT NULL,
      snapshot_ref TEXT NOT NULL, snapshot_hash TEXT, input_revision INTEGER NOT NULL DEFAULT 0,
      request_id TEXT NOT NULL UNIQUE, comfy_prompt_id TEXT, client_id TEXT NOT NULL, group_id TEXT, retry_of TEXT,
      seq INTEGER NOT NULL, outputs TEXT NOT NULL DEFAULT '[]', error TEXT, progress TEXT, external INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT, finished_at TEXT);
    CREATE INDEX tasks_state ON tasks(state, seq);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, reason TEXT, data TEXT, at TEXT NOT NULL);
    CREATE INDEX task_events_task ON task_events(task_id, id);
    CREATE TABLE assets (
      id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, root_id TEXT, kind TEXT NOT NULL, format TEXT NOT NULL,
      file_size INTEGER NOT NULL, mtime REAL NOT NULL, content_hash TEXT, source TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
      missing INTEGER NOT NULL DEFAULT 0, task_id TEXT, indexed_at TEXT NOT NULL);
    CREATE INDEX assets_mtime ON assets(mtime DESC);
    CREATE TABLE favorites (id TEXT PRIMARY KEY, asset_id TEXT, source_path TEXT NOT NULL, stored_path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL UNIQUE, width INTEGER, height INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE resources (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, architecture TEXT, format TEXT NOT NULL, quantization TEXT, path TEXT NOT NULL UNIQUE,
      real_path TEXT, source TEXT NOT NULL, version TEXT, capabilities TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '{}',
      file_size INTEGER, mtime REAL, content_hash TEXT, missing INTEGER NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL);
    CREATE TABLE downloads (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, file_id TEXT NOT NULL, url_ref TEXT NOT NULL, destination TEXT NOT NULL, temp_path TEXT NOT NULL,
      etag TEXT, last_modified TEXT, expected_hash TEXT, hash_kind TEXT, total_bytes INTEGER, received_bytes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, error TEXT, verification TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE env_transactions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, before_manifest TEXT, backup_ref TEXT, target_manifest TEXT, phase TEXT NOT NULL, owned_service_states TEXT NOT NULL DEFAULT '{}', journal TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', favorite INTEGER NOT NULL DEFAULT 0, current_version TEXT, source TEXT NOT NULL, thumbnail TEXT, license TEXT, author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE template_versions (version_id TEXT PRIMARY KEY, template_id TEXT NOT NULL, parent_id TEXT, graph_ref TEXT NOT NULL, graph_hash TEXT NOT NULL, form_schema_ref TEXT, source TEXT NOT NULL, note TEXT, saved_at TEXT NOT NULL);
    CREATE INDEX template_versions_t ON template_versions(template_id, saved_at);
  `},
];

class Database {
  constructor(file, {driver, readonly = false, now = () => new Date().toISOString()} = {}) {
    this.file = file; this.now = now; this.readonly = readonly;
    this.driver = loadDriver(driver);
    if (!readonly) fs.mkdirSync(path.dirname(file), {recursive: true});
    this.db = this.driver.open(file, {readonly});
    if (!readonly) { this.db.exec('PRAGMA journal_mode = WAL'); this.db.exec('PRAGMA foreign_keys = ON'); this.db.exec('PRAGMA busy_timeout = 3000'); }
    this.depth = 0;
  }
  static open(file, options = {}) {
    // 损坏检测：打开或 quick_check 失败时以只读方式返回，并标记 corrupt。
    let db;
    try {
      db = new Database(file, options);
      const check = db.get('PRAGMA quick_check');
      const value = check && Object.values(check)[0];
      if (value !== 'ok') throw new Error(`quick_check: ${value}`);
      if (!options.readonly) db.migrate();
      return db;
    } catch (error) {
      try { db?.close(); } catch { /* 忽略 */ }
      if (options.readonly) throw error;
      const reason = error.message;
      let ro = null;
      try { ro = new Database(file, {...options, readonly: true}); } catch { /* 连只读都打不开 */ }
      if (ro) { ro.corrupt = reason; return ro; }
      throw new AppError(CODES.CORRUPT_DATA, `数据库无法打开：${reason}`, {details: {file}});
    }
  }
  exec(sql) { this._assertWritable(sql); this.db.exec(sql); }
  run(sql, ...params) { this._assertWritable(sql); return this.db.prepare(sql).run(...params.map(norm)); }
  get(sql, ...params) { const r = this.db.prepare(sql).get(...params.map(norm)); return r ? {...r} : undefined; }
  all(sql, ...params) { return this.db.prepare(sql).all(...params.map(norm)).map(r => ({...r})); }
  _assertWritable(sql) { if (this.readonly && !/^\s*(select|pragma)/i.test(sql)) throw new AppError(CODES.READ_ONLY, '数据库处于只读恢复模式，未写入。'); }
  /** 同步事务；嵌套时使用 SAVEPOINT。 */
  transaction(fn) {
    const name = `sp${this.depth}`;
    if (this.depth === 0) this.exec('BEGIN IMMEDIATE'); else this.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn(this);
      if (result && typeof result.then === 'function') throw new Error('事务函数必须是同步函数。');
      this.depth--;
      if (this.depth === 0) this.exec('COMMIT'); else this.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.depth--;
      if (this.depth === 0) this.exec('ROLLBACK'); else { this.exec(`ROLLBACK TO ${name}`); this.exec(`RELEASE ${name}`); }
      throw error;
    }
  }
  get schemaVersion() { return this.get('PRAGMA user_version').user_version; }
  migrate(migrations = MIGRATIONS) {
    const current = this.schemaVersion;
    const latest = migrations.at(-1)?.version ?? 0;
    if (current > latest) throw new AppError(CODES.UNSUPPORTED, `数据库来自更新版本（v${current}），已拒绝写入。`);
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.transaction(() => { this.db.exec(m.sql); this.db.exec(`PRAGMA user_version = ${m.version}`); });
    }
    return {from: current, to: this.schemaVersion};
  }
  /** 一致性备份：VACUUM INTO 生成独立数据库文件，而不是复制活动 .db/-wal。 */
  backupTo(target) {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    if (fs.existsSync(target)) throw new AppError(CODES.CONFLICT, '备份目标已存在。');
    this.db.prepare('VACUUM INTO ?').run(target);
    return target;
  }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }
}
const norm = v => typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v;
module.exports = {Database, MIGRATIONS, loadDriver};
