'use strict';
// PR11-R07/R08（D01/D02）：按真实 Qwen 2.1 + Gemma 结构的脱敏夹具检查绑定、仅润色与采用结果。
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../shared/bindings.cjs');
const F = require('./fixtures/qwen21-gemma-api.json');
const g = k => structuredClone(F[k]);
const objectInfo = {LMStudioPromptEnhancer: {output: ['STRING']}, PreviewAny: {output: [], output_node: true}, PrimitiveStringMultiline: {output: ['STRING']}};

test('D01：TextEncodeQwenImage21 两输出槽分别绑定正/反提示词，latent 槽给出 resolution', () => {
  const b = B.inferBindings(g('t2i'));
  assert.deepEqual([b.prompt.nodeId, b.prompt.input, b.prompt.encoder, b.prompt.slot], ['20', 'value', '4', 0]);
  assert.equal(b.prompt.value, '一只橘猫坐在窗台');
  assert.deepEqual(b.prompt.via, ['3']);
  assert.deepEqual([b.negative.nodeId, b.negative.input, b.negative.slot, b.negative.value], ['4', 'negative_prompt', 1, '模糊，低质量']);
  assert.equal(b.resolution.value, 1024); assert.equal(b.width, undefined);
  const n = B.applyValues(g('t2i'), b, {prompt: '一只狗', negative: '', resolution: 1280});
  assert.equal(n[20].inputs.value, '一只狗'); assert.deepEqual(n[3].inputs.prompt, ['20', 0]); assert.equal(n[4].inputs.negative_prompt, ''); assert.equal(n[4].inputs.resolution, 1280);
});
test('D01：反向连到同一编码器 slot0 不会被当作反向提示词', () => {
  const p = g('t2i'); p[7].inputs.negative = ['4', 0];
  const b = B.inferBindings(p);
  assert.equal(b.negative.nodeId, '20'); // 同一编码器同一槽 → 与正向同源（如实反映图的连线）
  assert.equal(b.negative.slot, 0);
});
test('子图（编译后带冒号 ID）、连线尺寸只读并标出来源、多参考图', () => {
  const b = B.inferBindings(g('edit'));
  assert.equal(b.prompt.nodeId, '20'); assert.equal(b.negative.input, 'negative_prompt');
  assert.equal(b.width.readonly, true); assert.equal(b.width.source, 'ResolutionSelector');
  assert.throws(() => B.applyValues(g('edit'), b, {width: 512}), /不可编辑/);
  assert.equal(b.references.length, 3);
  assert.deepEqual(b.enhancer.imageInputs, ['input_image_1', 'input_image_2']);
});
test('D02：Gemma prompt 为连线时识别原文来源；仅润色可替换原文且不改连线', () => {
  const p = g('t2i'); const e = B.findEnhancers(p)[0];
  assert.equal(e.promptLinked, true); assert.deepEqual(e.source, {nodeId: '20', input: 'value', via: []});
  assert.equal(B.enhancerOriginal(p, e), '一只橘猫坐在窗台');
  assert.deepEqual(e.settings, {context_length: 8192, release_vram: true, disable_thinking: true, model: 'auto', lmstudio_base_url: 'http://127.0.0.1:1234/v1', cache_buster: 0, generation_mode: 'Image'});
  assert.deepEqual(e.secretInputs, ['lmstudio_api_key']);
  const changed = B.setEnhancerOriginal(p, e, '一只黑猫');
  const sub = B.extractEnhanceOnly(changed, '3', {objectInfo});
  assert.deepEqual(Object.keys(sub.prompt).sort(), ['20', '3', 'yz_enhance_out']);
  assert.equal(sub.prompt[20].inputs.value, '一只黑猫'); assert.deepEqual(sub.prompt[3].inputs.prompt, ['20', 0]);
  assert.equal(p[20].inputs.value, '一只橘猫坐在窗台');
});
test('D02：重新润色改变 cache_buster；单独润色图（无 sampler）可用', () => {
  const a = B.extractEnhanceOnly(g('t2i'), '3', {objectInfo});
  const r = B.extractEnhanceOnly(g('t2i'), '3', {objectInfo, rerun: true, now: () => 5});
  assert.equal(a.prompt[3].inputs.cache_buster, 0); assert.notEqual(r.prompt[3].inputs.cache_buster, 0);
  const po = g('promptOnly'); const b = B.inferBindings(po);
  assert.equal(b.enhancer.source.nodeId, '20');
  assert.ok(B.extractEnhanceOnly(po, '3', {objectInfo}).prompt.yz_enhance_out);
});
test('D02：采用结果——提交副本用专用文本节点喂 forceInput，关闭 LLM，原图不变', () => {
  const p = g('t2i'); const e = B.findEnhancers(p)[0];
  const n = B.adoptEnhanced(p, e, '精修文本', {objectInfo});
  assert.deepEqual(n[3].inputs.prompt, ['yz_adopted_text', 0]);
  assert.deepEqual(n.yz_adopted_text, {class_type: 'PrimitiveStringMultiline', inputs: {value: '精修文本'}});
  assert.equal(n[3].inputs.enable_llm, false);
  assert.deepEqual(p[3].inputs.prompt, ['20', 0]); assert.equal(p[3].inputs.enable_llm, true);
  // 下游编码器仍从润色节点取文本（enable_llm=false 时插件原样返回 prompt）
  assert.deepEqual(n[4].inputs.prompt, ['3', 0]);
  assert.throws(() => B.adoptEnhanced(p, e, 'x', {objectInfo: {}}), /PrimitiveStringMultiline/);
});
test('Q09：上下文以图中节点值为准；两张参考图提示第三张交给 Qwen；三张接 Gemma 报错', () => {
  const p = g('edit'); const e = B.findEnhancers(p)[0];
  assert.equal(B.checkEnhancerRun(p, e, {contextLength: 8192})[0].level, 'info');
  p[3].inputs.context_length = 4096;
  const bad = B.checkEnhancerRun(p, B.findEnhancers(p)[0], {contextLength: 8192});
  assert.equal(bad[0].level, 'error'); assert.match(bad[0].message, /4096（工作流节点中的值）/);
  p[3].inputs.context_length = 8192; p[3].inputs.input_image_3 = ['14', 0];
  assert.equal(B.checkEnhancerRun(p, B.findEnhancers(p)[0], {}).find(n => n.level === 'error').level, 'error');
});
test('多采样器提示来源不同给出警告；未适配编码器给出说明且不生成提示词绑定', () => {
  const p = g('t2i');
  p[40] = {class_type: 'CLIPTextEncode', inputs: {text: '别的', clip: ['2', 0]}};
  p[41] = {class_type: 'KSampler', inputs: {seed: 1, steps: 4, positive: ['40', 0], negative: ['40', 0], latent_image: ['4', 2], model: ['1', 0]}};
  assert.ok(B.inferBindings(p).notes.some(n => /2 个采样器/.test(n.message)));
  const q = g('t2i'); q[4].class_type = 'SomeUnknownEncoder';
  const b = B.inferBindings(q);
  assert.equal(b.prompt, undefined); assert.ok(b.notes.some(n => /未适配/.test(n.message)));
});
test('SamplerCustomAdvanced：guider 的正负条件与 RandomNoise 的 seed', () => {
  const p = g('t2i');
  p[50] = {class_type: 'CFGGuider', inputs: {model: ['1', 0], positive: ['4', 0], negative: ['4', 1], cfg: 2.5}};
  p[51] = {class_type: 'RandomNoise', inputs: {noise_seed: 99}};
  p[7] = {class_type: 'SamplerCustomAdvanced', inputs: {noise: ['51', 0], guider: ['50', 0], sampler: ['52', 0], sigmas: ['53', 0], latent_image: ['4', 2]}};
  const b = B.inferBindings(p);
  assert.equal(b.prompt.nodeId, '20'); assert.equal(b.negative.input, 'negative_prompt');
  assert.deepEqual([b.seed.nodeId, b.seed.value], ['51', 99]);
});

