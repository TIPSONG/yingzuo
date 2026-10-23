'use strict';
// E07 / PR11-R07 / PR11-R08：从 API prompt 推断可编辑参数。按显式节点适配器 + 连线（含输出槽）追踪，
// 不按 widget 序号猜。已连线的输入只读；未适配的节点不生成绑定并给出说明。
// 节点契约来源（2026-10-13 核对）：
//  - TextEncodeQwenImage21：ComfyUI comfy_extras/nodes_qwen.py。输入 prompt、negative_prompt、resolution、
//    Autogrow images（image_1…image_16）；输出 0=positive、1=negative、2=latent。
//  - LMStudioPromptEnhancer：prompt 为 forceInput（连线）；input_image_1/2；enable_llm、cache_buster；
//    本机补丁另有 release_vram、disable_thinking、context_length。输出 0 为 STRING。
//  - PrimitiveStringMultiline / PrimitiveString：ComfyUI 核心，输入 value，输出 STRING。
//  - PreviewAny：输入 source，返回 ui.text。
const isLink = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);
/** 文本编码器适配：输出槽 → 该槽对应的文本输入。 */
const ENCODERS = {
  TextEncodeQwenImage21: {slots: {0: 'prompt', 1: 'negative_prompt'}, latentSlot: 2, sizeInput: 'resolution', imagePattern: /^(images\.)?image_\d+$/},
  TextEncodeQwenImageEdit: {slots: {0: 'prompt'}},
  TextEncodeQwenImageEditPlus: {slots: {0: 'prompt'}},
  CLIPTextEncode: {slots: {0: 'text'}},
};
const TEXT_SOURCES = {PrimitiveStringMultiline: 'value', PrimitiveString: 'value'};
const ENHANCER = /^LMStudioPromptEnhancer$|lm.?studio.*enhanc|prompt.?enhanc/i;
const ENHANCER_SETTINGS = ['context_length', 'release_vram', 'disable_thinking', 'model', 'lmstudio_base_url', 'cache_buster', 'generation_mode'];
const SECRET_INPUTS = /api_?key|(^|_)token$|secret|passw(or)?d/i;
const LATENT = /^(EmptyLatentImage|EmptySD3LatentImage|EmptyHunyuanLatentVideo|EmptyQwenImageLayeredLatentImage)$/;
const PASS_ORDER = ['conditioning', 'positive', 'negative', 'conditioning_1', 'conditioning_to', 'conditioning_from'];

