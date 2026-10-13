'use strict';
// E07：从 API prompt 推断可编辑参数（按节点类型与连线，不按 widget 序号猜）。
// 已连线的输入只读；未知节点不生成绑定。Q08/Q09：Gemma（LM Studio Prompt Enhancer）节点的识别、
// 仅润色子图提取、采用文本后关闭再次调用。节点输入名以 object_info 为准，缺失时只读。
const isLink = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);
const TEXT_ENCODERS = /^(CLIPTextEncode|TextEncodeQwenImageEdit(Plus)?|CLIPTextEncodeFlux|CLIPTextEncodeSDXL)$/;
const ENHANCER = /lm.?studio|prompt.?enhanc|gemma/i;
const LATENT = /^(EmptyLatentImage|EmptySD3LatentImage|EmptyHunyuanLatentVideo|EmptyQwenImageLayeredLatentImage)$/;

function upstream(prompt, id, seen = new Set()) {
  if (seen.has(id) || !prompt[id]) return seen;
  seen.add(id);
  for (const v of Object.values(prompt[id].inputs ?? {})) if (isLink(v)) upstream(prompt, v[0], seen);
  return seen;
}
/** 沿连线向上找第一个满足 pred 的节点（穿过 reroute/条件组合等透传节点）。 */
function findUp(prompt, link, pred, depth = 0) {
  if (!isLink(link) || depth > 12) return null;
  const node = prompt[link[0]];
  if (!node) return null;
  if (pred(node, link[0])) return link[0];
  for (const v of Object.values(node.inputs ?? {})) { const r = findUp(prompt, v, pred, depth + 1); if (r) return r; }
  return null;
}
function field(prompt, nodeId, input, extra = {}) {
  const node = prompt[nodeId];
  const value = node?.inputs?.[input];
  if (value === undefined) return null;
  return {nodeId, nodeType: node.class_type, input, value: isLink(value) ? null : value, readonly: isLink(value), ...extra};
}
function inferBindings(prompt) {
  const out = {};
  const put = (key, f) => { if (f && !out[key]) out[key] = f; };
  const ids = Object.keys(prompt ?? {});
  const sampler = ids.find(id => SAMPLERS.has(prompt[id].class_type));
  if (sampler) {
    const s = prompt[sampler];
    for (const k of ['seed', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) put(k === 'noise_seed' ? 'seed' : k, field(prompt, sampler, k));
    if (out.seed?.readonly) { const src = findUp(prompt, s.inputs.seed ?? s.inputs.noise_seed, n => typeof n.inputs?.seed === 'number' || typeof n.inputs?.noise_seed === 'number'); if (src) put('seedSource', field(prompt, src, prompt[src].inputs.seed !== undefined ? 'seed' : 'noise_seed')); }
    for (const [key, inputName] of [['prompt', 'positive'], ['negative', 'negative']]) {
      const enc = findUp(prompt, s.inputs[inputName], n => TEXT_ENCODERS.test(n.class_type));
      if (!enc) continue;
      const textKey = ['text', 'prompt'].find(k => Object.hasOwn(prompt[enc].inputs, k));
      if (!textKey) continue;
      const f = field(prompt, enc, textKey);
      if (f.readonly) { // 文本来自上游（如 Gemma 润色节点）：绑定到上游的原始文本输入
        const src = findUp(prompt, prompt[enc].inputs[textKey], n => !isLink(n.inputs?.prompt ?? n.inputs?.text) && (typeof n.inputs?.prompt === 'string' || typeof n.inputs?.text === 'string'));
        if (src) { put(key, field(prompt, src, typeof prompt[src].inputs.prompt === 'string' ? 'prompt' : 'text', {via: enc})); continue; }
      }
      put(key, f);
    }
    const latent = findUp(prompt, s.inputs.latent_image, n => LATENT.test(n.class_type));
    if (latent) { put('width', field(prompt, latent, 'width')); put('height', field(prompt, latent, 'height')); put('batch', field(prompt, latent, 'batch_size')); }
  }
  for (const id of ids) {
    const n = prompt[id];
    if (/^(UNETLoader|UnetLoaderGGUF|CheckpointLoaderSimple)$/.test(n.class_type)) put('model', field(prompt, id, n.inputs.unet_name !== undefined ? 'unet_name' : 'ckpt_name'));
    if (n.class_type === 'LoadImage') (out.references ??= []).push(field(prompt, id, 'image'));
  }
  const enh = findEnhancers(prompt);
  if (enh.length) out.enhancer = enh[0];
  return out;
}
function findEnhancers(prompt) {
  return Object.keys(prompt ?? {}).filter(id => ENHANCER.test(prompt[id].class_type)).map(id => {
    const inputs = prompt[id].inputs ?? {};
    const textInput = ['prompt', 'text', 'user_prompt', 'input_text'].find(k => typeof inputs[k] === 'string') ?? null;
    return {nodeId: id, nodeType: prompt[id].class_type, textInput, toggleInput: typeof inputs.enable_llm === 'boolean' ? 'enable_llm' : null, imageInputs: Object.keys(inputs).filter(k => /image/i.test(k) && isLink(inputs[k]))};
  });
}
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
/**
 * Q08：仅润色子图 = 润色节点及其上游；输出用核心节点 PreviewAny（object_info 中必须存在）。
 * 不包含任何下游绘图节点，因此不会偷偷出图。
 */
function extractEnhanceOnly(prompt, enhancerId, {objectInfo, previewType = 'PreviewAny'} = {}) {
  if (!prompt?.[enhancerId]) throw new Error('找不到润色节点。');
  const info = objectInfo?.[prompt[enhancerId].class_type];
  if (objectInfo && !info) throw new Error(`当前 ComfyUI 没有节点 ${prompt[enhancerId].class_type}。`);
  const keep = upstream(prompt, enhancerId);
  const sub = Object.fromEntries([...keep].map(id => [id, structuredClone(prompt[id])]));
  const en = findEnhancers(sub).find(e => e.nodeId === enhancerId);
  if (en?.toggleInput) sub[enhancerId].inputs[en.toggleInput] = true;
  const outputIndex = Math.max(0, (info?.output ?? []).indexOf('STRING'));
  if (info?.output_node) return {prompt: sub, outputNode: enhancerId, outputIndex};
  if (objectInfo && !objectInfo[previewType]) throw new Error(`润色节点不是输出节点，且当前 ComfyUI 没有 ${previewType} 节点，无法单独读取润色文本。请升级 ComfyUI。`);
  const outId = `yz_enhance_out`;
  sub[outId] = {class_type: previewType, inputs: {source: [enhancerId, outputIndex]}};
  return {prompt: sub, outputNode: outId, outputIndex};
}
/** 从 history 输出中读取润色文本（PreviewAny/文本输出节点的 ui.text 或 ui.string）。 */
function readEnhancedText(outputs, nodeId) {
  const o = outputs?.[nodeId];
  const v = o?.text ?? o?.string ?? o?.value;
  const text = Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : null;
  return text && text.trim() ? text : null;
}
/** Q08：采用润色文本——写入润色节点原文输入，并关闭其 LLM 调用，后续绘图不重复调用 Gemma。 */
function adoptEnhanced(prompt, enhancer, text) {
  if (!enhancer?.textInput) throw new Error('润色节点没有可写入的文本输入。');
  if (!enhancer.toggleInput) throw new Error('润色节点没有 enable_llm 开关，无法在采用文本后避免重复调用；请改为手动把文本粘贴到提示词。');
  const next = structuredClone(prompt);
  next[enhancer.nodeId].inputs[enhancer.textInput] = text;
  next[enhancer.nodeId].inputs[enhancer.toggleInput] = false;
  return next;
}
/** Q09：自动润色生成前检查——8192 上下文、参考图数量。返回提示，不阻止（数量超限除外）。 */
function checkEnhancerRun(prompt, enhancer, {contextLength, maxReferenceImages = 2} = {}) {
  const notes = [];
  if (contextLength !== undefined && contextLength !== 8192) notes.push({level: 'error', message: `Gemma 上下文设置为 ${contextLength}，与补丁要求的 8192 不一致。`});
  const refs = enhancer.imageInputs.length;
  if (refs > maxReferenceImages) notes.push({level: 'error', message: `润色节点连接了 ${refs} 张参考图，当前补丁最多读取 ${maxReferenceImages} 张。`});
  else if (refs) notes.push({level: 'info', message: `润色读取 ${refs} 张参考图；第三张及之后的参考图仍只交给 Qwen。Gemma 与 Qwen 共用显存，润色后由节点卸载模型。`});
  return notes;
}
module.exports = {inferBindings, applyValues, findEnhancers, extractEnhanceOnly, readEnhancedText, adoptEnhanced, checkEnhancerRun, isLink, upstream};
