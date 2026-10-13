'use strict';
// 接线后的 maintenance.* / resources.* 与插件 Git 操作（只在临时目录中）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {Database} = require('../desktop/repositories/database.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
const {createMaintenanceService, nodeTypesOf} = require('../desktop/services/maintenance-service.cjs');
const ops = require('../desktop/maintenance/plugin-ops.cjs');

const ENV = {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'};
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], {stdio: 'pipe', env: ENV}).toString().trim();
const dirs = [], dbs = [];
test.after(() => { for (const d of dbs) { try { d.close(); } catch { /* 已关闭 */ } } for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ms-')); dirs.push(d); return d; };

function setup(opt = {}) {
  const base = tmp(), root = path.join(base, 'ComfyUI');
  fs.mkdirSync(path.join(root, 'custom_nodes', 'node-a'), {recursive: true});
  fs.writeFileSync(path.join(root, 'custom_nodes', 'node-a', '__init__.py'), 'X=1\n');
  fs.mkdirSync(path.join(root, 'models', 'loras'), {recursive: true});
  fs.writeFileSync(path.join(root, 'models', 'loras', 'style.safetensors'), Buffer.alloc(64, 1));
  const ext = path.join(base, 'ext');
  fs.mkdirSync(path.join(ext, 'loras'), {recursive: true});
  fs.writeFileSync(path.join(root, 'extra_model_paths.yaml'), `other:\n  base_path: ${ext}\n  loras: loras\n`);
  const layout = {root: path.join(base, 'data'), trash: path.join(base, 'data', 'trash'), database: path.join(base, 'data', 'app.db')};
  fs.mkdirSync(layout.trash, {recursive: true});
  const db = Database.open(layout.database); dbs.push(db);
  const config = {comfy: {root, url: 'http://127.0.0.1:1/', python: ''}, maintenance: {keepBackups: 2}};
  const configRepo = {config, derived: () => ({backups: path.join(base, 'backups')})};
  const calls = [];
  const comfy = {verifyOwned: opt.verifyOwned ?? (async () => false), stop: async () => calls.push('stop'), ensureRunning: async () => calls.push('start')};
  const paused = [];
  const taskService = {hooks: {pauseSubmissions: () => { paused.push('p'); return () => paused.push('r'); }, waitForIdle: async () => {}, activeTasks: () => opt.active ?? []}, tasks: {list: () => [{id: 't1', seq: 1}], snapshotOf: () => ({apiPrompt: {1: {class_type: 'LoraLoader', inputs: {lora_name: 'style.safetensors'}}}})}};
  const editor = {workspace: {tabs: [{id: 'd1', title: '草稿一', graph: {nodes: [{id: 1, type: 'NodeA', widgets_values: ['style.safetensors']}]}}]}};
  const events = {emit: () => {}};
  const locks = createLocks();
  const svc = createMaintenanceService({db, layout, configRepo, locks, events, comfy, taskService, editor, fetchImpl: opt.fetchImpl ?? (async () => { throw new Error('offline'); })});
  return {base, root, ext, svc, db, calls, paused, layout, locks};
}

test('resources.scan/detail/references：引用来自草稿和任务快照', async () => {
  const {svc} = setup();
  const s = await svc.methods['resources.scan']();
  const lora = s.items.find(i => i.name === 'style.safetensors');
  assert.ok(lora);
  const d = await svc.methods['resources.detail'](lora.id);
  const kinds = [...d.references.exact, ...d.references.possible].map(r => r.kind).sort();
  assert.deepEqual([...new Set(kinds)], ['draft', 'task']);
  const imp = await svc.methods['resources.impact'](lora.id);
  assert.ok(imp);
});

test('禁用/启用插件走事务：拿环境锁、暂停队列、备份并记录 env_transactions', async () => {
  const {svc, root, db, paused} = setup();
  const r = await svc.methods['resources.disablePlugin']('node-a', '测试');
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.ok(!fs.existsSync(path.join(root, 'custom_nodes', 'node-a')));
  assert.ok(fs.existsSync(r.backupDir));
  assert.deepEqual(paused, ['p', 'r']);
  const rows = db.all('SELECT * FROM env_transactions');
  assert.equal(rows.length, 1); assert.equal(rows[0].phase, 'done'); assert.equal(rows[0].scope, 'plugin-disable');
  const r2 = await svc.methods['resources.enablePlugin']('node-a');
  assert.equal(r2.status, 'done');
  assert.ok(fs.existsSync(path.join(root, 'custom_nodes', 'node-a', '__init__.py')));
  const t = await svc.methods['maintenance.transactions']();
  assert.equal(t.length, 2);
});

test('环境锁被占用时事务被阻止，不改动任何文件', async () => {
  const base = setup();
  // 通过内部锁：先占用
  const locks = createLocks(); const release = locks.environment.tryAcquire('other');
  const svc = createMaintenanceService({db: base.db, layout: base.layout, configRepo: {config: {comfy: {root: base.root, url: 'http://127.0.0.1:1/'}}, derived: () => ({backups: path.join(base.base, 'b2')})}, locks, events: {emit() {}}, comfy: {verifyOwned: async () => false}, fetchImpl: async () => { throw new Error('x'); }});
  const r = await svc.methods['resources.disablePlugin']('node-a');
  assert.equal(r.status, 'blocked');
  assert.ok(fs.existsSync(path.join(base.root, 'custom_nodes', 'node-a')));
  release();
});

test('apply 失败自动从备份恢复', async () => {
  const {svc, root} = setup();
  const r = await svc.runTransaction({title: '坏操作', kind: 'test', roots: [path.join(root, 'custom_nodes')], requiredBytes: 0, apply: async () => { fs.rmSync(path.join(root, 'custom_nodes', 'node-a'), {recursive: true}); throw new Error('boom'); }});
  assert.equal(r.status, 'restored');
  assert.ok(fs.existsSync(path.join(root, 'custom_nodes', 'node-a', '__init__.py')));
});

test('R07 安装（本地仓库模拟）→ 移除进入回收区；移除前返回使用者清单', async () => {
  const {svc, root, base, layout} = setup();
  const src = path.join(base, 'src', 'cool-nodes'); fs.mkdirSync(src, {recursive: true});
  fs.writeFileSync(path.join(src, '__init__.py'), 'NODE_CLASS_MAPPINGS={}\n'); git(src, 'init', '-q'); git(src, 'add', '-A'); git(src, 'commit', '-qm', 'v1');
  assert.throws(() => ops.installPlan({comfyRoot: root, url: 'git@github.com:a/b.git', stagingRoot: base}), /https|无效/);
  assert.throws(() => ops.installPlan({comfyRoot: root, url: 'https://u:p@github.com/a/b', stagingRoot: base}), /https/);
  const plan = ops.installPlan({comfyRoot: root, url: src, allowLocal: true, stagingRoot: path.join(base, 'staging')});
  const r = await svc.runTransaction(plan);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.ok(fs.existsSync(path.join(root, 'custom_nodes', 'cool-nodes', '__init__.py')));
  const pre = await svc.methods['resources.removePlugin']('cool-nodes');
  assert.equal(pre.needsConfirm, true);
  const rm = await svc.methods['resources.removePlugin']('cool-nodes', {confirm: true});
  assert.equal(rm.status, 'done');
  assert.ok(!fs.existsSync(path.join(root, 'custom_nodes', 'cool-nodes')));
  // R14：进入登记的回收区，可列出并恢复
  const list = await svc.methods['trash.list']();
  const item = list.items.find(e => e.kind === 'plugin' && e.origin.endsWith('cool-nodes'));
  assert.ok(item && fs.existsSync(item.stored));
  await assert.rejects(svc.methods['trash.purge']({ids: [item.id]}), e => e.code === 'CONFIRM_REQUIRED');
  await svc.methods['trash.restore'](item.id);
  assert.ok(fs.existsSync(path.join(root, 'custom_nodes', 'cool-nodes')));
});

test('U06 更新：本地补丁可重放则保留；冲突则列入待处理且补丁文件仍在', async () => {
  const {svc, base} = setup();
  const repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.py'), 'line1\nline2\nline3\n'); fs.writeFileSync(path.join(repo, 'b.py'), 'b\n');
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'v1');
  fs.writeFileSync(path.join(repo, 'b.py'), 'b changed upstream\n'); git(repo, 'commit', '-qam', 'v2'); git(repo, 'tag', 'v2');
  fs.writeFileSync(path.join(repo, 'a.py'), 'line1\nCONFLICT upstream\nline3\n'); git(repo, 'commit', '-qam', 'v3'); git(repo, 'tag', 'v3');
  git(repo, 'checkout', '-q', 'HEAD~2');
  fs.writeFileSync(path.join(repo, 'a.py'), 'line1\nline2 LOCAL PATCH\nline3\n');
  const patches = path.join(base, 'patches');
  const r = await svc.runTransaction(ops.updatePlan({repoDir: repo, revision: 'v2', patchesDir: patches, updateDeps: false, fetch: false}));
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.result.pending, null);
  assert.match(fs.readFileSync(path.join(repo, 'a.py'), 'utf8'), /LOCAL PATCH/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'v2'));
  // R03/D07：补丁冲突不能记为成功；预检阻止，环境与本地改动不变
  const r2 = await svc.runTransaction(ops.updatePlan({repoDir: repo, revision: 'v3', patchesDir: patches, updateDeps: false, fetch: false}));
  assert.equal(r2.status, 'blocked');
  assert.equal(r2.error.code, 'CONFLICT');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'v2'));
  assert.match(fs.readFileSync(path.join(repo, 'a.py'), 'utf8'), /LOCAL PATCH/);
  assert.ok(fs.readdirSync(patches).some(f => fs.readFileSync(path.join(patches, f), 'utf8').includes('LOCAL PATCH')));
});

