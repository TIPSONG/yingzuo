'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createMcpTools} = require('../desktop/services/mcp-tools.cjs');
const {createTemplateService} = require('../desktop/services/template-service.cjs');
const {createAssetsMethods} = require('../desktop/services/assets-api.cjs');
const {setup, prompt, info} = require('./review-helpers.cjs');

const body = result => JSON.parse(result.content[0].text);
const runArgs = {tabId: 'tab1', expectedRevision: 3};
function fixture(t, config) {
  const f = setup(t, config);
  const {editor, layout, configRepo, db} = f;
  const output = path.join(f.dir, 'output');
  fs.mkdirSync(output);
  editor.connected = true;
  editor.state = () => ({connected: editor.connected, activeId: 'tab1', tabs: editor.workspace.tabs});
  editor.workspace.tabs[0].title = 'Cats';
  configRepo.derived = () => ({output});
  const assetApi = createAssetsMethods({db, layout, configRepo, electron: {shell: {}}});
  const templates = createTemplateService({db, layout, editor, taskService: f.svc});
  const api = createMcpTools({editor, taskService: f.svc, templateService: templates, assetsMethods: assetApi, getOutputRoot: () => output});
  return {...f, api, templates, output, assetApi};
}
test('MCP projects saved template and open-tab summaries without workflow or source contents', async t => {
  const f = fixture(t);
  const tpl = f.templates.repo.create({name: 'Sketch', graph: {nodes: []}, source: 'private location'});
  f.editor.commands.openGraph = async (title, graph, templateId) => {
    assert.deepEqual(graph, {nodes: []});
    return {state: {activeId: 'fresh', tabs: [{id: 'fresh', title, templateId, revision: 0, graph}]}};
  };
  const list = body(await f.api.call('list_templates', {search: 'Sk'}));
  assert.deepEqual(list.templates, [{templateId: tpl.id, name: 'Sketch', currentVersion: tpl.currentVersion}]);
  const opened = body(await f.api.call('open_template', {templateId: tpl.id}));
  assert.deepEqual(opened, {tabId: 'fresh', title: 'Sketch', templateId: tpl.id, revision: 0});
  const workflows = body(await f.api.call('list_workflows'));
  assert.equal(workflows.workflows[0].tabId, 'tab1');
  assert.equal(workflows.activeTabId, 'tab1');
  assert.equal(workflows.connected, true);
  f.editor.connected = false;
  assert.equal(body(await f.api.call('get_workflow', {tabId: 'tab1'})).code, 'SERVICE_UNAVAILABLE');
});

test('MCP submits one validated immutable snapshot through the queue and returns only the task’s indexed image preview', async t => {
  const f = fixture(t);
  const {api, svc, submitted, settle} = f;
  const canvas = prompt(), before = structuredClone(canvas);
  f.editor.commands.compileTab = async tabId => ({tabId, title: 'Cats', revision: 3, uiGraph: {nodes: []}, apiPrompt: canvas});
  const wf = body(await api.call('get_workflow', {tabId: 'tab1'}));
  assert.ok(wf.parameters.includes('prompt') && wf.parameters.includes('width'));
  assert.equal(wf.revision, 3);
  assert.equal(JSON.stringify(wf).includes(canvas[3].inputs.prompt), false);
  const result = await api.call('run_workflow', {...runArgs, prompt: 'a cat with glasses', width: 640});
  assert.ok(!result.isError, JSON.stringify(result));
  const {taskId} = body(result);
  await settle();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].prompt['3'].inputs.prompt, 'a cat with glasses');
  assert.equal(submitted[0].prompt['6'].inputs.width, 640);
  assert.deepEqual(canvas, before);
  assert.equal(body(await api.call('get_task', {taskId})).state, 'succeeded');
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'icon-256.png'), path.join(f.output, 'a.png'));
  await f.assetApi['assets.linkTask'](taskId);
  const status = body(await api.call('get_task', {taskId}));
  assert.equal(status.outputs.length, 1);
  assert.equal(status.outputs[0].name, 'a.png');
  assert.ok(!JSON.stringify(status).includes(f.dir));
  const assetId = status.outputs[0].assetId;
  const image = await api.call('get_result_preview', {taskId, assetId});
  assert.equal(image.content[0].mimeType, 'image/webp', JSON.stringify(image));
  assert.equal(Buffer.from(image.content[0].data, 'base64').toString('ascii', 8, 12), 'WEBP');
  svc.queue.pause();
  const other = body(await api.call('run_workflow', runArgs));
  assert.equal(body(await api.call('get_result_preview', {taskId: other.taskId, assetId})).code, 'NOT_FOUND');
  fs.appendFileSync(path.join(f.output, 'a.png'), 'changed');
  assert.equal(body(await api.call('get_result_preview', {taskId, assetId})).code, 'CONFLICT');
});

test('MCP rejects unsupported or ambiguous overrides, credential bindings and stale revisions before queueing', async t => {
  const data = structuredClone(info);
  data.LMStudioPromptEnhancer.input.required.prompt = ['STRING', {sensitive: true}];
  const f = fixture(t, {info: data});
  const wf = body(await f.api.call('get_workflow', {tabId: 'tab1'}));
  assert.ok(!wf.parameters.includes('prompt'));
  for (const args of [{...runArgs, prompt: 'ordinary text'}, {...runArgs, steps: '3'}, {...runArgs, unexpected: true},
    {tabId: 'tab1', expectedRevision: 2}]) {
    assert.ok((await f.api.call('run_workflow', args)).isError);
  }
  assert.deepEqual(f.svc.tasks.list(), []);
  const other = fixture(t);
  assert.equal(body(await other.api.call('run_workflow', {...runArgs, prompt: 'day', negative: 'night'})).code, 'CONFLICT');
  assert.deepEqual(other.svc.tasks.list(), []);
});

test('MCP rechecks access and revision after compilation, and never exposes internal errors', async t => {
  const f = fixture(t);
  let enabled = true;
  const compile = f.editor.commands.compileTab;
  f.editor.commands.compileTab = async tabId => { enabled = false; return compile(tabId); };
  const result = await f.api.call('run_workflow', runArgs, {assertActive() {
    if (!enabled) throw Object.assign(new Error('internal token detail'), {code: 'FORBIDDEN'});
  }});
  assert.equal(body(result).code, 'FORBIDDEN');
  assert.ok(!JSON.stringify(result).includes('internal token detail'));
  f.editor.commands.compileTab = async tabId => { f.editor.connected = false; return compile(tabId); };
  assert.equal(body(await f.api.call('run_workflow', runArgs)).code, 'SERVICE_UNAVAILABLE');
  f.editor.connected = true;
  f.editor.commands.compileTab = async tabId => { f.editor.workspace.tabs[0].revision++; return compile(tabId); };
  assert.equal(body(await f.api.call('run_workflow', runArgs)).code, 'REVISION_MISMATCH');
  assert.deepEqual(f.svc.tasks.list(), []);
});
