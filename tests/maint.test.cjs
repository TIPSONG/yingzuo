'use strict';
// U01–U04：只在临时隔离目录中测试备份／恢复。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {collectManifest} = require('../desktop/maintenance/env-manifest.cjs');
const {createBackup, verifyBackup} = require('../desktop/maintenance/backup.cjs');
const {RestoreEngine} = require('../desktop/maintenance/restore.cjs');
const {MaintenanceTransaction} = require('../desktop/maintenance/transaction.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
const {loadDriver} = require('../desktop/repositories/database.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'yz-maint-')); }
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], {stdio: 'pipe', env: {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'}}).toString();
function fakeComfy(root) {
  fs.mkdirSync(path.join(root, 'custom_nodes', 'node-a'), {recursive: true});
  fs.mkdirSync(path.join(root, 'models', 'loras'), {recursive: true});
  fs.writeFileSync(path.join(root, 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'torch\ncomfyui-frontend-package==1.28.6\n');
  fs.writeFileSync(path.join(root, 'models', 'loras', 'big.safetensors'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(root, 'custom_nodes', 'node-a', '__init__.py'), 'X=1\n');
  fs.writeFileSync(path.join(root, 'custom_nodes', 'node-a', 'requirements.txt'), 'numpy\n');
  fs.writeFileSync(path.join(root, 'custom_nodes', 'node-a', 'pyproject.toml'), '[project]\nname="a"\nversion = "0.3.1"\n');
  fs.writeFileSync(path.join(root, 'extra_model_paths.yaml'), 'a:\n  base_path: /x\n');
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
  git(path.join(root, 'custom_nodes', 'node-a'), 'init', '-q');
  git(path.join(root, 'custom_nodes', 'node-a'), 'add', '-A'); git(path.join(root, 'custom_nodes', 'node-a'), 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'custom_nodes', 'node-a', '__init__.py'), 'X=2  # local edit\n');
}
function makeDb(file) {
  const db = loadDriver().open(file, {readonly: false});
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES (\'a\'),(\'b\')');
  return db; // 保持打开，WAL 未 checkpoint
}

test('U01 环境清单记录核心、前端、插件未提交修改、配置，并标出缺口', async () => {
  const root = path.join(tmp(), 'ComfyUI'); fakeComfy(root);
  const m = await collectManifest({comfyRoot: root, python: path.join(root, 'nope', 'python.exe'), modelDirs: [path.join(root, 'models')]});
  assert.equal(m.comfy.frontendVersion, '1.28.6');
  assert.match(m.comfy.git.head, /^[0-9a-f]{40}$/);
  const a = m.plugins.find(p => p.name === 'node-a');
  assert.equal(a.version, '0.3.1');
  assert.ok(a.git.dirty.some(d => d.file === '__init__.py'));
  assert.ok(a.git.diffSha256);
  assert.ok(m.configs.some(c => c.path.endsWith('extra_model_paths.yaml') && c.sha256));
  assert.equal(m.complete, false);
  assert.ok(m.gaps.some(g => g.part === 'python'));
  assert.equal(m.external.modelDirs[0].exists, true);
});

test('U01 python 依赖通过 runImpl 记录（venv 标记外部前置条件）', async () => {
  const dir = tmp(); const py = path.join(dir, 'python'); fs.writeFileSync(py, '');
  const runImpl = async (exe, args) => args[0] === '-c' ? {code: 0, stdout: JSON.stringify(['3.12.7', '/v', '/base'])} : args[0] === '-m' ? {code: 0, stdout: 'torch==2.5\nnumpy==2\n'} : {code: 1, stdout: ''};
  const m = await collectManifest({comfyRoot: dir, python: py, runImpl});
  assert.deepEqual(m.python.packages, ['torch==2.5', 'numpy==2']);
  assert.equal(m.python.isVenv, true);
  assert.equal(m.external.basePython, '/base');
});

test('U02 备份：复制含未提交修改的文件、排除权重、SQLite 一致性备份、可校验', async () => {
  const base = tmp(); const root = path.join(base, 'ComfyUI'); fakeComfy(root);
  const dbFile = path.join(base, 'app.sqlite'); const live = makeDb(dbFile);
  const manifest = await collectManifest({comfyRoot: root});
  const {dir, record} = await createBackup({backupRoot: path.join(base, 'backups'), manifest, sources: [{id: 'comfy', path: root}], databases: [{id: 'app', path: dbFile}], id: 'b1'});
  live.close();
  const src = record.sources[0];
  assert.ok(src.files.some(f => f.rel === path.join('custom_nodes', 'node-a', '__init__.py')));
  assert.ok(src.excluded.includes('models'));
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'comfy', 'models')));
  assert.equal(src.originalPath, root);
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'comfy', 'custom_nodes', 'node-a', '__init__.py'), 'utf8'), 'X=2  # local edit\n');
  const copy = loadDriver().open(path.join(dir, record.databases[0].file), {readonly: true});
  assert.equal(copy.prepare('SELECT count(*) c FROM t').get().c, 2); copy.close();
  assert.equal((await verifyBackup(dir)).ok, true);
  fs.appendFileSync(path.join(dir, 'data', 'comfy', 'main.py'), 'tamper');
  assert.equal((await verifyBackup(dir)).ok, false);
});

