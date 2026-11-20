'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createDiagnosticsService} = require('../desktop/services/diagnostics-service.cjs');
const {parseExtraModelPaths, buildFolderMap, scanModels} = require('../desktop/resources/model-scan.cjs');

function fixture(t, {objectInfo} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-issue6-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const tab = {id: 'tab', title: 'Test', revision: 1, graph: {nodes: [
    {id: 1, type: 'UnetLoaderGGUF', widgets_values: ['qwen-image-2.1-Q8_0.gguf']},
    {id: 2, type: 'UnetLoaderGGUF', widgets_values: ['qwen-image-2.1-Q8_0.gguf']},
  ], links: []}};
  const editor = {workspace: {activeId: tab.id, tabs: [tab]}, enqueue: fn => fn(), commands: {
    tabGraph: async () => ({tabId: tab.id, title: tab.title, graph: structuredClone(tab.graph)}),
    replaceGraph: async (_id, graph, revision) => {
      if (revision !== undefined && revision !== tab.revision) throw new Error('版本不一致');
      tab.graph = structuredClone(graph); return {revision: ++tab.revision};
    },
  }};
  const client = {objectInfo: objectInfo ?? (async () => ({UnetLoaderGGUF: {python_module: 'nodes'}})), models: async folder => folder ? ['qwen-image-2.1-Q6_K.gguf'] : ['diffusion_models']};
  const svc = createDiagnosticsService({editor, client: () => client, fetchImpl: async () => new Response(JSON.stringify({data: []})), configRepo: {config: {lmstudio: {url: 'http://localhost:1234/v1'}}}, layout: {root}});
  return {root, tab, methods: svc.methods};
}
const missing = result => result.issues.find(i => i.code === 'not-in-catalog');
async function fixOne(methods, tab) {
  const diagnosed = await methods['templates.diagnose'](tab.id), issue = missing(diagnosed), candidate = issue.candidates.find(c => c.canApply);
  return methods['templates.applyFix'](tab.id, issue.key, candidate.id, diagnosed.revision);
}

test('Issue 6: diagnosis keeps the revision of its graph while catalog collection is pending', async t => {
  let release, started;
  const waiting = new Promise(r => { started = r; });
  const {methods, tab} = fixture(t, {objectInfo: async () => { started(); return new Promise(r => { release = r; }); }});
  const request = methods['templates.diagnose'](tab.id);
  await waiting;
  tab.graph.nodes[0].widgets_values[0] = 'user-change.gguf'; tab.revision++;
  release({UnetLoaderGGUF: {python_module: 'nodes'}});
  const result = await request;
  assert.equal(result.revision, 1, 'old graph diagnosis must not advertise the newer editable revision');
  const issue = missing(result), candidate = issue.candidates.find(c => c.canApply);
  await assert.rejects(methods['templates.applyFix'](tab.id, issue.key, candidate.id, result.revision), /版本不一致|不再|变化|候选|不存在/);
  assert.equal(tab.graph.nodes[0].widgets_values[0], 'user-change.gguf');
});

test('Issue 6: consecutive model fixes can both be undone without stale revision conflicts', async t => {
  const {methods, tab} = fixture(t), original = structuredClone(tab.graph);
  await fixOne(methods, tab);
  const afterFirst = structuredClone(tab.graph);
  await fixOne(methods, tab);
  const firstUndo = await methods['templates.undoFix'](tab.id);
  assert.equal(firstUndo.canUndo, true); assert.deepEqual(tab.graph, afterFirst);
  const secondUndo = await methods['templates.undoFix'](tab.id);
  assert.equal(secondUndo.canUndo, false); assert.deepEqual(tab.graph, original);
});

test('Issue 6: applying a fix without a caller revision still rejects edits during catalog refresh', async t => {
  const {methods: originalMethods, tab: originalTab} = fixture(t);
  const issue = missing(await originalMethods['templates.diagnose'](originalTab.id));
  const candidate = issue.candidates.find(c => c.canApply);
  let release, started;
  const waiting = new Promise(r => { started = r; });
  const {methods, tab} = fixture(t, {objectInfo: async () => { started(); return new Promise(r => { release = r; }); }});
  const request = methods['templates.applyFix'](tab.id, issue.key, candidate.id);
  await waiting;
  tab.graph.nodes[1].title = 'keep user edit'; tab.revision++;
  release({UnetLoaderGGUF: {python_module: 'nodes'}});
  await assert.rejects(request, /版本不一致/);
  assert.equal(tab.graph.nodes[1].title, 'keep user edit');
  assert.equal(tab.graph.nodes[0].widgets_values[0], 'qwen-image-2.1-Q8_0.gguf');
});

test('Issue 6: undoing a later fix cannot erase edits made between two fixes', async t => {
  const {methods, tab} = fixture(t);
  await fixOne(methods, tab);
  tab.graph.nodes[0].title = 'user title'; tab.revision++;
  const beforeSecond = structuredClone(tab.graph);
  await fixOne(methods, tab);
  const result = await methods['templates.undoFix'](tab.id);
  assert.equal(result.canUndo, false);
  await assert.rejects(methods['templates.undoFix'](tab.id), /没有可撤销|不能直接撤销/);
  assert.deepEqual(tab.graph, beforeSecond);
});

test('Issue 6: extra model directories resolve against base_path regardless of YAML key order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-extra-path-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const text = 'external:\n  loras: |\n    loras\n    loras2\n  vae: vae\n  base_path: ../weights\nsecond:\n  checkpoints: checkpoints\n  base_path: ../other\n';
  const yamlDir = path.join(root, 'config'), modelDir = path.join(root, 'weights', 'loras');
  fs.mkdirSync(yamlDir, {recursive: true}); fs.mkdirSync(modelDir, {recursive: true});
  fs.writeFileSync(path.join(modelDir, 'style.gguf'), 'fixture');
  fs.writeFileSync(path.join(yamlDir, 'extra_model_paths.yaml'), text);
  const result = parseExtraModelPaths(text, yamlDir);
  assert.deepEqual(result.loras, [modelDir, path.join(root, 'weights', 'loras2')]);
  assert.deepEqual(result.vae, [path.join(root, 'weights', 'vae')]);
  assert.deepEqual(result.checkpoints, [path.join(root, 'other', 'checkpoints')]);
  const models = scanModels({folderMap: buildFolderMap({extraModelPaths: path.join(yamlDir, 'extra_model_paths.yaml')})});
  assert.deepEqual(models.items.map(m => m.name), ['style.gguf']);
});
