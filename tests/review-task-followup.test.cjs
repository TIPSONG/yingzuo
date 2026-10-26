'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {setup, prompt, info} = require('./review-helpers.cjs');
const {run} = require('../desktop/services/process-utils.cjs');
const {CancelToken} = require('../desktop/core/locks.cjs');
const B = require('../shared/bindings.cjs');

test('batch preview includes variations and params and honors the configured limit above 100', async t => {
  const {svc} = setup(t, {config: {queue: {maxBatch: 200}}});
  const spec = {seeds: [1, 2], variations: {steps: [10, 20, 30]}, params: [{}, {sampler_name: 'euler'}]};
  assert.equal((await svc.methods['tasks.previewBatch']('tab1', spec)).count, 12);
  assert.equal((await svc.methods['tasks.previewBatch']('tab1', {count: 101})).count, 101);
  await assert.rejects(svc.methods['tasks.previewBatch']('tab1', {count: Number.MAX_SAFE_INTEGER}), /超过上限 200/);
});

test('Gemma final context is validated after custom form overrides and in batch runs', async t => {
  const s = setup(t);
  const p = prompt(); p[3].inputs.context_length = 8192;
  s.editor.commands.compileTab = async id => ({tabId: id, title: 'T', revision: 3, templateId: 'tpl', uiGraph: {nodes: []}, apiPrompt: structuredClone(p)});
  s.svc.setFormProvider(() => ({versionId: 'v1', fields: [{scopePath: [], nodeId: '3', nodeType: 'LMStudioPromptEnhancer', fieldName: 'context_length', widgetType: 'int', constraints: {min: 1024, max: 262144}, label: '上下文', order: 0}]}));
  await assert.rejects(s.svc.methods['tasks.run']('tab1', {formValues: {0: 4096}}), /4096.*8192/);
  await assert.rejects(s.svc.methods['tasks.runBatch']('tab1', {count: 2, formValues: {0: 4096}}), /4096.*8192/);
  assert.equal(s.svc.tasks.list().length, 0);
  await s.svc.methods['tasks.runBatch']('tab1', {count: 1, formValues: {0: 8192}}); await s.settle();
  assert.equal(s.submitted.length, 1);
});

test('enhance-only validates and records the overridden original text against its saved form', async t => {
  const s = setup(t);
  s.editor.commands.compileTab = async id => ({tabId: id, title: 'T', revision: 3, templateId: 'tpl', uiGraph: {nodes: []}, apiPrompt: prompt()});
  s.svc.setFormProvider(() => ({versionId: 'v1', fields: [{scopePath: [], nodeId: '3', nodeType: 'LMStudioPromptEnhancer', fieldName: 'prompt', widgetType: 'text', constraints: {}, label: '原文', order: 0}]}));
  await assert.rejects(s.svc.methods['tasks.enhance']('tab1', {text: 'a'.repeat(200001)}), /过长/);
  const task = await s.svc.methods['tasks.enhance']('tab1', {text: '新的原文'}); await s.settle();
  assert.equal(s.svc.tasks.snapshotOf(task).form.values[0], '新的原文');
});

test('generated enhancement node IDs never overwrite existing upstream nodes', () => {
  const p = prompt();
  p.yz_adopted_text = {class_type: 'PrimitiveStringMultiline', inputs: {value: 'existing'}};
  p[3].inputs.prompt = ['yz_adopted_text', 0];
  const e = B.findEnhancers(p)[0];
  const adopted = B.adoptEnhanced(p, e, 'new');
  assert.equal(adopted.yz_adopted_text.inputs.value, 'existing');
  assert.notEqual(adopted[3].inputs.prompt[0], 'yz_adopted_text');
  p.yz_enhance_out = {class_type: 'PrimitiveStringMultiline', inputs: {value: 'source'}};
  p[3].inputs.prompt = ['yz_enhance_out', 0];
  const sub = B.extractEnhanceOnly(p, '3', {objectInfo: info});
  assert.equal(sub.prompt.yz_enhance_out.inputs.value, 'source');
  assert.notEqual(sub.outputNode, 'yz_enhance_out');
});

test('pre-cancelled command does not spawn and cancellation during spawn is classified correctly', async () => {
  const pre = new CancelToken(); pre.cancel('already cancelled'); let starts = 0;
  await assert.rejects(run('fake', [], {token: pre, spawnImpl: () => { starts++; return new EventEmitter(); }}), e => e.code === 'CANCELLED');
  assert.equal(starts, 0);
  const token = new CancelToken(); const child = new EventEmitter(); let kills = 0; child.kill = () => { kills++; };
  await assert.rejects(run('fake', [], {token, spawnImpl: () => { token.cancel(); return child; }}), e => e.code === 'CANCELLED');
  assert.equal(kills, 1);
  assert.doesNotThrow(() => child.emit('error', new Error('late spawn error')));
});
