'use strict';
// RR06: real resources.quickUse -> compile -> enqueueCompiled, with persisted template forms.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setup} = require('./review-helpers.cjs');
const {TemplateRepository} = require('../desktop/repositories/template-repo.cjs');
const {createMaintenanceService} = require('../desktop/services/maintenance-service.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');

const modelInfo = () => ({
  UnetLoaderGGUF: {input: {required: {unet_name: [['old.gguf', 'valid.gguf']]}}, output: ['MODEL']},
  KSampler: {input: {required: {model: ['MODEL'], steps: ['INT', {min: 1, max: 1000}]}}, output: ['IMAGE']},
  SaveImage: {input: {required: {images: ['IMAGE'], filename_prefix: ['STRING']}}, output: [], output_node: true},
});
const stepsField = {scopePath: [], nodeId: '2', nodeType: 'KSampler', fieldName: 'steps', widgetType: 'int', constraints: {min: 1, max: 30}, label: '步数', group: '采样', order: 0, defaultValue: 20};

async function fixture(t, {fields = [stepsField]} = {}) {
  const defs = modelInfo(), s = setup(t, {info: defs});
  s.svc.queue.pause(); // Keep successful registrations deterministic; explicitly resume only for the running case.
  const state = {steps: 20, revision: 3, dangling: false};
  const apiPrompt = () => ({
    1: {class_type: 'UnetLoaderGGUF', inputs: {unet_name: 'old.gguf'}},
    2: {class_type: 'KSampler', inputs: {model: [state.dangling ? 'gone' : '1', 0], steps: state.steps}},
    3: {class_type: 'SaveImage', inputs: {images: ['2', 0], filename_prefix: 'ComfyUI'}},
  });
  const graph = {nodes: [{id: 1, type: 'UnetLoaderGGUF'}, {id: 2, type: 'KSampler'}, {id: 3, type: 'SaveImage'}]};
  const repo = new TemplateRepository(s.db, s.layout.templates);
  const template = repo.create({name: 'RR06 saved form', graph, formSchema: fields});
  s.svc.setTemplateRepo(repo);
  s.svc.setFormProvider((id, versionId) => { const v = versionId ? repo.version(versionId) : repo.current(id); return {versionId: v.versionId, fields: v.formSchema, pinned: !!versionId}; });
  s.editor.commands.compileTab = async id => ({tabId: id, templateId: template.id, templateVersionId: template.currentVersion, title: 'Quick use test', revision: state.revision, uiGraph: structuredClone(graph), apiPrompt: apiPrompt()});
  const root = path.join(s.dir, 'ComfyUI'), modelDir = path.join(root, 'models', 'diffusion_models');
  fs.mkdirSync(modelDir, {recursive: true});
  for (const name of ['valid.gguf', 'unlisted.gguf']) fs.writeFileSync(path.join(modelDir, name), Buffer.from('GGUF\x03\x00\x00\x00'));
  s.configRepo.config.comfy.root = root; s.configRepo.derived = () => ({backups: path.join(s.dir, 'backups')});
  const maintenance = createMaintenanceService({db: s.db, layout: s.layout, configRepo: s.configRepo, locks: createLocks(), events: {emit() {}}, comfy: {verifyOwned: async () => false}, taskService: s.svc, templateRepo: repo, editor: s.editor, fetchImpl: async () => { throw new Error('unused'); }});
  const scan = await maintenance.methods['resources.scan']();
  const resources = Object.fromEntries(scan.items.map(r => [r.name, r]));
  for (const r of Object.values(resources)) await maintenance.methods['resources.setNote'](r.id, {architecture: 'qwen-image'});
  const preview = (name = 'valid.gguf') => maintenance.methods['resources.quickUse'](resources[name].id, 'tab1', {});
  const run = async (name = 'valid.gguf', expectedRevision = state.revision) => maintenance.methods['resources.quickUse'](resources[name].id, 'tab1', {run: true, expectedRevision});
  const count = () => s.db.get('SELECT COUNT(*) n FROM tasks').n;
  return {...s, state, defs, repo, template, apiPrompt, maintenance, preview, run, count};
}

