'use strict';
// RV02：forceInput 不占 widget 位；位数不一致时不按猜测位置清空；首次保存/离线可用落盘的 object_info。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createGraphStoragePolicy, findSecretWidgets, widgetNames} = require('../shared/graph-storage-policy.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');

const SECRET = 'fictional-any-format-secret-42';
const safe = () => ({isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: s => Buffer.from(`enc:${s}`), decryptString: b => b.toString().slice(4)});
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv02-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const info = {LLM: {input: {required: {prompt: ['STRING', {forceInput: true}], api_key: ['STRING', {password: true}], model: ['STRING', {}]}}},
  Seeded: {input: {required: {seed: ['INT', {control_after_generate: true}], token: ['STRING', {password: true}], text: ['STRING', {multiline: true}]}}}};

test('RV02：forceInput 不计入 widget 序列，密钥位置正确，模型名保留', () => {
  assert.deepEqual(widgetNames('LLM', info).map(w => w.name), ['api_key', 'model']);
  const g = {nodes: [{id: 1, type: 'LLM', inputs: [{name: 'prompt', link: 3}], widgets_values: [SECRET, 'gemma-4']}]};
  const hits = findSecretWidgets(g, {objectInfo: info});
  assert.deepEqual(hits.map(h => [h.key, h.name]), [[0, 'api_key']]);
  const ex = createGraphStoragePolicy({objectInfo: () => info}).stripForExport(g);
  assert.ok(!JSON.stringify(ex.graph).includes(SECRET), '密钥已移除');
  assert.equal(ex.graph.nodes[0].widgets_values[1], 'gemma-4', '模型名未被误删');
  assert.equal(ex.uncertain.length, 0);
});
test('RV02：seed 控制位 + 子图；转换为输入的 widget 仍占位', () => {
  const g = {nodes: [], definitions: {subgraphs: [{id: 's', nodes: [{id: 5, type: 'Seeded', inputs: [{name: 'text', widget: {name: 'text'}, link: 1}], widgets_values: [7, 'fixed', SECRET, '提示词 原文']}]}]}};
  const ex = createGraphStoragePolicy({objectInfo: () => info}).stripForExport(g);
  const wv = ex.graph.definitions.subgraphs[0].nodes[0].widgets_values;
  assert.deepEqual(wv, [7, 'fixed', '', '提示词 原文']);
});
test('RV02：位数与 object_info 不一致时不清空猜测位置，报告 uncertain；格式明显的密钥仍移除', () => {
  const g = {nodes: [{id: 1, type: 'LLM', widgets_values: ['额外', SECRET, 'gemma-4']}, {id: 2, type: 'LLM', widgets_values: ['x', 'sk-FICTIONAL0000000000000000', 'y']}]};
  const ex = createGraphStoragePolicy({objectInfo: () => info}).stripForExport(g);
  assert.deepEqual(ex.graph.nodes[0].widgets_values, ['额外', SECRET, 'gemma-4'], '不按猜测清空提示词/模型');
  assert.ok(ex.uncertain.some(u => u.nodeId === '1' && u.field === 'api_key'));
  assert.equal(ex.graph.nodes[1].widgets_values[1], '', '密钥格式仍可确定移除');
});
test('RV02：内部保存在位数不一致时仍引用化候选值（可还原，不丢数据）', t => {
  const d = tmp(t);
  const p = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'c.json'), safe()), objectInfo: () => info});
  const g = {nodes: [{id: 1, type: 'LLM', widgets_values: ['额外 文本', SECRET, 'gemma-4']}]};
  const disk = p.secureForStorage(g);
  assert.ok(!JSON.stringify(disk).includes(SECRET));
  assert.deepEqual(p.resolveInMemory(disk).graph, g);
});
test('RV02：离线首次保存——task-service 读取落盘的 object_info 缓存', t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'object-info-cache.json'), JSON.stringify({savedAt: 'x', data: info}));
  const {Database} = require('../desktop/repositories/database.cjs');
  const db = Database.open(path.join(d, 'y.sqlite')); t.after(() => db.close());
  const {createTaskService} = require('../desktop/services/task-service.cjs');
  const layout = {root: d, 'task-snapshots': path.join(d, 'snap'), references: path.join(d, 'refs')};
  const ts = createTaskService({db, layout, configRepo: {config: {comfy: {url: 'http://127.0.0.1:1/'}, queue: {maxBatch: 100}, output: {}}}, events: {emit() {}}, locks: {gpu: {run: f => f()}}, logger: null, editor: {}, fetchImpl: async () => { throw new Error('offline'); }});
  assert.deepEqual(ts.cachedObjectInfo(), info);
  const p = createGraphStoragePolicy({objectInfo: ts.cachedObjectInfo});
  const ex = p.stripForExport({nodes: [{id: 1, type: 'LLM', widgets_values: [SECRET, 'm']}]});
  assert.equal(ex.graph.nodes[0].widgets_values[0], '');
});
