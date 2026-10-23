'use strict';
// R04：快捷使用。仅对已注册适配的节点替换字段或插入 LoRA 链；先生成计划，用户确认后返回新的图副本（原图不变）。
// 资源架构未知或工作流中找不到适配节点时，不给出操作（返回 available:false 和原因）。
// 图使用 API prompt 格式 {nodeId: {class_type, inputs}}，链接为 [nodeId, outputIndex]。

/** 节点适配注册表：folder → 可替换的 (节点类型, 字段)。其他模块可 register 扩展（例如 GGUF 插件节点）。 */
const REGISTRY = {
  replace: {
    checkpoints: [['CheckpointLoaderSimple', 'ckpt_name'], ['ImageOnlyCheckpointLoader', 'ckpt_name']],
    diffusion_models: [['UNETLoader', 'unet_name'], ['UnetLoaderGGUF', 'unet_name']],
    vae: [['VAELoader', 'vae_name']],
    text_encoders: [['CLIPLoader', 'clip_name'], ['CLIPLoaderGGUF', 'clip_name']],
    upscale_models: [['UpscaleModelLoader', 'model_name']],
    controlnet: [['ControlNetLoader', 'control_net_name']],
  },
  // 可作为 LoRA 链起点的模型输出节点：类型 → MODEL 输出序号
  modelSources: {CheckpointLoaderSimple: 0, UNETLoader: 0, UnetLoaderGGUF: 0, LoraLoaderModelOnly: 0, LoraLoader: 0},
  loraNode: 'LoraLoaderModelOnly',
};
function register(folder, nodeType, field) { (REGISTRY.replace[folder] ??= []).push([nodeType, field]); }

const clone = g => JSON.parse(JSON.stringify(g));
const isLink = v => Array.isArray(v) && v.length === 2 && typeof v[1] === 'number';

/**
 * @param {object} graph  API prompt
 * @param {object} res    R02 详情 {folder, name, architecture, recommendedWeight}
 * @param {{workflowArchitecture?: string, strength?: number}} [opts]
 */
function planQuickUse(graph, res, opts = {}) {
  if (!res.architecture) return {available: false, reason: '资源架构未知，无法判断是否适配当前工作流。'};
  if (opts.workflowArchitecture && !sameArch(opts.workflowArchitecture, res.architecture)) return {available: false, reason: `资源架构 ${res.architecture} 与工作流 ${opts.workflowArchitecture} 不一致。`};
  if (res.folder === 'loras') return planLora(graph, res, opts);
  const targets = REGISTRY.replace[res.folder];
  if (!targets) return {available: false, reason: `没有为 ${res.folder} 注册的适配节点。`};
  const changes = [];
  for (const [id, n] of Object.entries(graph)) for (const [type, field] of targets) {
    if (n.class_type === type && typeof n.inputs?.[field] === 'string' && n.inputs[field] !== res.name) changes.push({op: 'set', nodeId: id, nodeType: type, field, from: n.inputs[field], to: res.name});
  }
  if (!changes.length) return {available: false, reason: '工作流中没有可替换的已注册节点，或已在使用该资源。'};
  if (changes.length > 1 && !opts.allTargets) return {available: false, reason: '工作流中有多个同类节点，需要用户指定。', candidates: changes};
  return {available: true, changes};
}

function planLora(graph, res, {strength}) {
  const consumers = [];
  let source = null;
  for (const [id, n] of Object.entries(graph)) if (n.class_type in REGISTRY.modelSources) {
    // 选择链尾：MODEL 输出没有被其他 LoRA 节点消费的那个
    const out = REGISTRY.modelSources[n.class_type];
    const usedByLora = Object.values(graph).some(m => (m.class_type === 'LoraLoaderModelOnly' || m.class_type === 'LoraLoader') && isLink(m.inputs?.model) && m.inputs.model[0] === id && m.inputs.model[1] === out);
    if (!usedByLora) { if (source) return {available: false, reason: '存在多条模型链，需要用户指定插入位置。'}; source = [id, out]; }
  }
  if (!source) return {available: false, reason: '工作流中没有已注册的模型加载节点。'};
  for (const [id, n] of Object.entries(graph)) for (const [field, v] of Object.entries(n.inputs ?? {})) if (isLink(v) && v[0] === source[0] && v[1] === source[1]) consumers.push({nodeId: id, field});
  if (Object.values(graph).some(n => n.class_type?.startsWith('Lora') && n.inputs?.lora_name === res.name)) return {available: false, reason: '该 LoRA 已在工作流中。'};
  const w = strength ?? res.recommendedWeight ?? 1;
  return {available: true, changes: [{op: 'insert', nodeType: REGISTRY.loraNode, after: source, inputs: {lora_name: res.name, strength_model: w}, rewire: consumers}]};
}

function sameArch(a, b) { const n = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); return n(a).includes(n(b)) || n(b).includes(n(a)); }

/** 应用计划，返回新图；不修改原图。 */
function applyPlan(graph, plan) {
  if (!plan.available) throw new Error(plan.reason);
  const g = clone(graph);
  for (const c of plan.changes) {
    if (c.op === 'set') g[c.nodeId].inputs[c.field] = c.to;
    else if (c.op === 'insert') {
      let n = Math.max(0, ...Object.keys(g).map(Number).filter(Number.isFinite)) + 1;
      const id = String(n);
      g[id] = {class_type: c.nodeType, inputs: {model: c.after, ...c.inputs}, _meta: {title: `快捷使用：${c.inputs.lora_name}`}};
      for (const r of c.rewire) g[r.nodeId].inputs[r.field] = [id, 0];
    }
  }
  return g;
}

module.exports = {planQuickUse, applyPlan, register, REGISTRY};