function upstream(prompt, id, seen = new Set()) {
  if (seen.has(id) || !prompt[id]) return seen;
  seen.add(id);
  for (const v of Object.values(prompt[id].inputs ?? {})) if (isLink(v)) upstream(prompt, v[0], seen);
  return seen;
}
/** 沿连线向上找第一个满足 pred 的节点（穿过透传节点）。 */
function findUp(prompt, link, pred, depth = 0) {
  if (!isLink(link) || depth > 12) return null;
  const node = prompt[link[0]];
  if (!node) return null;
  if (pred(node, link[0])) return link[0];
  for (const v of Object.values(node.inputs ?? {})) { const r = findUp(prompt, v, pred, depth + 1); if (r) return r; }
  return null;
}
/** 条件连线 → {encoderId, slot}。透传节点优先走 conditioning 类输入，保留真实输出槽。 */
function traceEncoder(prompt, link, depth = 0) {
  if (!isLink(link) || depth > 12) return null;
  const node = prompt[link[0]];
  if (!node) return null;
  if (ENCODERS[node.class_type]) return {encoderId: link[0], slot: link[1]};
  const ins = node.inputs ?? {};
  const keys = [...PASS_ORDER.filter(k => isLink(ins[k])), ...Object.keys(ins).filter(k => !PASS_ORDER.includes(k) && isLink(ins[k]))];
  for (const k of keys) { const r = traceEncoder(prompt, ins[k], depth + 1); if (r) return r; }
  return null;
}
/** 文本连线 → 可编辑原文 {nodeId, input, via:[...]}。穿过润色节点继续找它的原文来源。 */
function traceText(prompt, link, via = [], depth = 0) {
  if (!isLink(link) || depth > 12) return null;
  const id = link[0], node = prompt[id];
  if (!node) return null;
  const ins = node.inputs ?? {};
  if (ENHANCER.test(node.class_type)) return isLink(ins.prompt) ? traceText(prompt, ins.prompt, [...via, id], depth + 1) : typeof ins.prompt === 'string' ? {nodeId: id, input: 'prompt', via} : null;
  const known = TEXT_SOURCES[node.class_type];
  if (known) return typeof ins[known] === 'string' ? {nodeId: id, input: known, via} : isLink(ins[known]) ? traceText(prompt, ins[known], [...via, id], depth + 1) : null;
  for (const k of ['value', 'text', 'string', 'prompt']) {
    if (typeof ins[k] === 'string') return {nodeId: id, input: k, via};
    if (isLink(ins[k])) return traceText(prompt, ins[k], [...via, id], depth + 1);
  }
  return null;
}
function field(prompt, nodeId, input, extra = {}) {
  const node = prompt[nodeId];
  const value = node?.inputs?.[input];
  if (value === undefined) return null;
  return {nodeId, nodeType: node.class_type, input, value: isLink(value) ? null : value, readonly: isLink(value), ...extra};
}
/** 采样器的正负条件、seed、latent 来源（含 SamplerCustomAdvanced 的 guider/noise）。 */
function samplerParts(prompt, id) {
  const s = prompt[id].inputs ?? {};
  let positive = s.positive, negative = s.negative, seedNode = id, seedKey = s.seed !== undefined ? 'seed' : s.noise_seed !== undefined ? 'noise_seed' : null;
  if (isLink(s.guider)) { const g = prompt[s.guider[0]]?.inputs ?? {}; positive = g.positive ?? g.conditioning; negative = g.negative; }
  if (isLink(s.noise)) { const n = prompt[s.noise[0]]; if (n?.inputs?.noise_seed !== undefined) { seedNode = s.noise[0]; seedKey = 'noise_seed'; } }
  return {positive, negative, seedNode, seedKey, latent: s.latent_image};
}
function inferBindings(prompt) {
  const out = {notes: []};
  const put = (key, f) => { if (f && !out[key]) out[key] = f; };
  const ids = Object.keys(prompt ?? {});
  const samplers = ids.filter(id => SAMPLERS.has(prompt[id].class_type));
  if (samplers.length > 1) {
    const sig = samplers.map(id => { const p = samplerParts(prompt, id); const e = traceEncoder(prompt, p.positive); return e ? `${e.encoderId}:${e.slot}` : '?'; });
    if (new Set(sig).size > 1) out.notes.push({level: 'warning', message: `工作流有 ${samplers.length} 个采样器且提示词来源不同，只绑定第一个采样器（#${samplers[0]}）的参数。`});
  }
  const sampler = samplers[0];
  if (sampler) {
    const p = samplerParts(prompt, sampler);
    for (const k of ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) put(k, field(prompt, sampler, k));
    if (p.seedKey) {
      put('seed', field(prompt, p.seedNode, p.seedKey));
      if (out.seed?.readonly) { const src = findUp(prompt, prompt[p.seedNode].inputs[p.seedKey], n => typeof n.inputs?.seed === 'number' || typeof n.inputs?.noise_seed === 'number' || (n.class_type === 'PrimitiveInt' && typeof n.inputs?.value === 'number')); if (src) put('seedSource', field(prompt, src, prompt[src].inputs.seed !== undefined ? 'seed' : prompt[src].inputs.noise_seed !== undefined ? 'noise_seed' : 'value')); }
    }
    for (const [key, link] of [['prompt', p.positive], ['negative', p.negative]]) {
      const enc = traceEncoder(prompt, link);
      if (!enc) { if (isLink(link)) out.notes.push({level: 'info', message: `${key === 'prompt' ? '正向' : '反向'}条件来自未适配的编码节点，提示词不可在表单中编辑。`}); continue; }
      const adapter = ENCODERS[prompt[enc.encoderId].class_type];
      const textKey = adapter.slots[enc.slot];
      if (!textKey) { out.notes.push({level: 'warning', message: `${prompt[enc.encoderId].class_type} 的输出槽 ${enc.slot} 不是文本条件。`}); continue; }
      const f = field(prompt, enc.encoderId, textKey, {encoder: enc.encoderId, slot: enc.slot});
      if (f?.readonly) {
        const src = traceText(prompt, prompt[enc.encoderId].inputs[textKey]);
        if (src) { put(key, field(prompt, src.nodeId, src.input, {encoder: enc.encoderId, slot: enc.slot, via: src.via})); continue; }
      }
      put(key, f);
    }
    const encLatent = isLink(p.latent) && ENCODERS[prompt[p.latent[0]]?.class_type]?.latentSlot === p.latent[1] ? p.latent[0] : null;
    if (encLatent) put('resolution', field(prompt, encLatent, ENCODERS[prompt[encLatent].class_type].sizeInput));
    else {
      const latent = findUp(prompt, p.latent, n => LATENT.test(n.class_type));
      if (latent) {
        put('width', field(prompt, latent, 'width')); put('height', field(prompt, latent, 'height')); put('batch', field(prompt, latent, 'batch_size'));
        for (const k of ['width', 'height']) if (out[k]?.readonly) out[k].source = prompt[prompt[latent].inputs[k][0]]?.class_type ?? null;
      }
    }
  }
  for (const id of ids) {
    const n = prompt[id];
    if (/^(UNETLoader|UnetLoaderGGUF|CheckpointLoaderSimple)$/.test(n.class_type)) put('model', field(prompt, id, n.inputs.unet_name !== undefined ? 'unet_name' : 'ckpt_name'));
    if (n.class_type === 'LoadImage') (out.references ??= []).push(field(prompt, id, 'image'));
  }
  const enh = findEnhancers(prompt);
  if (enh.length) out.enhancer = enh[0];
  if (enh.length > 1) out.notes.push({level: 'warning', message: `工作流有 ${enh.length} 个润色节点，只处理 #${enh[0].nodeId}。`});
  return out;
}
function findEnhancers(prompt) {
  return Object.keys(prompt ?? {}).filter(id => ENHANCER.test(prompt[id].class_type)).map(id => {
    const inputs = prompt[id].inputs ?? {};
    const promptLinked = isLink(inputs.prompt);
    const source = promptLinked ? traceText(prompt, inputs.prompt) : typeof inputs.prompt === 'string' ? {nodeId: id, input: 'prompt', via: []} : null;
    return {
      nodeId: id, nodeType: prompt[id].class_type, promptInput: Object.hasOwn(inputs, 'prompt') ? 'prompt' : null, promptLinked, source,
      textInput: promptLinked ? null : (typeof inputs.prompt === 'string' ? 'prompt' : null),
      toggleInput: typeof inputs.enable_llm === 'boolean' ? 'enable_llm' : null,
      imageInputs: Object.keys(inputs).filter(k => /^input_image_\d+$|^image\d+$/.test(k) && isLink(inputs[k])),
      settings: Object.fromEntries(ENHANCER_SETTINGS.filter(k => inputs[k] !== undefined && !isLink(inputs[k])).map(k => [k, inputs[k]])),
      secretInputs: Object.keys(inputs).filter(k => SECRET_INPUTS.test(k)),
    };
  });
}
/** 读取润色原文（来源节点的文本）。 */
function enhancerOriginal(prompt, enh) { const s = enh?.source; return s ? prompt?.[s.nodeId]?.inputs?.[s.input] ?? null : null; }
/** 写入参数到 prompt 副本；只读或不存在的绑定拒绝。 */
function applyValues(prompt, bindings, values) {
  const next = structuredClone(prompt);
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null) continue;
    const b = key === 'seed' && bindings.seed?.readonly ? bindings.seedSource : bindings[key];
    if (!b || b.readonly) throw Object.assign(new Error(`参数 ${key} 在此工作流中不可编辑。`), {code: 'INVALID_ARGUMENT'});
    next[b.nodeId].inputs[b.input] = value;
  }
  return next;
}
/** 仅润色时替换原文：写入原文来源节点，不改润色节点的连线。 */
function setEnhancerOriginal(prompt, enh, text) {
  if (!enh?.source) throw Object.assign(new Error('找不到润色节点的原文来源（prompt 既不是文本也没有连到可编辑的文本节点）。'), {code: 'INVALID_ARGUMENT'});
  const next = structuredClone(prompt);
  next[enh.source.nodeId].inputs[enh.source.input] = text;
  return next;
}
/**
 * Q08：仅润色子图 = 润色节点及其上游；输出用核心节点 PreviewAny。不包含下游绘图节点。
 * rerun=true 时改变 cache_buster，让同一原文重新调用 LLM。
 */
