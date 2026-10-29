'use strict';
// RV01：脱敏后的草稿哈希必须对应磁盘内容；重启后可读、篡改仍拒绝；旧错配只在能核实时接受。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../desktop/workspace-store.cjs');
const {createGraphStoragePolicy} = require('../shared/graph-storage-policy.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');

const KEY = 'sk-FICTIONALrv01KEY000000000';
const safe = () => ({isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: s => Buffer.from(`enc:${s}`), decryptString: b => b.toString().slice(4)});
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv01-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const objectInfo = {MyLLM: {input: {required: {prompt: ['STRING', {multiline: true}], api_key: ['STRING', {password: true}]}}}};
const graph = (txt) => ({nodes: [{id: 1, type: 'MyLLM', widgets_values: [txt, KEY]}], definitions: {subgraphs: [{id: 's', nodes: [{id: 2, type: 'MyLLM', widgets_values: ['子图', KEY]}]}]}});
const ws = () => ({version: 2, activeId: 'a', tabs: [{id: 'a', title: 'A', mode: 'graph', graph: graph('一')}, {id: 'b', title: 'B', mode: 'graph', graph: {nodes: [{id: 9, type: 'CLIPTextEncode', widgets_values: ['普通']}]}}]});

test('RV01：脱敏保存后新实例可重开，内存还原密钥，磁盘无明文', t => {
  const d = tmp(t); const file = path.join(d, 'workspace.json');
  const p = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'c.json'), safe()), objectInfo: () => objectInfo});
  Store.writeWorkspace(file, ws(), {secureGraph: p.secureForStorage});
  assert.ok(!fs.readFileSync(path.join(d, 'drafts', 'a.json'), 'utf8').includes(KEY));
  const back = Store.readWorkspace(file); // 新实例：不需要凭据即可通过完整性检查
  assert.equal(back.tabs.length, 2);
  const mem = p.resolveInMemory(back.tabs[0].graph);
  assert.equal(mem.graph.nodes[0].widgets_values[1], KEY);
  assert.equal(mem.graph.definitions.subgraphs[0].nodes[0].widgets_values[1], KEY);
  assert.equal(mem.missing.length, 0);
});
test('RV01：缺凭据时仍可读取（占位保留并列出），真正篡改仍被拒绝', t => {
  const d = tmp(t); const file = path.join(d, 'workspace.json');
  const p = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'c.json'), safe()), objectInfo: () => objectInfo});
  Store.writeWorkspace(file, ws(), {secureGraph: p.secureForStorage});
  const fresh = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'other.json'), safe())});
  const back = Store.readWorkspace(file);
  assert.equal(fresh.resolveInMemory(back.tabs[0].graph).missing.length, 2);
  const draft = path.join(d, 'drafts', 'a.json');
  const g = JSON.parse(fs.readFileSync(draft, 'utf8')); g.nodes[0].widgets_values[0] = '被篡改'; fs.writeFileSync(draft, JSON.stringify(g));
  assert.throws(() => Store.readWorkspace(file), /校验不一致/);
  assert.throws(() => Store.readWorkspace(file, {resolveGraph: x => p.resolveInMemory(x).graph}), /校验不一致/);
  assert.ok(fs.existsSync(draft), '原文件保留');
});
test('RV01：旧版本错配索引（按内存图哈希）只有凭据能核实时接受', t => {
  const d = tmp(t); const file = path.join(d, 'workspace.json');
  const p = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'c.json'), safe()), objectInfo: () => objectInfo});
  const w = ws();
  Store.writeWorkspace(file, w, {secureGraph: p.secureForStorage});
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  idx.tabs[0].graphHash = Store.graphHash(w.tabs[0].graph); // 模拟 d5cca17 之前写入的索引
  fs.writeFileSync(file, JSON.stringify(idx));
  assert.throws(() => Store.readWorkspace(file), /校验不一致/);
  const ok = Store.readWorkspace(file, {resolveGraph: x => p.resolveInMemory(x).graph});
  assert.equal(p.resolveInMemory(ok.tabs[0].graph).graph.nodes[0].widgets_values[1], KEY);
  const other = createGraphStoragePolicy({credentials: new CredentialStore(path.join(d, 'other.json'), safe())});
  assert.throws(() => Store.readWorkspace(file, {resolveGraph: x => other.resolveInMemory(x).graph}), /校验不一致/, '无法核实时仍报错');
  // 再保存一次后索引被改写为磁盘哈希
  Store.writeWorkspace(file, {...ok, tabs: ok.tabs.map(tb => ({...tb, graph: p.resolveInMemory(tb.graph).graph}))}, {secureGraph: p.secureForStorage});
  assert.equal(Store.readWorkspace(file).tabs.length, 2);
});
