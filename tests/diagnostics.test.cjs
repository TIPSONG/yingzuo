'use strict';
// T05–T07：实时清单（含离线缓存标注）、替代建议、单字段修复/复查/撤销。服务均为替身。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {collectCatalog, createDiagnosticsService} = require('../desktop/services/diagnostics-service.cjs');

const okClient = {
  objectInfo: async () => ({UnetLoaderGGUF: {python_module: 'custom_nodes.ComfyUI-GGUF'}, KSampler: {python_module: 'nodes'}, LMStudioPromptEnhancer: {python_module: 'custom_nodes.comfyui-lmstudio-prompt-enhancer.nodes'}}),
  models: async f => f ? {diffusion_models: ['qwen-image-2.1-Q6_K.gguf', 'qwen-image-2.1-Q4_K_M.gguf'], vae: ['qwen_vae.safetensors']}[f] ?? [] : ['diffusion_models', 'vae', 'configs'],
};
const lmFetch = async () => new Response(JSON.stringify({data: [{id: 'gemma4-12b'}, {id: 'text-embedding-x'}]}), {status: 200});
const offline = {objectInfo: async () => { throw new Error('ECONNREFUSED'); }, models: async () => { throw new Error('ECONNREFUSED'); }};
const downFetch = async () => { throw new Error('ECONNREFUSED'); };

test('T05：合并 object_info / 模型目录 / LM Studio，记录采集时间；离线时用缓存并标注', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-diag-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const cacheFile = path.join(d, 'c.json');
  const c = await collectCatalog({client: okClient, fetchImpl: lmFetch, lmUrl: 'http://127.0.0.1:1234/v1', cacheFile});
  assert.deepEqual(c.plugins.map(p => p.name).sort(), ['(内置)', 'ComfyUI-GGUF', 'comfyui-lmstudio-prompt-enhancer']);
  assert.equal(c.models.filter(m => m.role === 'diffusion').length, 2); assert.equal(c.models.filter(m => m.role === 'language').length, 1, '排除 embedding');
  assert.ok(c.sources.objectInfo.collectedAt);
  const off = await collectCatalog({client: offline, fetchImpl: downFetch, lmUrl: 'http://127.0.0.1:1234/v1', cacheFile});
  assert.equal(off.runtimeChecked, false); assert.equal(off.sources.objectInfo.cached, true); assert.equal(off.sources.objectInfo.collectedAt, c.sources.objectInfo.collectedAt);
  assert.equal(off.nodeTypes.length, 3); assert.equal(off.models.length, 4);
  const none = await collectCatalog({client: offline, fetchImpl: downFetch, lmUrl: 'http://x/v1', cacheFile: path.join(d, 'none.json')});
  assert.equal(none.nodeTypes.length, 0); assert.equal(none.sources.models.cached, false);
});
test('T06/T07：同架构候选可应用单字段修复、自动复查、撤销；被改动后拒绝撤销', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-diag-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const tab = {id: 'tab1', title: 'T', revision: 1, graph: {nodes: [{id: 1, type: 'UnetLoaderGGUF', widgets_values: ['qwen-image-2.1-Q8_0.gguf']}], links: []}};
  const editor = {workspace: {activeId: 'tab1', tabs: [tab]}, enqueue: f => f(), commands: {
    tabGraph: async () => ({tabId: tab.id, title: tab.title, graph: structuredClone(tab.graph)}),
    replaceGraph: async (_id, g, rev) => { if (rev !== undefined && rev !== tab.revision) throw new Error('版本不一致'); tab.graph = structuredClone(g); tab.revision++; return {revision: tab.revision}; },
  }};
  const svc = createDiagnosticsService({editor, client: () => okClient, fetchImpl: lmFetch, configRepo: {config: {lmstudio: {url: 'http://127.0.0.1:1234/v1'}}}, layout: {root: d}});
  const r = await svc.methods['templates.diagnose']('tab1');
  const issue = r.issues.find(i => i.code === 'not-in-catalog');
  assert.ok(issue, JSON.stringify(r.issues));
  const cand = issue.candidates.find(c => c.canApply);
  assert.ok(cand); assert.match(cand.label, /同架构|同名/);
  await assert.rejects(svc.methods['templates.applyFix']('tab1', issue.key, cand.id, 0), /版本不一致/);
  const applied = await svc.methods['templates.applyFix']('tab1', issue.key, cand.id, 1);
  assert.equal(applied.applied.before, 'qwen-image-2.1-Q8_0.gguf'); assert.equal(tab.graph.nodes[0].widgets_values[0], cand.value);
  assert.ok(!applied.recheck.issues.some(i => i.code === 'not-in-catalog'));
  await svc.methods['templates.undoFix']('tab1');
  assert.equal(tab.graph.nodes[0].widgets_values[0], 'qwen-image-2.1-Q8_0.gguf');
  await svc.methods['templates.applyFix']('tab1', issue.key, cand.id, tab.revision);
  tab.revision++; // 用户之后又改了图
  await assert.rejects(svc.methods['templates.undoFix']('tab1'), /不能直接撤销/);
});
