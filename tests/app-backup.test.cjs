'use strict';
// R13：应用数据备份与“下次启动前恢复”（只在临时目录中）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {Database} = require('../desktop/repositories/database.cjs');
const A = require('../desktop/maintenance/app-backup.cjs');

test('应用数据备份包含数据库/工作区/模板/快照/参考图，不含凭据；下次启动前恢复并保留现场', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ab-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const layout = ensureLayout(d);
  const db = Database.open(layout.database); db.exec('CREATE TABLE IF NOT EXISTS t(x TEXT)'); db.run('INSERT INTO t VALUES (?)', 'v1');
  fs.writeFileSync(layout.workspace, '{"v":1}'); fs.writeFileSync(path.join(layout.templates, 'a.json'), 'tpl');
  fs.writeFileSync(path.join(layout.references, 'r.bin'), 'img'); fs.writeFileSync(path.join(d, 'credentials.json'), '{"secret":"fictional"}');
  const {dir, record} = await A.createAppBackup({layout});
  assert.ok(record.databases.some(x => x.id === 'app-db'));
  assert.deepEqual(record.sources.map(s => s.id).sort(), ['closed-workflows', 'drafts', 'favorites', 'references', 'task-snapshots', 'templates', 'workspace'].sort());
  assert.ok(record.sources.find(s => s.id === 'references').files.some(f => f.rel === 'r.bin'), '.bin 用户数据不被当作权重排除');
  assert.ok(!JSON.stringify(record).includes('credentials.json"'));
  assert.ok(!A.sourcesOf(layout).some(s => dir.startsWith(path.resolve(s.path) + path.sep)), '备份根不在来源内');
  assert.equal(A.listAppBackups(layout).length, 1);
  // 修改后登记恢复；运行中不执行
  db.run('INSERT INTO t VALUES (?)', 'v2'); fs.writeFileSync(layout.workspace, '{"v":2}'); db.close();
  await assert.rejects(A.scheduleAppRestore(layout, os.tmpdir()), /只能恢复/);
  await A.scheduleAppRestore(layout, dir);
  assert.equal(fs.readFileSync(layout.workspace, 'utf8'), '{"v":2}', '登记时不改动数据');
  const r = await A.applyPendingAppRestore(layout);
  assert.equal(r.status, 'restored', r.error);
  assert.equal(fs.readFileSync(layout.workspace, 'utf8'), '{"v":1}');
  const db2 = Database.open(layout.database);
  try { assert.deepEqual(db2.all('SELECT x FROM t').map(x => x.x), ['v1']); } finally { db2.close(); } // Windows：先关库再删目录
  assert.ok(fs.readdirSync(d).some(n => n.startsWith('workspace.json.yz-scene-')), '失败现场保留');
  assert.equal(await A.applyPendingAppRestore(layout), null, '只执行一次');
});