test('RR06: saved custom form range rejects quickUse before any task registration', async t => {
  const f = await fixture(t); f.state.steps = 99;
  assert.equal((await f.preview()).available, true);
  await assert.rejects(f.run(), /不能大于 30/);
  assert.equal(f.count(), 0); assert.equal(f.submitted.length, 0);
});

test('RR06: stale saved form mapping rejects quickUse with zero tasks', async t => {
  const f = await fixture(t, {fields: [{...stepsField, nodeId: 'missing'}]});
  await assert.rejects(f.run(), /映射失效/); assert.equal(f.count(), 0);
});

test('RR06: model enumeration and broken final graph reject quickUse with zero tasks', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('unlisted.gguf'), /不在可选项中/); assert.equal(f.count(), 0);
  f.state.dangling = true;
  await assert.rejects(f.run(), /连接到不存在的节点 gone/); assert.equal(f.count(), 0);
});

test('RR06: valid quickUse pins revision, persists actual form values and executes replacement', async t => {
  const f = await fixture(t); const plan = await f.preview();
  f.state.revision++;
  await assert.rejects(f.run('valid.gguf', plan.revision), e => e.code === 'REVISION_MISMATCH'); assert.equal(f.count(), 0);
  const {task} = await f.run(); assert.equal(f.count(), 1);
  const snapshot = f.svc.tasks.snapshotOf(f.svc.tasks.get(task.id));
  assert.equal(snapshot.apiPrompt[1].inputs.unet_name, 'valid.gguf'); assert.equal(snapshot.form.values[0], 20);
  assert.equal(snapshot.form.versionId, f.template.currentVersion); assert.equal(f.svc.tasks.get(task.id).inputRevision, f.state.revision);
  f.svc.queue.resume(); await f.settle();
  assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].prompt[1].inputs.unet_name, 'valid.gguf');
  assert.equal(f.svc.tasks.get(task.id).state, 'succeeded');
});

test('RR06: quickUse keeps reference availability checks, no task is created when a saved reference is missing', async t => {
  const f = await fixture(t);
  await f.svc.methods['tasks.setRefs']('tab1', [{nodeId: '2', input: 'image', refId: 'a'.repeat(64) + '.png', name: 'reference.png'}]);
  await assert.rejects(f.run(), /参考图文件已丢失：reference\.png/); assert.equal(f.count(), 0);
});

test('RR06: enqueueCompiled stays synchronous and validates using the definitions captured by its compilation', async t => {
  const f = await fixture(t); const first = await f.svc.compile('tab1');
  assert.ok(first.objectInfo.UnetLoaderGGUF);
  const final = structuredClone(first.apiPrompt); final[1].inputs.unet_name = 'valid.gguf';
  // Expire and replace the global cache after this context was compiled.
  f.defs.UnetLoaderGGUF.input.required.unet_name = [['old.gguf']];
  const later = Date.now() + 61000; t.mock.method(Date, 'now', () => later);
  const second = await f.svc.compile('tab1');
  assert.notDeepEqual(first.objectInfo, second.objectInfo);
  assert.throws(() => f.svc.submissions.enqueueCompiled(second, final), /不在可选项中/); assert.equal(f.count(), 0);
  const task = f.svc.submissions.enqueueCompiled(first, final);
  assert.equal(typeof task?.then, 'undefined'); assert.ok(task.id); assert.equal(f.count(), 1);
});

test('RR06: final structural checks reject an inserted unsupported node before enqueue', async t => {
  const f = await fixture(t); const c = await f.svc.compile('tab1');
  const final = structuredClone(c.apiPrompt); final[4] = {class_type: 'MissingPlugin', inputs: {model: ['1', 0]}};
  assert.throws(() => f.svc.submissions.enqueueCompiled(c, final), /MissingPlugin/); assert.equal(f.count(), 0);
});