function extractEnhanceOnly(prompt, enhancerId, {objectInfo, previewType = 'PreviewAny', rerun = false, now = Date.now} = {}) {
  if (!prompt?.[enhancerId]) throw new Error('找不到润色节点。');
  const info = objectInfo?.[prompt[enhancerId].class_type];
  if (objectInfo && !info) throw new Error(`当前 ComfyUI 没有节点 ${prompt[enhancerId].class_type}。`);
  const keep = upstream(prompt, enhancerId);
  const sub = Object.fromEntries([...keep].map(id => [id, structuredClone(prompt[id])]));
  const en = findEnhancers(sub).find(e => e.nodeId === enhancerId);
  if (en?.toggleInput) sub[enhancerId].inputs[en.toggleInput] = true;
  if (rerun && typeof sub[enhancerId].inputs.cache_buster === 'number') sub[enhancerId].inputs.cache_buster = (sub[enhancerId].inputs.cache_buster + 1 + (now() % 997)) % 1000000;
  const outputs = info?.output ?? [];
  const outputIndex = outputs.length ? outputs.indexOf('STRING') : 0;
  if (outputIndex < 0) throw new Error('润色节点没有文本输出。');
  if (info?.output_node) return {prompt: sub, outputNode: enhancerId, outputIndex};
  if (objectInfo && !objectInfo[previewType]) throw new Error(`润色节点不是输出节点，且当前 ComfyUI 没有 ${previewType} 节点，无法单独读取润色文本。请升级 ComfyUI。`);
  const outId = 'yz_enhance_out';
  sub[outId] = {class_type: previewType, inputs: {source: [enhancerId, outputIndex]}};
  return {prompt: sub, outputNode: outId, outputIndex};
}
/** 从 history 输出中读取润色文本（PreviewAny 的 ui.text）。 */
function readEnhancedText(outputs, nodeId) {
  const o = outputs?.[nodeId];
  const v = o?.text ?? o?.string ?? o?.value;
  const text = Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : null;
  return text && text.trim() ? text : null;
}
/**
 * 采用润色文本：本次提交副本中让润色节点的 prompt 改由专用文本节点提供（forceInput 插槽只接受连线），
 * 并关闭 enable_llm（插件此时原样返回 prompt），后续绘图不再调用 Gemma。用户原图不变。
 */
