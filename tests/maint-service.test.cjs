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

function setup() {
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
  const comfy = {verifyOwned: async () => false, stop: async () => calls.push('stop'), ensureRunning: async () => calls.push('start')};
  const paused = [];
  const taskService = {hooks: {pauseSubmissions: () => paused.push('p'), resumeSubmissions: () => paused.push('r'), waitForIdle: async () => {}, activeTasks: () => []}, tasks: {list: () => [{id: 't1', seq: 1}], snapshotOf: () => ({apiPrompt: {1: {class_type: 'LoraLoader', inputs: {lora_name: 'style.safetensors'}}}})}};
  const editor = {workspace: {tabs: [{id: 'd1', title: '草稿一', graph: {nodes: [{id: 1, type: 'NodeA', widgets_values: ['style.safetensors']}]}}]}};
  const events = {emit: () => {}};
  const svc = createMaintenanceService({db, layout, configRepo, locks: createLocks(), events, comfy, taskService, editor, fetchImpl: async () => { throw new Error('offline'); }});
  return {base, root, ext, svc, db, calls, paused, layout};
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
  assert.ok(fs.readdirSync(path.join(layout.trash, 'plugins')).some(n => n.startsWith('cool-nodes-')));
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
  const r2 = await svc.runTransaction(ops.updatePlan({repoDir: repo, revision: 'v3', patchesDir: patches, updateDeps: false, fetch: false}));
  assert.equal(r2.status, 'done', JSON.stringify(r2.error));
  assert.ok(r2.result.pending);
  assert.ok(fs.existsSync(r2.result.pending.patchFile));
  assert.match(fs.readFileSync(r2.result.pending.patchFile, 'utf8'), /LOCAL PATCH/);
});

test('R08 只能移动到同用途已登记目录；跨目录移动后原文件不在', async () => {
  const {svc, ext, root} = setup();
  const s = await svc.methods['resources.scan']();
  const lora = s.items.find(i => i.name === 'style.safetensors' && i.folder === 'loras');
  await assert.rejects(svc.methods['resources.moveModel'](lora.id, os.tmpdir()), /已登记/);
  const r = await svc.methods['resources.moveModel'](lora.id, path.join(ext, 'loras'));
  assert.ok(fs.existsSync(r.moved));
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