test('R03：未跟踪文件与目标版本同名时阻止更新，文件不被覆盖', async () => {
  const {svc, base} = setup();
  const repo = path.join(base, 'repo2'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.py'), 'a\n'); git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'v1');
  fs.writeFileSync(path.join(repo, 'new.py'), 'upstream\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'v2'); git(repo, 'tag', 'v2');
  git(repo, 'checkout', '-q', 'HEAD~1'); fs.writeFileSync(path.join(repo, 'new.py'), 'mine\n');
  const r = await svc.runTransaction(ops.updatePlan({repoDir: repo, revision: 'v2', patchesDir: path.join(base, 'p2'), updateDeps: false, fetch: false}));
  assert.equal(r.status, 'blocked'); assert.match(r.error.message, /未跟踪/);
  assert.equal(fs.readFileSync(path.join(repo, 'new.py'), 'utf8'), 'mine\n');
});

test('R08 只能移动到同用途已登记目录；跨目录移动后原文件不在', async () => {
  const {svc, ext, root, locks, paused} = setup();
  const s = await svc.methods['resources.scan']();
  const lora = s.items.find(i => i.name === 'style.safetensors' && i.folder === 'loras');
  await assert.rejects(svc.methods['resources.moveModel'](lora.id, os.tmpdir()), /已登记/);
  const hold = locks.environment.tryAcquire('维护');
  await assert.rejects(svc.methods['resources.moveModel'](lora.id, path.join(ext, 'loras')), e => e.code === 'LOCKED');
  assert.ok(fs.existsSync(path.join(root, 'models', 'loras', 'style.safetensors')), 'D12：维护持锁时不移动');
  hold();
  const r = await svc.methods['resources.moveModel'](lora.id, path.join(ext, 'loras'));
  assert.ok(fs.existsSync(r.moved));
  assert.deepEqual(paused.slice(-2), ['p', 'r'], '移动期间暂停提交，结束后释放');
  assert.equal(locks.environment.locked, false);
  assert.ok(!fs.existsSync(path.join(root, 'models', 'loras', 'style.safetensors')));
});

test('U07 备份列表与保留：使用中/每个来源最近一份不清理', async () => {
  const {svc} = setup();
  for (let i = 0; i < 3; i++) assert.equal((await svc.methods['maintenance.createBackup']()).status, 'done');
  const b = await svc.methods['maintenance.backups']();
  assert.equal(b.backups.length, 3);
  assert.equal(b.prunable.length, 1);
  const p = await svc.methods['maintenance.pruneBackups']();
  assert.equal(p.moved.length, 1);
  assert.equal((await svc.methods['maintenance.backups']()).backups.length, 2);
});

test('nodeTypesOf 支持 UI 与 API 图', () => {
  assert.deepEqual(nodeTypesOf({nodes: [{type: 'A'}], definitions: {subgraphs: [{nodes: [{type: 'B'}]}]}}), ['A', 'B']);
  assert.deepEqual(nodeTypesOf({1: {class_type: 'C'}}), ['C']);
});

test('D06/PR11-R02：继续恢复与恢复备份走同一保护——外部服务运行时拒绝；失败后保持暂停并拒绝新维护', async () => {
  const ext = setup({fetchImpl: async () => new Response('{}', {status: 200})});
  await assert.rejects(ext.svc.methods['maintenance.resumeRestore']('no-such'), e => e.code === 'NOT_OWNED');
  assert.deepEqual(ext.paused, [], '外部服务检查在暂停之前');
  const {svc, paused} = setup();
  await assert.rejects(svc.methods['maintenance.resumeRestore']('no-such'));
  assert.deepEqual(paused, ['p'], '失败后租约未释放');
  assert.equal((await svc.methods['maintenance.holds']()).length, 1);
  await assert.rejects(svc.methods['maintenance.createBackup'](), e => e.code === 'INVALID_STATE');
});

function moveFixture(opt = {}) {
  const ctx = setup(opt); const crypto = require('node:crypto');
  const r1 = path.join(ctx.base, 'ComfyUI', 'models', 'checkpoints'); fs.mkdirSync(r1, {recursive: true});
  const moves = path.join(ctx.layout.root, 'model-moves'); fs.mkdirSync(moves, {recursive: true});
  const h = b => crypto.createHash('sha256').update(b).digest('hex');
  const mk = (name, body) => { const p = path.join(r1, name); fs.writeFileSync(p, body); return p; };
  const journal = (name, j) => fs.writeFileSync(path.join(moves, `${name}.json`), JSON.stringify(j));
  return {...ctx, r1, moves, h, mk, journal};
}
test('R06：跨盘移动中断后启动核对——目标完整则删源，否则删临时副本保留源', async () => {
  const {svc, r1, moves, h, mk, journal} = moveFixture();
  const s1 = mk('s1.safetensors', 'AAA'), d1 = mk('d1.safetensors', 'AAA');
  journal('a', {src: s1, dest: d1, tmp: d1 + '.yz-moving', sha256: h('AAA')});
  const s2 = mk('s2.safetensors', 'BBB'), d2 = path.join(r1, 'd2.safetensors'), t2 = mk('d2.safetensors.yz-moving', 'BB');
  journal('b', {src: s2, dest: d2, tmp: t2, sha256: h('BBB')});
  const r = await svc.recoverModelMoves();
  assert.deepEqual(r.map(x => x.action).sort(), ['completed', 'rolled-back']);
  assert.ok(!fs.existsSync(s1) && fs.existsSync(d1));
  assert.ok(fs.existsSync(s2) && !fs.existsSync(t2));
  assert.deepEqual(fs.readdirSync(moves), []);
});
test('S04：源路径出现新内容（含同大小）——不删除、两份保留、标冲突且下次仍保留', async () => {
  const {svc, moves, h, mk, journal} = moveFixture();
  const src = mk('m.safetensors', 'NEW'), dest = mk('m2.safetensors', 'OLD'); // 同大小、内容不同
  journal('a', {src, dest, tmp: dest + '.yz-moving', sha256: h('OLD')});
  const r = await svc.recoverModelMoves();
  assert.equal(r[0].action, 'conflict');
  assert.equal(fs.readFileSync(src, 'utf8'), 'NEW', 'sourcePreserved');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'OLD');
  assert.equal((await svc.recoverModelMoves())[0].action, 'conflict'); assert.equal(fs.readdirSync(moves).length, 1);
});
test('S04：源缺失＋目标损坏保留现场；源缺失＋只有完整临时副本则补完；非法 journal 不动文件', async () => {
  const {svc, base, moves, h, mk, journal} = moveFixture();
  const d1 = mk('x.safetensors', 'BAD'), t1 = mk('x.safetensors.yz-moving', 'GOOD');
  journal('a', {src: path.join(path.dirname(d1), 'gone.safetensors'), dest: d1, tmp: t1, sha256: h('GOOD')});
  let r = await svc.recoverModelMoves();
  assert.equal(r[0].action, 'needs-attention'); assert.ok(fs.existsSync(t1) && fs.existsSync(d1)); fs.rmSync(path.join(moves, 'a.json'));
  const d2 = path.join(path.dirname(d1), 'y.safetensors'), t2 = mk('y.safetensors.yz-moving', 'ONLY');
  journal('b', {src: path.join(path.dirname(d1), 'gone2.safetensors'), dest: d2, tmp: t2, sha256: h('ONLY')});
  r = await svc.recoverModelMoves();
  assert.equal(r[0].action, 'completed-from-temp'); assert.equal(fs.readFileSync(d2, 'utf8'), 'ONLY');
  const outside = path.join(base, 'outside.txt'); fs.writeFileSync(outside, 'keep');
  const d3 = mk('z.safetensors', 'keep');
  journal('c', {src: outside, dest: d3, tmp: d3 + '.yz-moving', sha256: h('keep')});
  r = await svc.recoverModelMoves();
  assert.equal(r[0].action, 'needs-attention'); assert.ok(fs.existsSync(outside));
});
test('S04：有任务运行时推迟核对，不动文件、journal 保留', async () => {
  const {svc, h, mk, journal, moves} = moveFixture({active: [{id: 't'}]});
  const s = mk('a.safetensors', 'A'), d = mk('b.safetensors', 'A');
  journal('a', {src: s, dest: d, tmp: d + '.yz-moving', sha256: h('A')});
  const r = await svc.recoverModelMoves();
  assert.equal(r[0].action, 'deferred'); assert.ok(fs.existsSync(s)); assert.equal(fs.readdirSync(moves).length, 1);
});
