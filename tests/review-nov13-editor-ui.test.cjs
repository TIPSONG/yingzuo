'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {Database} = require('../desktop/repositories/database.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {createTemplateService} = require('../desktop/services/template-service.cjs');
const {createDiagnosticsService} = require('../desktop/services/diagnostics-service.cjs');
const source = fs.readFileSync(path.join(__dirname, '../desktop/ui/templates.js'), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
const ipc = fn => async (...args) => { try { return {ok: true, data: await fn(...args)}; } catch (e) { return {ok: false, error: {code: e.code, message: e.message}}; } };
function ui(templates, current, modal) {
  const handlers = new Map(), elements = new Map(), errors = [];
  const document = {querySelector: s => { if (!elements.has(s)) elements.set(s, {addEventListener: (type, fn) => handlers.set(`${s}:${type}`, fn)}); return elements.get(s); }};
  vm.runInNewContext(source, {window: {yingzuo: {templates}, yzShell: {
    esc: x => String(x ?? ''), toast: () => {}, swallow: e => errors.push(e), modal,
    call: async promise => { const r = await promise; if (!r.ok) throw Object.assign(new Error(r.error.message), r.error); return r.data; },
  }}, document, current, setTimeout, clearTimeout});
  return {handlers, errors};
}
function formModal() {
  let opened;
  const ready = new Promise(r => { opened = r; });
  const handlers = new Map(), nodes = new Map();
  const label = {dataset: {k: 'label'}, value: 'My unsaved label', disabled: false};
  const controls = [label, {disabled: false}, {disabled: false}];
  const m = {ready, closed: false};
  const back = {
    querySelector: s => { if (!nodes.has(s)) nodes.set(s, {textContent: '', hidden: true}); return nodes.get(s); },
    querySelectorAll: s => s === '[data-i]' ? [{dataset: {i: '0'}, querySelectorAll: () => [label]}] : controls,
    addEventListener: (type, fn) => handlers.set(type, fn),
  };
  m.modal = (_html, onReady) => new Promise(resolve => {
    m.done = value => { m.closed = true; resolve(value); };
    onReady(back, m.done); opened();
  });
  m.click = action => handlers.get('click')({target: {closest: () => ({dataset: {x: action}})}});
  return m;
}
function templateFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ui-form-')), layout = ensureLayout(dir), db = Database.open(layout.database);
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  let tplId, v1;
  const graph = {nodes: []}, prompt = {'7': {class_type: 'KSampler', inputs: {steps: 20}}};
  const editor = {enqueue: f => f(), commands: {
    tabGraph: async () => ({tabId: 'tab1', title: 'Test', templateId: tplId, templateVersionId: v1, graph}), setTemplateVersion: async () => {},
  }};
  const svc = createTemplateService({db, layout, editor, taskService: {compile: async () => ({templateId: tplId, templateVersionId: v1, apiPrompt: prompt, bindings: {}})}, dialog: {}, getWindow: () => null});
  const field = {scopePath: [], nodeId: '7', nodeType: 'KSampler', fieldName: 'steps', widgetType: 'int', constraints: {}, label: 'Original label', group: 'Sampling', order: 0};
  tplId = svc.repo.create({name: 'Template', graph, formSchema: [field]}).id; v1 = svc.repo.current(tplId).versionId;
  const calls = [], templates = Object.fromEntries(['formDraft', 'saveForm', 'saveFromTab'].map(name => [name, ipc((...args) => { calls.push({name, args}); return svc.methods[`templates.${name}`](...args); })]));
  const current = {activeId: 'tab1', tabs: [{id: 'tab1', title: 'Test', templateId: tplId}]};
  return {svc, templates, current, calls, tplId, v1, field, graph};
}

