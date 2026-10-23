'use strict';
// E07/E09/Q08/Q09/E08：绑定推断、本地检查、仅润色子图、参考图上传。节点名称按 Qwen+Gemma 工作流常见结构构造，
// 真实模板中的节点输入名需 Codex 用实际工作流验收。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../shared/bindings.cjs');
const {checkPrompt} = require('../shared/prompt-check.cjs');
const {ReferenceStore, uploadReferences} = require('../desktop/services/task-service.cjs');

const gemmaPrompt = () => ({
  1: {class_type: 'UnetLoaderGGUF', inputs: {unet_name: 'qwen-image-2.1-Q6_K.gguf'}},
  2: {class_type: 'CLIPLoader', inputs: {clip_name: 'qwen.safetensors', type: 'qwen_image'}},
  3: {class_type: 'LMStudioPromptEnhancer', inputs: {prompt: '一只猫', enable_llm: true, image1: ['10', 0], image2: ['11', 0], model: 'gemma'}},
  4: {class_type: 'CLIPTextEncode', inputs: {text: ['3', 0], clip: ['2', 0]}},
  5: {class_type: 'CLIPTextEncode', inputs: {text: '模糊', clip: ['2', 0]}},
  6: {class_type: 'EmptySD3LatentImage', inputs: {width: 1024, height: 1024, batch_size: 1}},
  7: {class_type: 'KSampler', inputs: {seed: 42, steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0]}},
  8: {class_type: 'VAEDecode', inputs: {samples: ['7', 0], vae: ['9', 0]}},
  9: {class_type: 'VAELoader', inputs: {vae_name: 'qwen_vae.safetensors'}},
  10: {class_type: 'LoadImage', inputs: {image: 'a.png'}},
  11: {class_type: 'LoadImage', inputs: {image: 'b.png'}},
  12: {class_type: 'SaveImage', inputs: {images: ['8', 0], filename_prefix: 'yz'}},
});
const objectInfo = {
  UnetLoaderGGUF: {input: {required: {unet_name: []}}, output: ['MODEL']}, CLIPLoader: {input: {required: {clip_name: [], type: []}}, output: ['CLIP']},
  LMStudioPromptEnhancer: {input: {required: {prompt: [], enable_llm: []}}, output: ['STRING']}, CLIPTextEncode: {input: {required: {text: [], clip: []}}, output: ['CONDITIONING']},
  EmptySD3LatentImage: {input: {required: {width: [], height: [], batch_size: []}}, output: ['LATENT']}, KSampler: {input: {required: {seed: [], steps: []}}, output: ['LATENT']},
  VAEDecode: {input: {required: {}}, output: ['IMAGE']}, VAELoader: {input: {required: {}}, output: ['VAE']}, LoadImage: {input: {required: {image: []}}, output: ['IMAGE']},
  SaveImage: {input: {required: {images: []}}, output: [], output_node: true}, PreviewAny: {input: {required: {source: []}}, output: [], output_node: true},
};

