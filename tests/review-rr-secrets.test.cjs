'use strict';
// RR01/RR02/RR04：实际保存、导出、重试路径。所有凭据均为测试数据，目录独立。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setup, safeStorage, grep, prompt} = require('./review-helpers.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');
const {createGraphStoragePolicy, secretName} = require('../shared/graph-storage-policy.cjs');
const SF = require('../shared/secret-fields.cjs');
const {secureSnapshot} = require('../desktop/services/snapshot-secrets.cjs');
const {createTemplateService} = require('../desktop/services/template-service.cjs');
const {createDiagnosticsService} = require('../desktop/services/diagnostics-service.cjs');
const GP = require('../desktop/services/graph-package.cjs');
const {toIpcError} = require('../desktop/core/errors.cjs');
const info = {LLM: {input: {required: {model: ['STRING'], credential: ['STRING', {password: true}]}}}};
const field = (fieldName = 'api_key', defaultValue = 'OLD-fixture-secret') => ({scopePath: [], nodeId: '3', nodeType: 'LMStudioPromptEnhancer', fieldName, widgetType: 'string', constraints: {}, defaultValue});
function env(t) {
  const e = setup(t);
  const cred = new CredentialStore(path.join(e.dir, 'credentials.json'), safeStorage());
  const policy = createGraphStoragePolicy({credentials: cred, objectInfo: () => info});
  return {...e, cred, policy};
}

test('RR01：旧误登记模型既不污染新导出，也能从旧占位中按明确字段还原', t => {
  const {cred, policy} = env(t), model = 'gemma4-Q6_K.gguf';
  cred.set(secretName(model), model); // ed068da 未标记来源的候选记录
  const graph = {nodes: [{id: 1, type: 'LLM', widgets_values: [model, 'new-test-password']}]};
  const stored = policy.secureForStorage(graph);
  assert.equal(stored.nodes[0].widgets_values[0], model);
  const old = structuredClone(stored); old.nodes[0].widgets_values[0] = SF.PLACEHOLDER_PREFIX + secretName(model);
  assert.deepEqual(policy.stripForExport(old).graph.nodes[0].widgets_values, [model, '']);
  assert.deepEqual(policy.stripForExport(graph).graph.nodes[0].widgets_values, [model, '']);
  assert.equal(cred.read().items[secretName(model)].confirmedNodeSecret, undefined);
});

test('RR02：短值、空格和非标准密钥按字段保护，凭据还原保持逐字符相同', async t => {
  const {cred, policy} = env(t);
  for (const secret of ['abc', 'p@ ss', ' padded fictional value ']) {
    const graph = {nodes: [{id: 1, type: 'LLM', widgets_values: {model: 'gemma', credential: secret}}]};
    const disk = policy.secureForStorage(graph);
    assert.equal(policy.resolveInMemory(disk).graph.nodes[0].widgets_values.credential, secret);
    assert.equal(policy.stripForExport(graph).graph.nodes[0].widgets_values.credential, '');
    const snap = secureSnapshot({apiPrompt: {1: {class_type: 'LLM', inputs: {credential: secret, model: 'gemma'}}}}, {credentials: cred, objectInfo: info});
    assert.equal((await SF.resolveSecrets(snap.apiPrompt, name => cred.get(name)))[1].inputs.credential, secret);
  }
});

test('RR01 alternate：旧对象字段只有键名、无敏感定义缓存时不解密导出', async t => {
  const {cred, editor, svc, db, layout, dir} = env(t), key = 'private-access-value';
  cred.set(secretName(key), key); // 旧版本根据 password:true 存下的真凭据
  const graph = {nodes: [{id: 2, type: 'PrivateNode', widgets_values: {access: SF.PLACEHOLDER_PREFIX + secretName(key)}}]};
  editor.exportCopy = createGraphStoragePolicy({credentials: cred}).stripForExport;
  const target = path.join(dir, 'old-secret.json');
  const templates = createTemplateService({db, layout, editor, taskService: svc, getWindow: () => null, dialog: {showSaveDialog: async () => ({filePath: target})}});
  const tpl = templates.repo.create({name: 'legacy', graph});
  await assert.rejects(templates.methods['templates.export'](tpl.id), e => e.code === 'INVALID_STATE');
  assert.equal(fs.existsSync(target), false);
  const defined = createGraphStoragePolicy({credentials: cred, objectInfo: () => ({PrivateNode: {input: {required: {access: ['STRING', {password: true}]}}}})});
  assert.equal(defined.stripForExport(graph).graph.nodes[0].widgets_values.access, '');
});