test('U02 未完成的备份不可用', async () => {
  const base = tmp(); const d = path.join(base, 'x'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), '1');
  const {dir} = await createBackup({backupRoot: path.join(base, 'b'), sources: [{id: 'x', path: d}], id: 'b'});
  fs.rmSync(path.join(dir, 'COMPLETE'));
  await assert.rejects(verifyBackup(dir), {code: 'INTEGRITY'});
});

test('U03 恢复：保留失败现场、搬回被排除的模型、恢复数据库、校验', async () => {
  const base = tmp(); const root = path.join(base, 'ComfyUI'); fakeComfy(root);
  const dbFile = path.join(base, 'app.sqlite'); makeDb(dbFile).close();
  const {dir} = await createBackup({backupRoot: path.join(base, 'backups'), sources: [{id: 'comfy', path: root}], databases: [{id: 'app', path: dbFile}], id: 'b1'});
  // 破坏环境
  fs.writeFileSync(path.join(root, 'main.py'), 'broken');
  fs.rmSync(path.join(root, 'custom_nodes', 'node-a'), {recursive: true});
  fs.writeFileSync(path.join(root, 'junk.py'), 'x');
  const db = loadDriver().open(dbFile, {readonly: false}); db.exec('DELETE FROM t'); db.close();
  const eng = new RestoreEngine({journalDir: path.join(base, 'journal')});
  const j = await eng.prepare(dir);
  const done = await eng.run(j.id);
  assert.equal(done.status, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'print(1)\n');
  assert.equal(fs.readFileSync(path.join(root, 'custom_nodes', 'node-a', '__init__.py'), 'utf8'), 'X=2  # local edit\n');
  assert.ok(!fs.existsSync(path.join(root, 'junk.py')));
  assert.equal(fs.statSync(path.join(root, 'models', 'loras', 'big.safetensors')).size, 1024);
  const scene = done.items[0].scene;
  assert.equal(fs.readFileSync(path.join(scene, 'main.py'), 'utf8'), 'broken');
  const r = loadDriver().open(dbFile, {readonly: true}); assert.equal(r.prepare('SELECT count(*) c FROM t').get().c, 2); r.close();
});

test('U03 中途退出后 resume 继续完成', async () => {
  const base = tmp(); const d = path.join(base, 'plugin'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'a.py'), 'orig');
  const {dir} = await createBackup({backupRoot: path.join(base, 'b'), sources: [{id: 'p', path: d}], id: 'b'});
  fs.writeFileSync(path.join(d, 'a.py'), 'new');
  let crash = true;
  const eng = new RestoreEngine({journalDir: path.join(base, 'j'), hooks: {afterStep: (id, step) => { if (crash && step === 'preserve') throw new Error('模拟退出'); }}});
  const j = await eng.prepare(dir);
  await assert.rejects(eng.run(j.id), /模拟退出/);
  assert.ok(!fs.existsSync(d)); // 现场已改名，目标暂缺
  assert.equal(eng.pending().length, 1);
  crash = false;
  const eng2 = new RestoreEngine({journalDir: path.join(base, 'j')});
  const done = await eng2.resume(j.id);
  assert.equal(done.status, 'done');
  assert.equal(fs.readFileSync(path.join(d, 'a.py'), 'utf8'), 'orig');
  assert.equal(eng2.pending().length, 0);
});

test('U03 拒绝用空备份覆盖非空目录、拒绝被篡改的备份', async () => {
  const base = tmp(); const d = path.join(base, 'empty'); fs.mkdirSync(d);
  const {dir} = await createBackup({backupRoot: path.join(base, 'b'), sources: [{id: 'e', path: d}], id: 'b'});
  fs.writeFileSync(path.join(d, 'important'), 'x');
  const eng = new RestoreEngine({journalDir: path.join(base, 'j')});
  await assert.rejects(eng.prepare(dir), {code: 'INVALID_STATE'});
  const d2 = path.join(base, 'p'); fs.mkdirSync(d2); fs.writeFileSync(path.join(d2, 'f'), '1');
  const b2 = await createBackup({backupRoot: path.join(base, 'b'), sources: [{id: 'p', path: d2}], id: 'b2'});
  fs.writeFileSync(path.join(b2.dir, 'data', 'p', 'f'), '2');
  await assert.rejects(eng.prepare(b2.dir), {code: 'INTEGRITY'});
});

function txDeps(base, over = {}) {
  const calls = [];
  const target = path.join(base, 'plugin'); fs.mkdirSync(target, {recursive: true}); fs.writeFileSync(path.join(target, 'a.py'), 'v1');
  const eng = new RestoreEngine({journalDir: path.join(base, 'j')});
  return {target, calls, deps: {
    locks: createLocks(),
    services: async () => [{id: 'comfy', owned: true, running: true}],
    stopService: async id => calls.push(['stop', id]),
    startService: async id => calls.push(['start', id]),
    queue: {pauseSubmissions: () => { calls.push(['pause']); return () => calls.push(['resume']); }, waitForIdle: async () => calls.push(['idle'])},
    backup: async () => createBackup({backupRoot: path.join(base, 'bk'), sources: [{id: 'p', path: target}]}),
    restore: async dir => { const j = await eng.prepare(dir); return eng.run(j.id); },
    ...over,
  }};
}