test('form UI preserves edits when another save updates the latest version while its modal is open', async t => {
  const f = templateFixture(t), modal = formModal();
  t.after(() => modal.done?.(false));
  const app = ui(f.templates, f.current, modal.modal);
  const running = app.handlers.get('#tpl-form:click')(); await modal.ready;
  assert.equal(f.svc.repo.current(f.tplId).versionId, f.v1, 'form opens against the current latest version');
  const newer = f.svc.repo.saveVersion(f.tplId, {graph: f.graph, formSchema: [{...f.field, label: 'Concurrent label'}]});
  await modal.click('yes'); await tick();
  assert.equal(f.svc.repo.current(f.tplId).versionId, newer.versionId, 'stale form must not replace the newer template');
  assert.equal(modal.closed, false, 'conflict must keep the editing modal open');
  assert.equal(f.calls.find(c => c.name === 'saveForm').args[4].baseVersionId, f.v1);
  await modal.click('copy'); await running;
  const copies = f.svc.repo.list().filter(x => x.id !== f.tplId);
  assert.equal(copies.length, 1);
  assert.equal(f.svc.repo.current(copies[0].id).formSchema[0].label, 'My unsaved label');
  assert.equal(f.svc.repo.current(f.tplId).formSchema[0].label, 'Concurrent label');
});

test('form UI retains input after a transient save failure and can retry in the same modal', async t => {
  const f = templateFixture(t), modal = formModal(); t.after(() => modal.done?.(false));
  const save = f.templates.saveForm; let failures = 1;
  f.templates.saveForm = (...a) => failures-- > 0 ? Promise.resolve({ok: false, error: {code: 'DISK_SPACE', message: 'disk full'}}) : save(...a);
  const app = ui(f.templates, f.current, modal.modal), running = app.handlers.get('#tpl-form:click')(); await modal.ready;
  await modal.click('yes'); await tick();
  assert.equal(modal.closed, false);
  await modal.click('yes'); await running;
  assert.equal(f.svc.repo.current(f.tplId).formSchema[0].label, 'My unsaved label');
});

test('diagnostics UI uses the displayed revision and refreshes after a concurrent model edit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ui-diag-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const tab = {id: 'tab1', title: 'T', revision: 1, graph: {nodes: [{id: 1, type: 'UnetLoaderGGUF', widgets_values: ['qwen-image-2.1-Q8_0.gguf']}], links: []}};
  const editor = {workspace: {activeId: tab.id, tabs: [tab]}, enqueue: f => f(), commands: {
    tabGraph: async () => ({tabId: tab.id, title: tab.title, graph: structuredClone(tab.graph)}),
    replaceGraph: async (_id, graph, rev) => { if (rev !== tab.revision) throw new Error('revision mismatch'); tab.graph = graph; return {revision: ++tab.revision}; },
  }};
  let collections = 0;
  const client = {objectInfo: async () => { if (++collections === 1) { tab.graph.nodes[0].widgets_values[0] = 'qwen-image-2.1-Q5_K.gguf'; tab.revision++; } return {UnetLoaderGGUF: {python_module: 'nodes'}}; }, models: async folder => folder ? ['qwen-image-2.1-Q6_K.gguf'] : ['diffusion_models']};
  const svc = createDiagnosticsService({editor, client: () => client, fetchImpl: async () => new Response(JSON.stringify({data: []})), configRepo: {config: {lmstudio: {url: 'http://localhost:1234/v1'}}}, layout: {root}});
  let diagnosed, sent, modals = 0; const shown = [];
  const templates = {
    diagnose: ipc(async (...a) => diagnosed = await svc.methods['templates.diagnose'](...a)),
    applyFix: ipc(async (...a) => { sent = a[3]; return svc.methods['templates.applyFix'](...a); }),
  };
  const app = ui(templates, {activeId: tab.id, tabs: [tab]}, async html => {
    shown.push(html); if (++modals > 1) return {x: 'close'};
    const issue = diagnosed.issues.find(i => i.code === 'not-in-catalog');
    return {fix: issue.key, cand: issue.candidates.find(c => c.canApply).id};
  });
  await app.handlers.get('#diag:click')();
  assert.equal(sent, 1);
  assert.equal(tab.graph.nodes[0].widgets_values[0], 'qwen-image-2.1-Q5_K.gguf');
  assert.equal(collections, 2, 'conflict must refresh the diagnosis');
  assert.match(shown[1], /qwen-image-2.1-Q5_K/);
});