test('RR02：模糊短值阻止模板/修复副本/图包导出；不写文件，IPC 保留可定位错误', async t => {
  const {editor, svc, db, layout, policy, dir} = env(t);
  const graph = {nodes: [{id: 1, type: 'LLM', widgets_values: ['extra', 'abc', 'gemma']} ]};
  editor.graphPolicy = () => policy; editor.exportCopy = policy.stripForExport;
  editor.commands.tabGraph = async () => ({title: 'test', graph});
  const target = path.join(dir, 'blocked.json');
  const dialog = {showSaveDialog: async () => ({filePath: target})};
  const templates = createTemplateService({db, layout, editor, taskService: svc, dialog, getWindow: () => null});
  const tpl = templates.repo.create({name: 'legacy', graph});
  await assert.rejects(templates.methods['templates.export'](tpl.id), e => e.code === 'INVALID_STATE');
  const diagnostics = createDiagnosticsService({editor, dialog, layout, getWindow: () => null});
  await assert.rejects(diagnostics.methods['templates.exportFixed']('tab1'), e => e.code === 'INVALID_STATE');
  await assert.rejects(svc.methods['tasks.exportPackage']('tab1', {filePath: target}), e => e.code === 'INVALID_STATE');
  assert.throws(() => GP.buildPackage({graph, exportGraph: () => ({graph, uncertain: [{nodeId: '1', type: 'LLM', field: 'credential'}]})}), e => e.code === 'INVALID_STATE');
  assert.equal(fs.existsSync(target), false);
  try { policy.secureForStorage(graph); } catch (e) { const ipc = toIpcError(e); assert.equal(ipc.code, 'INVALID_STATE'); assert.equal(ipc.details.uncertain[0].nodeId, '1'); assert.ok(!JSON.stringify(ipc).includes('abc')); }
});

test('RR04：模板独立默认值保存、导出和图包均清空，正常默认值保留', async t => {
  const {editor, svc, db, layout, policy, dir} = env(t);
  editor.graphPolicy = () => policy; editor.exportCopy = policy.stripForExport;
  const graph = {nodes: []};
  const target = path.join(dir, 'template.json');
  const templates = createTemplateService({db, layout, editor, taskService: svc, getWindow: () => null, dialog: {showSaveDialog: async () => ({filePath: target})}});
  const fields = [field(), field('prompt', '一只猫'), {...field('credential', 'detached-password'), nodeType: 'LLM'}];
  const tpl = templates.repo.create({name: '表单', graph, formSchema: fields});
  const ver = templates.repo.current(tpl.id);
  assert.deepEqual(ver.formSchema.map(f => f.defaultValue), ['', '一只猫', '']);
  assert.equal(fields[0].defaultValue, 'OLD-fixture-secret', '原内存对象不变');
  await templates.methods['templates.export'](tpl.id);
  assert.deepEqual(grep(layout.templates, 'OLD-fixture-secret'), []);
  const exportedForm = JSON.parse(fs.readFileSync(path.join(dir, 'template.yingzuo-form.json')));
  assert.deepEqual(exportedForm.fields.map(f => f.defaultValue), ['', '一只猫', '']);
  const pkg = GP.buildPackage({graph, template: {formSchema: ver.formSchema}});
  assert.ok(!JSON.stringify(pkg).includes('OLD-fixture-secret'));
  editor.commands.tabGraph = async () => ({title: 'test', graph, templateId: tpl.id, templateVersionId: ver.versionId});
  svc.setFormProvider(() => ({versionId: ver.versionId, fields: ver.formSchema}));
  const packPath = path.join(dir, 'form-pack.json');
  await svc.methods['tasks.exportPackage']('tab1', {filePath: packPath});
  assert.deepEqual(JSON.parse(fs.readFileSync(packPath)).template.formSchema.map(f => f.defaultValue), ['', '一只猫', '']);
});

