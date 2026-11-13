'use strict';
// R18/D15：敏感输入脱敏（仅虚构密钥）。
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../shared/secret-fields.cjs');
const FAKE = 'sk-fake-000-test';
const prompt = () => ({
  '5': {class_type: 'LMStudioPromptEnhancer', inputs: {prompt: ['3', 0], lmstudio_api_key: FAKE, enable_llm: true}},
  '7': {class_type: 'CustomNode', inputs: {pin: 'abc123', label: 'hello'}},
  '9': {class_type: 'KSampler', inputs: {seed: 1, steps: 20}},
});
const objectInfo = {CustomNode: {input: {required: {pin: ['STRING', {password: true}], label: ['STRING', {}]}}}};

test('R18：Gemma lmstudio_api_key 与 object_info password 字段被替换为凭据引用', () => {
  const graph = {nodes: [{id: 5, type: 'LMStudioPromptEnhancer', widgets_values: ['x', FAKE, true]}, {id: 7, widgets_values: ['abc123', 'hello']}]};
  const r = S.redactForStorage({prompt: prompt(), graph, objectInfo});
  const saved = JSON.stringify({p: r.prompt, g: r.graph, refs: r.refs});
  assert.ok(!saved.includes(FAKE) && !saved.includes('abc123'), '写盘内容不得含明文');
  assert.equal(r.prompt['7'].inputs.label, 'hello');
  assert.deepEqual(r.refs.map(x => x.input).sort(), ['lmstudio_api_key', 'pin']);
  assert.equal(r.secrets.get('node:5:lmstudio_api_key'), FAKE);
  assert.deepEqual(r.prompt['5'].inputs.prompt, ['3', 0]);
});

test('R18：提交时内存解析还原；缺凭据明确报错', async () => {
  const r = S.redactForStorage({prompt: prompt(), objectInfo});
  const back = await S.resolveSecrets(r.prompt, async ref => r.secrets.get(ref));
  assert.deepEqual(back, prompt());
  await assert.rejects(S.resolveSecrets(r.prompt, async () => null), e => e.code === 'CREDENTIAL_MISSING' && e.missing.length === 2);
});

test('R18：空值不生成引用；诊断文本中的嵌入明文被遮盖；既有明文快照可被发现', () => {
  const p = prompt(); p['5'].inputs.lmstudio_api_key = '';
  assert.equal(S.redactForStorage({prompt: p}).refs.length, 0);
  const diag = S.redactValues({log: `calling with key=${FAKE}`}, new Map([[FAKE, 'r']]));
  assert.ok(!JSON.stringify(diag).includes(FAKE));
  assert.deepEqual(S.findPlaintextSecrets(prompt(), objectInfo).map(h => h.input).sort(), ['lmstudio_api_key', 'pin']);
  assert.deepEqual(S.findPlaintextSecrets(S.redactForStorage({prompt: prompt(), objectInfo}).prompt, objectInfo), []);
});
