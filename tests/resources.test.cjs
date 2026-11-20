'use strict';
// R01–R05：在临时目录中构造 ComfyUI 布局测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {scanModels, buildFolderMap, parseExtraModelPaths, HashQueue} = require('../desktop/resources/model-scan.cjs');
const {describeResource, ResourceNotes, quantFromName} = require('../desktop/resources/resource-details.cjs');
const {ReferenceIndex, extractRefs} = require('../desktop/resources/reference-index.cjs');
const {planQuickUse, applyPlan} = require('../desktop/resources/quick-use.cjs');
const {listPlugins, disablePlugin, enablePlugin} = require('../desktop/resources/plugin-inventory.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yz-res-'));
function safetensors(file, metadata, dtype = 'BF16') {
  const header = Buffer.from(JSON.stringify({__metadata__: metadata, 'w': {dtype, shape: [1], data_offsets: [0, 2]}}));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, Buffer.concat([len, header, Buffer.alloc(2)]));
}
function layout() {
  const root = path.join(tmp(), 'ComfyUI'), ext = path.join(path.dirname(root), 'extmodels');
  safetensors(path.join(root, 'models', 'loras', 'style', 'ink.safetensors'), {ss_tag_frequency: JSON.stringify({a: {'inkstyle': 9, 'girl': 3}}), ss_base_model_version: 'qwen_image'});
  fs.mkdirSync(path.join(root, 'models', 'diffusion_models'), {recursive: true});
  fs.writeFileSync(path.join(root, 'models', 'diffusion_models', 'qwen-image-Q6_K.gguf'), Buffer.concat([Buffer.from('GGUF'), Buffer.from([3, 0, 0, 0])]));
  fs.mkdirSync(path.join(root, 'models', 'text_encoders'), {recursive: true});
  fs.writeFileSync(path.join(root, 'models', 'text_encoders', 'readme.txt'), 'not a model');
  safetensors(path.join(ext, 'vae', 'qwen_vae.safetensors'), {}, 'F16');
  // 普通 Windows 账户可创建目录 junction；Linux 保留文件 symlink 覆盖。
  if (process.platform === 'win32') fs.symlinkSync(path.join(root, 'models', 'loras', 'style'), path.join(ext, 'loras-link'), 'junction');
  else fs.symlinkSync(path.join(root, 'models', 'loras', 'style', 'ink.safetensors'), path.join(root, 'models', 'loras', 'ink-link.safetensors'));
  fs.writeFileSync(path.join(root, 'extra_model_paths.yaml'), `my:\n  base_path: ${ext}\n  vae: vae\n  loras: |\n    loras\n    loras2\n${process.platform === 'win32' ? '    loras-link\n' : ''}`);
  return {root, ext};
}

test('R01 解析 extra_model_paths.yaml 并按 folder 扫描、符号链接去重、非模型文件忽略', () => {
  const {root, ext} = layout();
  const parsed = parseExtraModelPaths(fs.readFileSync(path.join(root, 'extra_model_paths.yaml'), 'utf8'), root);
  assert.deepEqual(parsed.vae, [path.join(ext, 'vae')]);
  assert.deepEqual(parsed.loras, [path.join(ext, 'loras'), path.join(ext, 'loras2'), ...(process.platform === 'win32' ? [path.join(ext, 'loras-link')] : [])]);
  const {items, duplicates} = scanModels({folderMap: buildFolderMap({comfyRoot: root})});
  const names = items.map(i => i.id).sort();
  assert.deepEqual(names, ['diffusion_models:qwen-image-Q6_K.gguf', 'loras:style/ink.safetensors', 'vae:qwen_vae.safetensors']);
  assert.equal(duplicates.length, 1);
  // 只扫 API 报告存在的 folder
  assert.deepEqual(scanModels({folderMap: buildFolderMap({comfyRoot: root}), apiFolders: ['vae']}).items.map(i => i.folder), ['vae']);
});

