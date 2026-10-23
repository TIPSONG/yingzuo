'use strict';
// R20：稳定 workflowId 与 SaveImageAdvanced 适配。
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../shared/output-plan.cjs');
const {prefixDir} = require('../desktop/services/output-prefix.cjs');

test('R20：workflowId 与 tabId 无关；模板改名、重开、参数修改不变', () => {
  assert.equal(O.stableWorkflowId({templateId: 't1'}), 'tpl_t1');
  const g = {nodes: [{id: 1, type: 'KSampler', widgets_values: [1]}, {id: 2, type: 'SaveImage'}], links: [[1, 1, 0, 2, 0, 'IMAGE']]};
  const g2 = structuredClone(g); g2.nodes[0].widgets_values = [999]; g2.extra = {ds: {offset: [5, 5]}};
  assert.equal(O.stableWorkflowId({uiGraph: g}), O.stableWorkflowId({uiGraph: g2}));
  const g3 = structuredClone(g); g3.nodes.push({id: 3, type: 'Upscale'});
  assert.notEqual(O.stableWorkflowId({uiGraph: g}), O.stableWorkflowId({uiGraph: g3}));
  assert.ok(prefixDir({mode: 'workflow', workflowId: O.stableWorkflowId({templateId: 'abc12345xyz'}), workflowName: '新名'}).includes('tplabc12'));
});

test('R20：SaveImageAdvanced——有定义且有 STRING 前缀才改；无定义/连线/无字段保持原样', () => {
  const prompt = {
    '9': {class_type: 'SaveImage', inputs: {filename_prefix: 'ComfyUI', images: ['8', 0]}},
    '10': {class_type: 'SaveImageAdvanced', inputs: {filename_prefix: 'out/Qwen', images: ['8', 0]}},
    '11': {class_type: 'SaveImageAdvanced', inputs: {filename_prefix: ['12', 0]}},
    '13': {class_type: 'PreviewAny', inputs: {source: ['5', 0]}},
  };
  const none = O.planSavePrefix(prompt, {dir: '映作/2026-10-13'});
  assert.deepEqual(none.changed.map(c => c.nodeId), ['9']);
  assert.equal(none.prompt['10'].inputs.filename_prefix, 'out/Qwen');
  assert.ok(none.untouched.find(u => u.nodeId === '10').reason.includes('节点定义'));
  const objectInfo = {SaveImageAdvanced: {output_node: true, input: {required: {images: ['IMAGE'], filename_prefix: ['STRING', {default: 'ComfyUI'}]}}}};
  const r = O.planSavePrefix(prompt, {dir: '映作/2026-10-13', objectInfo});
  assert.equal(r.prompt['10'].inputs.filename_prefix, '映作/2026-10-13/Qwen');
  assert.ok(r.untouched.find(u => u.nodeId === '11').reason.includes('连线'));
  assert.equal(prompt['10'].inputs.filename_prefix, 'out/Qwen', '原 prompt 不变');
  assert.equal(O.planSavePrefix(r.prompt, {dir: '映作/2026-10-13', objectInfo}).changed.length, 0, '幂等');
  const noField = O.saveNodePrefixKey('SaveImageAdvanced', {SaveImageAdvanced: {output_node: true, input: {required: {path: ['COMBO']}}}});
  assert.equal(noField.key, null);
});
