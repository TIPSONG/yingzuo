'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createDiagnosticsService} = require('../desktop/services/diagnostics-service.cjs');

const firstModel = 'qwen-image-2.1-Q6_K.gguf', secondModel = 'qwen-image-2.1-Q5_K.gguf';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-diagnostics-scope-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const config = {comfy: {url: 'http://127.0.0.1:8188/', root: 'install-a'}, lmstudio: {url: 'http://127.0.0.1:1234/v1'}};
  const backend = {comfyOnline: true, lmOnline: true, readings: 0};
  const graph = {nodes: [{id: 1, type: 'UnetLoaderGGUF', widgets_values: ['qwen-image-2.1-Q8_0.gguf']}], links: []};
  const editor = {workspace: {tabs: [{id: 't', revision: 1}]}, enqueue: fn => fn(), commands: {
    tabGraph: async () => ({tabId: 't', graph: structuredClone(graph)}),
    replaceGraph: async () => { backend.replaced = true; return {revision: 2}; },
  }};
  function open() {
    return createDiagnosticsService({layout: {root}, configRepo: {config}, editor,
      client: () => {
        const model = config.comfy.url.includes('8188') ? firstModel : secondModel;
        return {
          objectInfo: async () => {
            backend.readings++;
            if (backend.hold) await backend.hold();
            if (!backend.comfyOnline) throw Error('offline');
            return {UnetLoaderGGUF: {python_module: 'nodes'}};
          },
          models: async folder => { if (!backend.comfyOnline) throw Error('offline'); return folder ? [model] : ['diffusion_models']; },
        };
      },
      fetchImpl: async url => {
        if (!backend.lmOnline) throw Error('offline');
        return new Response(JSON.stringify({data: [{id: 'gemma-' + url.port}]}));
      },
    });
  }
  return {config, backend, editor, file: path.join(root, 'diagnostics-cache.json'), open};
}
const values = catalog => catalog.models.map(model => model.value);

test('changing ComfyUI invalidates in-memory replacement candidates even without refreshing', async t => {
  const s = fixture(t), {methods} = s.open();
  const issue = (await methods['templates.diagnose']('t')).issues.find(i => i.code === 'not-in-catalog');
  const oldCandidate = issue.candidates.find(c => c.value === firstModel);
  s.config.comfy.url = 'http://127.0.0.1:8190/';
  await assert.rejects(methods['templates.applyFix']('t', issue.key, oldCandidate.id, 1), e => e.code === 'CONFLICT');
  assert.equal(s.backend.replaced, undefined);
  assert.deepEqual(values(await methods['templates.catalog']()), [secondModel, 'gemma-1234']);
  assert.equal(s.backend.readings, 2);
});

test('disk cache is independent per endpoint and excludes unscoped legacy data', async t => {
  const s = fixture(t);
  await s.open().collectCatalog();
  s.config.lmstudio.url = 'http://127.0.0.1:1235/v1/';
  s.backend.comfyOnline = false; s.backend.lmOnline = false;
  const changedLm = await s.open().collectCatalog();
  assert.deepEqual(values(changedLm), [firstModel]);
  assert.equal(changedLm.sources.models.cached, true);
  assert.equal(changedLm.sources.lmstudio.cached, false);
  assert.match(changedLm.models[0].evidence, /缓存/);
  s.config.lmstudio.url = 'http://127.0.0.1:1234/v1/';
  s.config.comfy.root = 'install-b';
  const changedRoot = await s.open().collectCatalog();
  assert.deepEqual(values(changedRoot), ['gemma-1234']);
  assert.equal(changedRoot.sources.objectInfo.cached, false);
  assert.deepEqual(changedRoot.nodeTypes, []);
  const legacy = JSON.parse(fs.readFileSync(s.file)); delete legacy.environment;
  fs.writeFileSync(s.file, JSON.stringify(legacy));
  const unscoped = await s.open().collectCatalog();
  assert.deepEqual(unscoped.models, []); assert.deepEqual(unscoped.nodeTypes, []);
  assert.equal(unscoped.sources.lmstudio.cached, false);
});

test('a slow collection cannot replace a newer endpoint result on disk or in memory', async t => {
  const s = fixture(t), service = s.open();
  let release;
  s.backend.hold = () => new Promise(r => { release = r; });
  const old = service.collectCatalog(true);
  delete s.backend.hold;
  s.config.comfy.url = 'http://127.0.0.1:8190/';
  const current = await service.collectCatalog();
  assert.equal(current.models[0].value, secondModel);
  release();
  await assert.rejects(old, e => e.code === 'CONFLICT');
  assert.equal((await service.collectCatalog()).models[0].value, secondModel);
  s.backend.comfyOnline = false;
  assert.equal((await s.open().collectCatalog()).models[0].value, secondModel);
});

test('an environment switch while a repair waits for the editor rejects the stale replacement', async t => {
  const s = fixture(t), {methods} = s.open();
  const issue = (await methods['templates.diagnose']('t')).issues.find(i => i.code === 'not-in-catalog');
  const candidate = issue.candidates.find(c => c.value === firstModel);
  let release, waiting;
  const queued = new Promise(r => { waiting = r; });
  let operations = 0;
  s.editor.enqueue = fn => ++operations === 1 ? fn() : new Promise(r => { release = r; waiting(); }).then(fn);
  const applying = methods['templates.applyFix']('t', issue.key, candidate.id, 1);
  await queued;
  s.config.comfy.url = 'http://127.0.0.1:8190/'; release();
  await assert.rejects(applying, e => e.code === 'CONFLICT');
  assert.equal(s.backend.replaced, undefined);
});