test('U04 成功事务：顺序为暂停→停止 owned→备份→应用→检查，最后恢复提交并释放锁', async () => {
  const base = tmp(); const {deps, target, calls} = txDeps(base);
  const tx = new MaintenanceTransaction(deps);
  const r = await tx.execute({title: '更新插件', roots: [target], apply: async () => fs.writeFileSync(path.join(target, 'a.py'), 'v2'), check: async () => true});
  assert.equal(r.status, 'done');
  assert.deepEqual(calls.map(c => c[0]), ['pause', 'idle', 'stop', 'start', 'resume']);
  assert.equal(deps.locks.environment.locked, false);
  assert.deepEqual(r.events.map(e => e.phase), ['plan', 'disk', 'lock', 'pause', 'services', 'stop', 'backup', 'staging', 'apply', 'apply', 'check', 'done']);
  assert.deepEqual(r.events.filter(e => e.phase === 'apply').map(e => e.state), ['running', 'done']);
});

test('C03：等待本应用任务结束期间出现外部任务——以等待后的服务状态为准，不停止、不应用、恢复租约', async () => {
  const base = tmp(); let idle = false;
  const {deps, target, calls} = txDeps(base, {services: async () => [{id: 'comfy', owned: !idle, running: true}]});
  deps.queue.waitForIdle = async () => { calls.push(['idle']); idle = true; };
  let applied = false;
  const r = await new MaintenanceTransaction(deps).execute({title: 'x', roots: [target], apply: async () => { applied = true; }});
  assert.equal(r.status, 'blocked'); assert.equal(r.error.code, 'NOT_OWNED'); assert.equal(applied, false);
  assert.deepEqual(calls.map(c => c[0]), ['pause', 'idle', 'resume']);
  assert.equal(deps.locks.environment.locked, false);
});

test('C03：阻断在取得环境锁后检查（等锁期间产生的 hold 也会拦住）', async () => {
  const base = tmp(); let hold = null;
  const {deps, target, calls} = txDeps(base, {gate: () => hold});
  hold = Object.assign(new Error('上一次维护恢复失败'), {code: 'INVALID_STATE'});
  const r = await new MaintenanceTransaction(deps).execute({title: 'x', roots: [target], apply: async () => {}});
  assert.equal(r.status, 'blocked'); assert.equal(r.error.code, 'INVALID_STATE'); assert.deepEqual(calls, []);
});

test('U04 应用失败自动恢复到备份', async () => {
  const base = tmp(); const {deps, target} = txDeps(base);
  const r = await new MaintenanceTransaction(deps).execute({title: 'x', roots: [target], apply: async () => { fs.writeFileSync(path.join(target, 'a.py'), 'bad'); throw new Error('pip 失败'); }});
  assert.equal(r.status, 'restored');
  assert.equal(fs.readFileSync(path.join(target, 'a.py'), 'utf8'), 'v1');
});

test('U04 外部服务运行、锁被占用、磁盘不足时阻止且不做任何改动', async () => {
  const base = tmp();
  let {deps, target} = txDeps(base, {services: async () => [{id: 'ext-comfy', owned: false, running: true}]});
  let applied = false; const plan = {title: 'x', roots: [target], apply: async () => { applied = true; }};
  let r = await new MaintenanceTransaction(deps).execute(plan);
  assert.equal(r.status, 'blocked'); assert.equal(r.error.code, 'NOT_OWNED');
  ({deps} = txDeps(tmp()));
  const rel = deps.locks.environment.tryAcquire('other');
  r = await new MaintenanceTransaction(deps).execute(plan);
  assert.equal(r.error.code, 'LOCKED'); rel();
  ({deps} = txDeps(tmp(), {freeBytes: () => 10}));
  r = await new MaintenanceTransaction(deps).execute({...plan, requiredBytes: 1e9});
  assert.equal(r.error.code, 'DISK_SPACE');
  assert.equal(applied, false);
});

test('D05/PR11-R01：恢复失败时不启动服务、不释放暂停租约，交给 onHold', async () => {
  const base = tmp(); let held = null;
  const {deps, target, calls} = txDeps(base, {restore: async () => { throw new Error('磁盘只读'); }, onHold: h => { held = h; }});
  const r = await new MaintenanceTransaction(deps).execute({title: 'x', roots: [target], apply: async () => { throw new Error('pip 失败'); }});
  assert.equal(r.status, 'restore-failed');
  assert.deepEqual(calls.map(c => c[0]), ['pause', 'idle', 'stop']);
  assert.ok(held && typeof held.lease === 'function'); assert.deepEqual(held.stopped, ['comfy']);
  assert.equal(deps.locks.environment.locked, false);
  held.lease(); assert.deepEqual(calls.at(-1), ['resume']);
});