test('R01 后台 hash 可取消且有缓存', async () => {
  const {root} = layout();
  const {items} = scanModels({folderMap: buildFolderMap({comfyRoot: root})});
  const q = new HashQueue();
  const r = await q.run(items, ({done}) => { if (done === 1) q.cancel(); });
  assert.equal(r.cancelled, true); assert.equal(r.done, 1);
  let calls = 0; const q2 = new HashQueue({cache: q.cache, hashImpl: async () => { calls++; return 'h'; }});
  await q2.run(items);
  assert.equal(calls, items.length - 1);
});

test('R02 资源详情：用途、量化、架构、触发词、旁路信息、手动补充', () => {
  const {root} = layout();
  const {items} = scanModels({folderMap: buildFolderMap({comfyRoot: root})});
  const lora = items.find(i => i.folder === 'loras');
  fs.writeFileSync(path.join(path.dirname(lora.path), 'ink.civitai.info'), JSON.stringify({trainedWords: ['ink style'], modelId: 7, model: {name: 'Ink'}, preferredWeight: 0.8}));
  fs.writeFileSync(path.join(path.dirname(lora.path), 'ink.preview.png'), 'x');
  const d = describeResource(lora);
  assert.equal(d.usage, 'LoRA'); assert.equal(d.architecture, 'qwen_image');
  assert.deepEqual(d.triggerWords, ['ink style']); assert.equal(d.recommendedWeight, 0.8);
  assert.equal(d.source.modelId, 7); assert.ok(d.preview.endsWith('ink.preview.png')); assert.equal(d.quantization, 'BF16');
  const g = describeResource(items.find(i => i.format === 'gguf'));
  assert.equal(g.quantization, 'Q6_K'); assert.equal(g.usage, '主模型（扩散模型／UNet）'); assert.equal(g.architecture, null);
  assert.equal(quantFromName('flux1-dev-fp8_e4m3fn.safetensors'), 'fp8_e4m3fn');
  const notes = new ResourceNotes(path.join(tmp(), 'notes.json'));
  notes.set(g.id, {architecture: 'qwen_image', evil: 1});
  const g2 = describeResource(items.find(i => i.format === 'gguf'), new ResourceNotes(notes.file).get(g.id));
  assert.equal(g2.architecture, 'qwen_image'); assert.deepEqual(g2.manual, ['architecture']);
});

const API = {
  '1': {class_type: 'UnetLoaderGGUF', inputs: {unet_name: 'qwen-image-Q6_K.gguf'}},
  '2': {class_type: 'VAELoader', inputs: {vae_name: 'old.safetensors'}},
  '3': {class_type: 'KSampler', inputs: {model: ['1', 0], seed: 1}},
  '4': {class_type: 'ModelSamplingAuraFlow', inputs: {model: ['1', 0]}},
};

test('R03 引用索引：抽取、诊断缺失/改位置、移除影响', () => {
  const idx = new ReferenceIndex();
  idx.add({kind: 'template', id: 't1', graph: API});
  idx.add({kind: 'draft', id: 'd1', graph: {nodes: [{id: 5, type: 'LoraLoaderModelOnly', widgets_values: ['ink.safetensors', 1]}]}});
  idx.add({kind: 'plugin', id: 'gemma', requires: ['LLM/gemma.gguf']});
  assert.equal(extractRefs(API).length, 2);
  const items = [{name: 'qwen-image-Q6_K.gguf'}, {name: 'style/ink.safetensors'}];
  const diag = idx.diagnose(items);
  assert.deepEqual(diag.missing.map(r => r.value).sort(), ['LLM/gemma.gguf', 'old.safetensors']);
  assert.deepEqual(diag.relocated[0].candidates, ['style/ink.safetensors']);
  const imp = idx.impact({name: 'qwen-image-Q6_K.gguf'});
  assert.equal(imp.safe, false); assert.equal(imp.affected[0].sourceId, 't1');
  idx.remove('template', 't1');
  assert.equal(idx.impact({name: 'qwen-image-Q6_K.gguf'}).safe, true);
});

