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

test('S06：引用闭包——数据库引用的任务快照不在包内时备份失败；数据库先固定，之后新建的文件不破坏一致性', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ab2-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const layout = ensureLayout(d);
  const db = Database.open(layout.database);
  try {
    const {TaskRepository, SnapshotStore} = require('../desktop/repositories/task-repo.cjs');
    const tasks = new TaskRepository(db, new SnapshotStore(layout.taskSnapshots ?? path.join(d, 'task-snapshots')));
    const a = tasks.create({workflowId: 'w', snapshot: {apiPrompt: {1: {class_type: 'X', inputs: {}}}}, clientId: 'c'});
    // 备份过程中（数据库已固定后）又建了任务：快照文件可能进包，也可能不进，但包内数据库不引用它
    let hooked = false;
    const r = await A.createAppBackup({layout, barrier: async f => f(), hashImpl: async p => { if (!hooked) { hooked = true; tasks.create({workflowId: 'w', snapshot: {apiPrompt: {2: {class_type: 'Y', inputs: {}}}}, clientId: 'c'}); } return require('../desktop/core/fs-atomic.cjs').sha256File(p); }});
    assert.ok(fs.existsSync(r.dir));
    // 人为删去包内快照 → 闭包检查报告
    const staging = path.join(d, 'stage-copy'); fs.cpSync(r.dir, staging, {recursive: true});
    fs.rmSync(path.join(staging, 'data', 'task-snapshots', ...a.snapshotRef.split('/').slice(1)));
    assert.throws(() => A.checkClosure(staging, r.record), e => e.code === 'INTEGRITY' && /任务快照/.test(e.message));
  } finally { db.close(); }
});
test('S06：恢复失败进入恢复模式，不重复新建 journal；可选择继续同一 journal 或回退', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ab3-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const layout = ensureLayout(d);
  fs.writeFileSync(layout.workspace, '{"v":1}');
  const {dir} = await A.createAppBackup({layout});
  fs.writeFileSync(layout.workspace, '{"v":2}');
  await A.scheduleAppRestore(layout, dir);
  // 让恢复中途失败：workspace 的 staging 位置被同名文件占住目录
  const {RestoreEngine} = require('../desktop/maintenance/restore.cjs');
  const orig = RestoreEngine.prototype._verify; let fail = true;
  RestoreEngine.prototype._verify = async function (...a) { if (fail) throw Object.assign(new Error('模拟校验中断'), {code: 'INTEGRITY'}); return orig.apply(this, a); };
  t.after(() => { RestoreEngine.prototype._verify = orig; });
  const r1 = await A.applyPendingAppRestore(layout);
  assert.equal(r1.status, 'failed'); assert.ok(r1.recovery && r1.journalId);
  assert.ok(A.appRecoveryState(layout), '恢复模式持续');
  const r2 = await A.applyPendingAppRestore(layout);
  assert.equal(r2.status, 'failed', '未选择前不自动重试'); assert.equal(r2.journalId, r1.journalId);
  // 选择回退：现场回到原位
  A.chooseAppRecovery(layout, 'rollback');
  const r3 = await A.applyPendingAppRestore(layout);
  assert.equal(r3.status, 'rolled-back');
  assert.equal(fs.readFileSync(layout.workspace, 'utf8'), '{"v":2}', '回退后是恢复前的数据');
  assert.equal(A.appRecoveryState(layout), null);
  // 再来一次并选择继续
  await A.scheduleAppRestore(layout, dir);
  const r4 = await A.applyPendingAppRestore(layout); assert.equal(r4.status, 'failed');
  fail = false; A.chooseAppRecovery(layout, 'resume');
  const r5 = await A.applyPendingAppRestore(layout);
  assert.equal(r5.status, 'restored'); assert.equal(r5.restoreId, r4.journalId, '继续同一 journal');
  assert.equal(fs.readFileSync(layout.workspace, 'utf8'), '{"v":1}');
});
test('S06：环境备份按登记目录排除；Python 包内 models/ 与 .bin 进入备份；备份根与来源重叠时拒绝', async t => {
  const {createBackup} = require('../desktop/maintenance/backup.cjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ab4-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const root = path.join(d, 'ComfyUI');
  fs.mkdirSync(path.join(root, 'models', 'checkpoints'), {recursive: true}); fs.writeFileSync(path.join(root, 'models', 'checkpoints', 'big.safetensors'), 'W');
  const pkg = path.join(root, 'venv', 'Lib', 'site-packages', 'pkg'); fs.mkdirSync(path.join(pkg, 'models'), {recursive: true});
  fs.writeFileSync(path.join(pkg, 'models', '__init__.py'), 'x'); fs.writeFileSync(path.join(pkg, 'data.bin'), 'b');
  const r = await createBackup({backupRoot: path.join(d, 'bk'), sources: [{id: 'root', path: root}], excludeDirs: new Set(['__pycache__']), excludeExt: [], excludePaths: [path.join(root, 'models')]});
  const files = r.record.sources[0].files.map(f => f.rel.split(path.sep).join('/'));
  assert.ok(files.includes('venv/Lib/site-packages/pkg/data.bin'));
  assert.ok(files.includes('venv/Lib/site-packages/pkg/models/__init__.py'));
  assert.ok(!files.some(f => f.endsWith('big.safetensors')));
  await assert.rejects(createBackup({backupRoot: path.join(root, 'bk'), sources: [{id: 'root', path: root}]}), e => e.code === 'INVALID_PATH');
  await assert.rejects(createBackup({backupRoot: path.join(d, 'bk'), protectedPaths: [path.join(root, 'staging')], sources: [{id: 'root', path: root}]}), e => e.code === 'INVALID_PATH');
});
