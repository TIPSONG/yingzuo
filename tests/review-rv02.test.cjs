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
test('RR02：位数不一致时整次导出失败，不能带着 uncertain 输出明文', () => {
  const g = {nodes: [{id: 1, type: 'LLM', widgets_values: ['额外', SECRET, 'gemma-4']}, {id: 2, type: 'LLM', widgets_values: ['x', 'sk-FICTIONAL0000000000000000', 'y']}]};
  const p = createGraphStoragePolicy({objectInfo: () => info});
  assert.throws(() => p.stripForExport(g), e => e.code === 'INVALID_STATE' && e.details.uncertain.length === 2);
  assert.deepEqual(g.nodes[0].widgets_values, ['额外', SECRET, 'gemma-4'], '保留内存原图供用户校正');
});
test('RR01：位数不一致时阻止保存，不再将普通模型名称猜成凭据', t => {
  const d = tmp(t);
  const p = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'c.json'), safe()), objectInfo: () => info});
  const g = {nodes: [{id: 1, type: 'LLM', widgets_values: ['额外 文本', SECRET, 'gemma-4']}]};
  assert.throws(() => p.secureForStorage(g), e => e.code === 'INVALID_STATE');
  assert.equal(fs.existsSync(path.join(d, 'c.json')), false);
  assert.equal(g.nodes[0].widgets_values[2], 'gemma-4');
});
test('RV02：离线首次保存——task-service 读取落盘的 object_info 缓存', t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'object-info-cache.json'), JSON.stringify({savedAt: 'x', data: info}));
  const {Database} = require('../desktop/repositories/database.cjs');
  const db = Database.open(path.join(d, 'y.sqlite'));
  try {
  const {createTaskService} = require('../desktop/services/task-service.cjs');
  const layout = {root: d, 'task-snapshots': path.join(d, 'snap'), references: path.join(d, 'refs')};
  const ts = createTaskService({db, layout, configRepo: {config: {comfy: {url: 'http://127.0.0.1:1/'}, queue: {maxBatch: 100}, output: {}}}, events: {emit() {}}, locks: {gpu: {run: f => f()}}, logger: null, editor: {}, fetchImpl: async () => { throw new Error('offline'); }});
  assert.deepEqual(ts.cachedObjectInfo(), info);
  const p = createGraphStoragePolicy({objectInfo: ts.cachedObjectInfo});
  const ex = p.stripForExport({nodes: [{id: 1, type: 'LLM', widgets_values: [SECRET, 'm']}]});
  assert.equal(ex.graph.nodes[0].widgets_values[0], '');
  } finally { db.close(); } // Windows：先关库再删临时目录（after 钩子按登记顺序执行，删目录在前）
});