function adoptEnhanced(prompt, enhancer, text, {objectInfo = null} = {}) {
  if (!enhancer?.promptInput) throw new Error('润色节点没有 prompt 输入。');
  if (!enhancer.toggleInput) throw new Error('润色节点没有 enable_llm 开关，无法在采用文本后避免重复调用；请改为手动把文本粘贴到提示词。');
  const next = structuredClone(prompt);
  const ins = next[enhancer.nodeId].inputs;
  if (enhancer.promptLinked) {
    if (objectInfo && !objectInfo.PrimitiveStringMultiline) throw new Error('当前 ComfyUI 没有 PrimitiveStringMultiline 节点，无法在不修改原图的情况下采用润色文本。');
    next.yz_adopted_text = {class_type: 'PrimitiveStringMultiline', inputs: {value: text}};
    ins[enhancer.promptInput] = ['yz_adopted_text', 0];
  } else ins[enhancer.promptInput] = text;
  ins[enhancer.toggleInput] = false;
  return next;
}
/** Q09：润色运行前检查。上下文以图中节点实际值为准（缺失时用设置值），要求 8192；参考图最多 2 张。 */
function checkEnhancerRun(prompt, enhancer, {contextLength, maxReferenceImages = 2, requiredContext = 8192} = {}) {
  const notes = [];
  const graphCtx = enhancer.settings?.context_length;
  const ctx = graphCtx ?? contextLength;
  if (ctx !== undefined && ctx !== requiredContext) notes.push({level: 'error', message: `Gemma 上下文为 ${ctx}${graphCtx !== undefined ? '（工作流节点中的值）' : '（设置值）'}，与补丁要求的 ${requiredContext} 不一致。`});
  const refs = enhancer.imageInputs.length;
  if (refs > maxReferenceImages) notes.push({level: 'error', message: `润色节点连接了 ${refs} 张参考图，当前补丁最多读取 ${maxReferenceImages} 张。`});
  else if (refs) notes.push({level: 'info', message: `润色读取 ${refs} 张参考图；第三张及之后的参考图仍只交给 Qwen。`});
  if (enhancer.settings?.release_vram === false) notes.push({level: 'warning', message: '润色节点 release_vram=false：Gemma 与 Qwen 共用显存，可能显存不足。'});
  return notes;
}
module.exports = {inferBindings, applyValues, findEnhancers, enhancerOriginal, setEnhancerOriginal, extractEnhanceOnly, readEnhancedText, adoptEnhanced, checkEnhancerRun, isLink, upstream, traceEncoder, traceText, ENCODERS, SECRET_INPUTS};