test('E07：按节点类型与连线推断参数；提示词经由 Gemma 节点时绑定到其原文输入', () => {
  const b = B.inferBindings(gemmaPrompt());
  assert.deepEqual([b.prompt.nodeId, b.prompt.input, b.prompt.encoder], ['3', 'prompt', '4']);
  assert.equal(b.negative.value, '模糊'); assert.equal(b.seed.value, 42); assert.equal(b.steps.value, 20);
  assert.equal(b.width.value, 1024); assert.equal(b.model.value, 'qwen-image-2.1-Q6_K.gguf');
  assert.equal(b.references.length, 2); assert.equal(b.enhancer.toggleInput, 'enable_llm');
  assert.deepEqual(b.enhancer.imageInputs, ['image1', 'image2']);
});
test('E07：写入参数只改副本；已连线字段只读', () => {
  const p = gemmaPrompt(); const b = B.inferBindings(p);
  const n = B.applyValues(p, b, {prompt: '一只狗', seed: 7});
  assert.equal(n[3].inputs.prompt, '一只狗'); assert.equal(n[7].inputs.seed, 7); assert.equal(p[3].inputs.prompt, '一只猫');
  p[7].inputs.steps = ['99', 0];
  assert.throws(() => B.applyValues(p, B.inferBindings(p), {steps: 30}), /不可编辑/);
  assert.throws(() => B.applyValues(p, b, {unknown: 1}), /不可编辑/);
});
test('E09：本地检查——空图、断开的连线、缺少节点类型、缺少输出节点', () => {
  assert.match(checkPrompt({})[0].message, /空图/);
  const p = gemmaPrompt(); delete p[2];
  assert.ok(checkPrompt(p).some(i => i.input === 'clip' && /不存在的节点 2/.test(i.message)));
  const q = gemmaPrompt(); q[3].class_type = 'Missing';
  assert.ok(checkPrompt(q, {objectInfo}).some(i => /Missing/.test(i.message)));
  const r = gemmaPrompt(); delete r[12];
  assert.ok(checkPrompt(r, {objectInfo}).some(i => /没有输出节点/.test(i.message)));
  assert.deepEqual(checkPrompt(gemmaPrompt(), {objectInfo}), []);
});
test('Q08：仅润色子图不包含任何绘图节点，并接 PreviewAny 读取文本', () => {
  const sub = B.extractEnhanceOnly(gemmaPrompt(), '3', {objectInfo});
  assert.deepEqual(Object.keys(sub.prompt).sort(), ['10', '11', '3', 'yz_enhance_out']);
  assert.deepEqual(sub.prompt.yz_enhance_out, {class_type: 'PreviewAny', inputs: {source: ['3', 0]}});
  assert.equal(sub.prompt[3].inputs.enable_llm, true);
  assert.throws(() => B.extractEnhanceOnly(gemmaPrompt(), '3', {objectInfo: {...objectInfo, PreviewAny: undefined}}), /升级 ComfyUI/);
  assert.equal(B.readEnhancedText({yz_enhance_out: {text: ['润色结果']}}, 'yz_enhance_out'), '润色结果');
});
test('Q08/Q09：采用润色文本后关闭 enable_llm，避免重复调用；参考图超过 2 张报错；上下文须 8192', () => {
  const p = gemmaPrompt(); const e = B.findEnhancers(p)[0];
  const n = B.adoptEnhanced(p, e, '精修后的提示词');
  assert.equal(n[3].inputs.prompt, '精修后的提示词'); assert.equal(n[3].inputs.enable_llm, false);
  assert.equal(B.checkEnhancerRun(p, e, {contextLength: 8192})[0].level, 'info');
  assert.equal(B.checkEnhancerRun(p, e, {contextLength: 4096})[0].level, 'error');
  assert.equal(B.checkEnhancerRun(p, {...e, imageInputs: ['a', 'b', 'c']}, {contextLength: 8192}).at(-1).level, 'error');
  assert.throws(() => B.adoptEnhanced(p, {...e, toggleInput: null}, 'x'), /enable_llm/);
});
test('E08：参考图内容寻址保存；提交前上传并写回服务器返回的文件名', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ref-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const src = path.join(d, '人物.png'); fs.writeFileSync(src, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const store = new ReferenceStore(path.join(d, 'references'));
  const a = store.importFile(src), b = store.importFile(src);
  assert.equal(a.id, b.id); assert.ok(fs.existsSync(store.pathOf(a.id)));
  assert.throws(() => store.pathOf('../../etc/passwd'), /无效/);
  fs.writeFileSync(path.join(d, 'x.txt'), 'x'); assert.throws(() => store.importFile(path.join(d, 'x.txt')), /只支持/);
  const uploads = [];
  const client = {uploadImage: async o => { uploads.push(o); return {name: 'srv_renamed.png', subfolder: 'yingzuo', type: 'input'}; }};
  const out = await uploadReferences(gemmaPrompt(), [{nodeId: '10', input: 'image', refId: a.id}], client, store);
  assert.equal(out[10].inputs.image, 'yingzuo/srv_renamed.png'); assert.equal(uploads[0].mime, 'image/png');
  await assert.rejects(uploadReferences(gemmaPrompt(), [{nodeId: '99', refId: a.id}], client, store), /不存在/);
});
