'use strict';
// RV03：任务快照 UI 图（未连接/静音/旁路节点）同样经存储政策；批量、重试、表单/参数字段；旧快照迁移后备份来源无明文。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {setup, prompt, safeStorage, grep} = require('./review-helpers.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');
const {createGraphStoragePolicy} = require('../shared/graph-storage-policy.cjs');
const {migrateStoredGraphs} = require('../desktop/maintenance/secret-migration.cjs');

const KEY = 'sk-FICTIONALunusedNode0000000';
const PWD = 'fictional-password-field-77';
const objectInfo = {LooseLLM: {input: {required: {prompt: ['STRING', {multiline: true}], api_key: ['STRING', {password: true}]}}}};
// UI 图里有未连接（mode 0）、静音（mode 2）、旁路（mode 4）的 LLM 节点；它们不进入 API 执行图
const ui = () => ({nodes: [
  {id: 50, type: 'LooseLLM', mode: 0, widgets_values: ['未连接', PWD]},
  {id: 51, type: 'Other', mode: 2, widgets_values: [KEY]},
  {id: 52, type: 'LooseLLM', mode: 4, widgets_values: ['旁路', PWD]},
], definitions: {subgraphs: [{id: 's', nodes: [{id: 1, type: 'Other', widgets_values: [KEY]}]}]}});
function env(t) {
  const holder = {};
  const fs = require('node:fs'); const cd = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'yz-rv03c-'));
  t.after(() => fs.rmSync(cd, {recursive: true, force: true}));
  const credentials = new CredentialStore(path.join(cd, 'c.json'), safeStorage());
  const graphPolicy = createGraphStoragePolicy({credentials, objectInfo: () => objectInfo});
  const e = setup(t, {credentials, graphPolicy});
  e.editor.commands.compileTab = async id => ({tabId: id, title: 'T', revision: 3, uiGraph: ui(), apiPrompt: prompt()});
  return {...e, credentials, graphPolicy, holder};
}
const snapOf = (svc, id) => svc.tasks.snapshotOf(svc.tasks.get(id));

test('RV03：执行图无密钥但 UI 图含未连接/静音/旁路/子图节点密钥——普通运行快照无明文，提交正常', async t => {
  const {svc, settle, submitted, layout} = env(t);
  const task = await svc.methods['tasks.run']('tab1', {}); await settle();
  const s = JSON.stringify(snapOf(svc, task.id));
  assert.ok(!s.includes(KEY) && !s.includes(PWD));
  assert.match(snapOf(svc, task.id).uiGraph.nodes[0].widgets_values[1], /^__yz_credential__:node-secret:/);
  assert.equal(submitted.length, 1);
  assert.deepEqual(grep(layout['task-snapshots'], KEY), []);
  assert.deepEqual(grep(layout['task-snapshots'], PWD), []);
});
test('RV03：批量、快捷入口参数字段、重试旧快照都经同一政策', async t => {
  const {svc, settle, layout} = env(t);
  const b = await svc.methods['tasks.runBatch']('tab1', {seeds: [1, 2]});
  const c = await svc.compile('tab1');
  const q = svc.submissions.enqueueCompiled(c, c.apiPrompt, {params: {note: KEY}, meta: {form: {values: {0: PWD}}}, references: []});
  await settle();
  for (const id of [...b.tasks.map(x => x.id), q.id]) { const s = JSON.stringify(snapOf(svc, id)); assert.ok(!s.includes(KEY) && !s.includes(PWD), id); }
  // 旧快照（政策接入前写入的明文）重试：新任务快照无明文
  const secure = svc.tasks.secure; svc.tasks.secure = null;
  const legacy = svc.tasks.create({workflowId: 'w', snapshot: {uiGraph: ui(), apiPrompt: prompt(), tabId: 'tab1'}, clientId: 'c'});
  svc.tasks.secure = secure;
  for (const st of ['preparing', 'failed']) svc.tasks.transition(legacy.id, st);
  const r = await svc.methods['tasks.retry'](legacy.id);
  assert.ok(!JSON.stringify(snapOf(svc, r.id)).includes(KEY));
  assert.ok(grep(layout['task-snapshots'], KEY).length === 1, '只剩旧快照');
});
test('RV03：旧快照迁移——新内容地址 + 数据库引用原子更新；lineage 不变；备份来源（task-snapshots）无明文', async t => {
  const {svc, db, layout, graphPolicy, credentials} = env(t);
  const secure = svc.tasks.secure; svc.tasks.secure = null;
  const a = svc.tasks.create({workflowId: 'w', snapshot: {uiGraph: ui(), apiPrompt: prompt(), form: {values: {0: KEY}}}, clientId: 'c'});
  for (const st of ['preparing', 'failed']) svc.tasks.transition(a.id, st);
  const b = svc.tasks.retry(a.id); // 未经政策的重试（同内容同文件）
  svc.tasks.secure = secure;
  const oldRef = svc.tasks.get(a.id).snapshotRef;
  assert.equal(grep(layout['task-snapshots'], KEY).length, 1);
  const rep = migrateStoredGraphs({db, layout, policy: graphPolicy, credentials});
  assert.ok(rep.migrated.some(m => m.kind === 'task-snapshot'));
  assert.deepEqual(grep(layout['task-snapshots'], KEY), []);
  assert.deepEqual(grep(layout['task-snapshots'], PWD), []);
  const na = svc.tasks.get(a.id), nb = svc.tasks.get(b.id);
  assert.notEqual(na.snapshotRef, oldRef); assert.equal(na.snapshotRef, nb.snapshotRef);
  assert.ok(svc.tasks.snapshotOf(na), 'hash 校验通过');
  assert.deepEqual(svc.tasks.lineage(b.id), [a.id, b.id]);
  // 无法加密时只记录 pending（备份会据此阻止）
  const c2 = svc.tasks; c2.secure = null; c2.create({workflowId: 'w', snapshot: {uiGraph: ui(), apiPrompt: prompt(), x: 1}, clientId: 'c'}); c2.secure = secure;
  const off = migrateStoredGraphs({db, layout, policy: createGraphStoragePolicy({credentials: {available: () => false}, objectInfo: () => objectInfo}), credentials: {available: () => false}});
  assert.ok(off.pending.some(p => p.kind === 'task-snapshot'));
});