test('PR11-R07：SaveImageAdvanced 仅在 object_info 确认 filename_prefix 为 STRING 时改写前缀；ResolutionSelector 尺寸只读', () => {
  const {planSavePrefix} = require('../shared/output-plan.cjs');
  const fx = require('./fixtures/qwen21-gemma-api.json');
  const none = planSavePrefix(fx.t2i, {dir: '映作/x'});
  assert.equal(none.changed.length, 0); assert.ok(none.untouched.some(u => u.classType === 'SaveImageAdvanced'));
  const info = {SaveImageAdvanced: {output_node: true, input: {required: {images: ['IMAGE'], filename_prefix: ['STRING', {default: 'ComfyUI'}], format: [['png', 'jpeg']]}}}};
  const r = planSavePrefix(fx.t2i, {dir: '映作/x', objectInfo: info});
  assert.deepEqual(r.changed.map(c => [c.classType, c.after]), [['SaveImageAdvanced', '映作/x/Qwen_image_2.1']]);
  assert.equal(r.prompt[Object.keys(r.prompt).find(k => r.prompt[k].class_type === 'SaveImageAdvanced')].inputs['format.bit_depth'], '8-bit', '其他保存设置不变');
  const b = require('../shared/bindings.cjs').inferBindings(fx.edit);
  assert.ok(b.width?.readonly && b.height?.readonly, '尺寸来自 ResolutionSelector 连线时只读');
});
