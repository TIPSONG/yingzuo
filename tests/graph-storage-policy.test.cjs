'use strict';
// C01：统一图保存/导出政策（虚构密钥，临时目录）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createGraphStoragePolicy, findSecretWidgets} = require('../shared/graph-storage-policy.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');
const {Database} = require('../desktop/repositories/database.cjs');
const {TemplateRepository} = require('../desktop/repositories/template-repo.cjs');
const {migrateStoredGraphs} = require('../desktop/maintenance/secret-migration.cjs');
const {buildPackage} = require('../desktop/services/graph-package.cjs');

const KEY = 'fictional-key-value-123';
const safe = (ok = true) => ({isEncryptionAvailable: () => ok, getSelectedStorageBackend: () => 'dpapi', encryptString: s => Buffer.from(`enc:${s}`), decryptString: b => b.toString().slice(4)});
// Windows：after 钩子按注册顺序执行，先关数据库再删目录，否则 EBUSY
const tmp = (t, pre = []) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-gsp-')); t.after(() => { for (const f of pre) f(); fs.rmSync(d, {recursive: true, force: true}); }); return d; };
const objectInfo = {MyLLM: {input: {required: {prompt: ['STRING', {multiline: true}], seed: ['INT', {}], api_key: ['STRING', {password: true}]}, optional: {model: [['a', 'b']]}}}};
const g = () => ({nodes: [{id: 1, type: 'MyLLM', widgets_values: ['写一首诗', 7, 'randomize', KEY, 'a']}, {id: 2, type: 'CLIPTextEncode', widgets_values: ['正常提示词']}], definitions: {subgraphs: [{id: 's', nodes: [{id: 1, type: 'MyLLM', widgets_values: ['子图', 1, 'fixed', KEY, 'b']}]}]}});

test('C01：按 object_info 的 widget 顺序（含 seed 控制位）识别，覆盖嵌套子图；普通文本不动', () => {
  const hits = findSecretWidgets(g(), {objectInfo});
  assert.deepEqual(hits.map(h => [h.scope, h.nodeId, h.key, h.name]), [['root', '1', 3, 'api_key'], ['subgraph:s', '1', 3, 'api_key']]);
});
test('C01：内部保存→引用；载入→内存还原；导出→移除且无本机标识；新机器缺凭据时列出 missing', t => {
  const d = tmp(t); const cred = new CredentialStore(path.join(d, 'c.json'), safe());
  const p = createGraphStoragePolicy({credentials: cred, objectInfo: () => objectInfo});
  const orig = g(); const disk = p.secureForStorage(orig);
  assert.equal(orig.nodes[0].widgets_values[3], KEY, '不改动活跃对象');
  const text = JSON.stringify(disk); assert.ok(!text.includes(KEY)); assert.ok(text.includes('正常提示词') && text.includes('写一首诗'));
  assert.equal(p.resolveInMemory(disk).graph.nodes[0].widgets_values[3], KEY);
  // 已存凭据后：即使没有 object_info 也能按已知明文识别
  const p2 = createGraphStoragePolicy({credentials: cred});
  assert.ok(!JSON.stringify(p2.secureForStorage(g())).includes(KEY));
  const ex = p.stripForExport(disk); assert.ok(!JSON.stringify(ex.graph).includes('__yz_credential__')); assert.equal(ex.graph.nodes[1].widgets_values[0], '正常提示词');
  const fresh = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'other.json'), safe())});
  const r = fresh.resolveInMemory(disk); assert.equal(r.missing.length, 2);
});
test('C01：系统加密不可用时拒绝保存（不明文落盘、不清空）', t => {
  const p = createGraphStoragePolicy({credentials: new CredentialStore(path.join(tmp(t), 'c.json'), safe(false)), objectInfo: () => objectInfo});
  assert.throws(() => p.secureForStorage(g()), e => e.code === 'CREDENTIAL_UNAVAILABLE');
});
test('RR02：离线只认明确密钥格式，未知 widget 位置单独报告而不猜候选', () => {
  const graph = {nodes: [{id: 3, type: 'X', inputs: [{name: 'token', widget: {name: 'token'}}], widgets_values: ['正文 有空格', 'abcdEFGH12345678']}, {id: 4, type: 'Y', widgets_values: ['sk-FICTIONAL000000000000000']}]};
  const uncertain = [];
  const hits = findSecretWidgets(graph, {uncertain});
  assert.deepEqual(hits.map(h => [h.nodeId, h.key]), [['4', 0]]);
  assert.deepEqual(uncertain.map(u => [u.nodeId, u.field]), [['3', 'token']]);
});
test('C01：图包导出使用导出政策并附需重填字段', t => {
  const p = createGraphStoragePolicy({objectInfo: () => objectInfo});
  const pkg = buildPackage({title: 'x', graph: g(), readRef: () => { throw new Error('none'); }, exportGraph: p.stripForExport});
  assert.ok(!JSON.stringify(pkg).includes(KEY)); assert.equal(pkg.refill.length, 2);
});
test('C01：模板直接导入经 secureGraph；旧模板版本/关闭归档迁移为引用并记录，旧明文内容文件删除', t => {
  const pre = []; const d = tmp(t, pre); const db = Database.open(path.join(d, 'y.sqlite')); pre.push(() => db.close());
  const cred = new CredentialStore(path.join(d, 'c.json'), safe());
  const p = createGraphStoragePolicy({credentials: cred, objectInfo: () => objectInfo});
  const repo = new TemplateRepository(db, path.join(d, 'templates'));
  const old = repo.create({name: '旧', graph: g(), source: 'local'}); // 迁移前的旧数据（明文）
  const oldRef = db.get('SELECT graph_ref FROM template_versions WHERE template_id = ?', old.id).graph_ref;
  repo.secureGraph = p.secureForStorage;
  const fresh = repo.create({name: '新', graph: g(), source: 'online'});
  assert.ok(!JSON.stringify(repo.current(fresh.id).graph).includes(KEY));
  const layout = {root: d, closed: path.join(d, 'closed-workflows'), migrations: path.join(d, 'migrations')};
  fs.mkdirSync(layout.closed); fs.writeFileSync(path.join(layout.closed, 'tab1.json'), JSON.stringify(g()));
  const rep = migrateStoredGraphs({db, layout, repo, policy: p, credentials: cred});
  assert.deepEqual(rep.migrated.map(m => m.kind).sort(), ['closed', 'template-version']);
  assert.ok(!JSON.stringify(repo.current(old.id).graph).includes(KEY));
  assert.ok(!fs.existsSync(path.join(d, 'templates', ...oldRef.split('/'))), '旧明文内容文件已删除');
  assert.ok(!fs.readFileSync(path.join(layout.closed, 'tab1.json'), 'utf8').includes(KEY));
  assert.ok(!fs.readFileSync(path.join(layout.migrations, 'secret-scan.json'), 'utf8').includes(KEY), '记录不含值');
  const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(d)) if (!f.endsWith('.sqlite') && !f.includes('sqlite')) assert.ok(!fs.readFileSync(f, 'utf8').includes(KEY), `递归检查：${f}`);
});
