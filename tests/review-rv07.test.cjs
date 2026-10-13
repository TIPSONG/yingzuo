'use strict';
// RV07：全部覆盖完成后校验最终 prompt；整组任一无效零入队；快照记录实际最终值。RV14：queue.maxBatch 为唯一上限来源。
const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, prompt, info} = require('./review-helpers.cjs');

const fields = [{scopePath: [], nodeId: '7', nodeType: 'KSampler', fieldName: 'steps', widgetType: 'int', constraints: {min: 1, max: 30}, label: '步数', group: '采样', order: 0, defaultValue: 20}];
const enumInfo = {...info, KSampler: {input: {required: {sampler_name: [['euler', 'dpmpp_2m']], steps: ['INT', {min: 1, max: 10000}]}}, output: ['L']}};
function formSetup(t, extra) {
  const s = setup(t, {info: enumInfo, ...extra});
  s.editor.commands.compileTab = async id => ({tabId: id ?? 'tab1', templateId: 'tpl1', title: 'T', revision: 3, uiGraph: {nodes: []}, apiPrompt: prompt()});
  s.svc.setFormProvider(id => (id === 'tpl1' ? {versionId: 'v1', fields} : null));
  return s;
}
const count = svc => svc.tasks.list?.().length ?? svc.db.prepare?.('select count(*) n from tasks').get().n;

test('RV07：普通 values 覆盖越过表单范围（20→99）被拒绝，零入队', async t => {
  const {svc, submitted, settle} = formSetup(t);
  await assert.rejects(svc.methods['tasks.run']('tab1', {values: {steps: 99}}), /不能大于 30/);
  await settle(); assert.equal(submitted.length, 0);
});
test('RV07：批量变化 [20,99] 整组拒绝、零入队；params 覆盖同样被校验', async t => {
  const {svc, submitted, settle} = formSetup(t);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {seeds: [1], variations: {steps: [20, 99]}}), /第 2 个任务.*不能大于 30/);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {seeds: [1, 2], params: [{steps: 10}, {steps: 31}]}), /不能大于 30/);
  await settle(); assert.equal(submitted.length, 0);
});
test('RV07：表单值与批量值冲突——以最终值为准校验，并在快照记录实际最终值', async t => {
  const {svc, submitted, settle} = formSetup(t);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {seeds: [1], formValues: {0: 10}, variations: {steps: [99]}}), /不能大于 30/);
  const r = await svc.methods['tasks.runBatch']('tab1', {seeds: [1], formValues: {0: 10}, variations: {steps: [25]}}); await settle();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].prompt[7].inputs.steps, 25);
  const snap = svc.tasks.snapshotOf(svc.tasks.get(r.tasks[0].id));
  assert.equal(snap.form.values[0], 25, '记录最终提交值而不是覆盖前的表单值');
  assert.equal(snap.form.requestedValues[0], 10);
});
test('RV07：枚举覆盖不在节点可选项中被拒绝', async t => {
  const {svc, submitted, settle} = formSetup(t);
  await assert.rejects(svc.methods['tasks.run']('tab1', {values: {sampler_name: 'nope'}}), /不在可选项中/);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {seeds: [1], params: [{sampler_name: 'nope'}]}), /不在可选项中/);
  await svc.methods['tasks.run']('tab1', {values: {sampler_name: 'dpmpp_2m'}}); await settle();
  assert.equal(submitted.length, 1); assert.equal(submitted[0].prompt[7].inputs.sampler_name, 'dpmpp_2m');
});
test('RV14：queue.maxBatch 决定预览上限、规划与整组检查', async t => {
  const {svc, submitted, settle} = setup(t, {config: {queue: {maxBatch: 3}}});
  assert.equal((await svc.methods['tasks.previewBatch']('tab1', {seeds: [1]})).max, 3);
  assert.equal((await svc.methods['tasks.preview']('tab1')).maxBatch, 3);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {seeds: [1, 2, 3, 4]}), /超过上限 3/);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {seeds: [1, 2], params: [{}, {}]}), /超过上限 3/);
  const big = setup(t, {config: {queue: {maxBatch: 200}}});
  const r = await big.svc.methods['tasks.runBatch']('tab1', {seeds: Array.from({length: 101}, (_, i) => i)});
  assert.equal(r.tasks.length, 101);
  await settle(); assert.equal(submitted.length, 0);
});