test('RR04：快照当前图不含旧默认值时仍独立清理表单；保留执行用凭据与普通值', t => {
  const {cred} = env(t);
  const raw = {apiPrompt: {3: {class_type: 'LMStudioPromptEnhancer', inputs: {api_key: 'CURRENT-fixture-secret', prompt: '猫'}}}, form: {fields: [field(), field('prompt', '猫')], values: {0: 'VALUES-fixture-secret', 1: '猫'}, requestedValues: {0: 'REQUESTED-fixture-secret', 1: '猫'}}, params: {api_key: 'DETACHED-param-secret', steps: 20}};
  const s = secureSnapshot(raw, {credentials: cred});
  assert.deepEqual(s.form.values, {0: '', 1: '猫'}); assert.equal(s.form.requestedValues[0], '');
  assert.equal(s.form.fields[0].defaultValue, ''); assert.equal(s.params.api_key, ''); assert.equal(s.params.steps, 20);
  assert.match(s.apiPrompt[3].inputs.api_key, /^__yz_credential__:/);
  assert.ok(!JSON.stringify(s).includes('fixture-secret'));
});

test('RR04：旧任务重试按固定表单版本解析索引，不能按新版本默默替换', t => {
  const {svc} = env(t); svc.queue.pause();
  const secure = svc.tasks.secure; svc.tasks.secure = null;
  const task = svc.tasks.create({workflowId: 'w', clientId: 'c', snapshot: {apiPrompt: prompt(), uiGraph: {nodes: []}, form: {templateId: 'tpl-old', versionId: 'v1', values: {0: 'OLD-fixture-secret', 1: '正常'}}}});
  for (const state of ['preparing', 'failed']) svc.tasks.transition(task.id, state);
  svc.tasks.secure = secure;
  svc.setFormProvider((id, version) => { assert.equal(id, 'tpl-old'); assert.equal(version, 'v1'); return {versionId: 'v1', fields: [field(), field('prompt', '正常')]}; });
  const retry = svc.tasks.retry(task.id), snapshot = svc.tasks.snapshotOf(retry);
  assert.equal(snapshot.form.values[0], ''); assert.equal(snapshot.form.values[1], '正常');
  svc.setFormProvider(() => ({versionId: 'v2', fields: [field('prompt')]}));
  assert.throws(() => svc.tasks.retry(task.id), e => e.code === 'INVALID_STATE');
});

test('RR04 alternate：无版本、空字段数组、越界索引的旧任务重试均拒绝且不新增快照', async t => {
  const {svc} = env(t); svc.queue.pause();
  for (const form of [
    {templateId: 'old', values: {0: 'DETACHED-old-value'}, requestedValues: {0: 'DETACHED-old-request'}},
    {fields: [], values: {0: 'DETACHED-old-value'}},
    {fields: [field('prompt', '猫')], requestedValues: {1: 'DETACHED-old-request'}},
  ]) {
    const secure = svc.tasks.secure; svc.tasks.secure = null;
    const task = svc.tasks.create({workflowId: 'w', clientId: 'c', snapshot: {apiPrompt: prompt(), uiGraph: {nodes: []}, form}});
    for (const state of ['preparing', 'failed']) svc.tasks.transition(task.id, state);
    svc.tasks.secure = secure;
    const count = svc.tasks.list({limit: 100}).length;
    await assert.rejects(svc.methods['tasks.retry'](task.id), e => e.code === 'INVALID_STATE');
    assert.equal(svc.tasks.list({limit: 100}).length, count);
  }
});