test('R04 快捷使用：替换字段、插入 LoRA 链、原图不变、未知架构不给操作', () => {
  const before = JSON.stringify(API);
  const vae = planQuickUse(API, {folder: 'vae', name: 'qwen_vae.safetensors', architecture: 'qwen_image'});
  assert.equal(vae.available, true);
  assert.equal(applyPlan(API, vae)['2'].inputs.vae_name, 'qwen_vae.safetensors');
  const lora = planQuickUse(API, {folder: 'loras', name: 'style/ink.safetensors', architecture: 'qwen_image', recommendedWeight: 0.8});
  assert.equal(lora.available, true);
  const g = applyPlan(API, lora);
  assert.deepEqual(g['5'], {class_type: 'LoraLoaderModelOnly', inputs: {model: ['1', 0], lora_name: 'style/ink.safetensors', strength_model: 0.8}, _meta: {title: '快捷使用：style/ink.safetensors'}});
  assert.deepEqual(g['3'].inputs.model, ['5', 0]); assert.deepEqual(g['4'].inputs.model, ['5', 0]);
  // 再插一个时接到链尾
  const g2 = applyPlan(g, planQuickUse(g, {folder: 'loras', name: 'b.safetensors', architecture: 'qwen_image'}));
  assert.deepEqual(g2['6'].inputs.model, ['5', 0]); assert.deepEqual(g2['3'].inputs.model, ['6', 0]);
  assert.equal(JSON.stringify(API), before);
  assert.equal(planQuickUse(API, {folder: 'loras', name: 'x.safetensors', architecture: null}).available, false);
  assert.equal(planQuickUse(API, {folder: 'loras', name: 'x', architecture: 'flux1'}, {workflowArchitecture: 'qwen_image'}).available, false);
  assert.equal(planQuickUse(API, {folder: 'embeddings', name: 'x', architecture: 'qwen_image'}).available, false);
});

test('R05 插件清单：git、版本、本地修改、requirements、加载状态；禁用/启用可恢复', async () => {
  const root = path.join(tmp(), 'ComfyUI'); const a = path.join(root, 'custom_nodes', 'node-a');
  fs.mkdirSync(a, {recursive: true}); fs.mkdirSync(path.join(root, 'custom_nodes', 'old.disabled'));
  fs.writeFileSync(path.join(a, 'requirements.txt'), 'numpy>=1 # c\n\nrequests\n');
  fs.writeFileSync(path.join(a, 'pyproject.toml'), 'version = "1.2.0"\n');
  const runImpl = async (exe, args) => args.includes('status') ? {code: 0, stdout: ' M __init__.py\n'} : args.includes('get-url') ? {code: 0, stdout: 'https://tok@github.com/x/a\n'} : {code: 0, stdout: 'abc\n'};
  fs.mkdirSync(path.join(a, '.git'));
  const objectInfo = {ANode: {python_module: 'custom_nodes.node-a'}, KSampler: {python_module: 'nodes'}};
  let list = await listPlugins({comfyRoot: root, objectInfo, runImpl});
  const pa = list.find(p => p.name === 'node-a');
  assert.equal(pa.version, '1.2.0'); assert.deepEqual(pa.requirements, ['numpy>=1', 'requests']);
  assert.equal(pa.git.remote, 'https://github.com/x/a'); assert.equal(pa.localChanges.length, 1);
  assert.equal(pa.loaded, 'loaded'); assert.deepEqual(pa.nodeTypes, ['ANode']);
  assert.equal(list.find(p => p.name === 'old').enabled, false);
  const r = disablePlugin({comfyRoot: root, name: 'node-a', reason: '测试'});
  assert.equal(r.needsRestart, true);
  list = await listPlugins({comfyRoot: root, runImpl});
  assert.equal(list.find(p => p.name === 'node-a').enabled, false);
  assert.equal(list.find(p => p.name === 'node-a').disabledInfo.reason, '测试');
  enablePlugin({comfyRoot: root, name: 'node-a'});
  assert.ok(fs.existsSync(path.join(a, 'requirements.txt')));
  assert.throws(() => disablePlugin({comfyRoot: root, name: '../x'}), {code: 'INVALID_ARGUMENT'});
});
