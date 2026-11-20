'use strict';
// T03/T04：表单 schema（ParameterBinding 列表）。编辑器与正式表单共用；nodeId 使用编译后 API prompt 中的节点编号
// （子图内节点为“父节点:子节点”），并同时记录 nodeType，校验时类型不同即判失效，绝不按同号节点错绑。
const {schemas, check} = require('./schema.cjs');
const {isLink} = require('./bindings.cjs');
const WIDGET = {seed: 'seed', noise_seed: 'seed', steps: 'int', width: 'int', height: 'int', batch_size: 'int', cfg: 'float', denoise: 'float', prompt: 'text', text: 'text', image: 'image', enable_llm: 'boolean'};
const LABEL = {prompt: '提示词', negative: '负面提示词', seed: 'seed', steps: '步数', cfg: 'CFG', sampler_name: '采样器', scheduler: '调度器', denoise: '重绘强度', width: '宽度', height: '高度', batch: '每次张数', model: '模型'};
const RANGE = {steps: {min: 1, max: 200, step: 1}, cfg: {min: 0, max: 30, step: 0.1}, denoise: {min: 0, max: 1, step: 0.01}, width: {min: 64, max: 8192, step: 8}, height: {min: 64, max: 8192, step: 8}, batch: {min: 1, max: 64, step: 1}, seed: {min: 0, max: 2 ** 53 - 1, step: 1}};

/** 由推断绑定生成默认表单（用户之后可改名称/分组/顺序/范围）。只包含可编辑（未连线）字段。 */
function fromBindings(b) {
  const out = [];
  let order = 0;
  const push = (key, f, extra = {}) => {
    if (!f || f.readonly) return;
    const widgetType = key === 'seed' ? 'seed' : WIDGET[f.input] ?? (typeof f.value === 'number' ? (Number.isInteger(f.value) ? 'int' : 'float') : typeof f.value === 'boolean' ? 'boolean' : typeof f.value === 'string' && f.value.length > 60 ? 'text' : 'string');
    out.push({scopePath: [], nodeId: String(f.nodeId), nodeType: f.nodeType, fieldName: f.input, widgetType, constraints: {...(RANGE[key] ?? {}), ...(widgetType === 'text' ? {multiline: true} : {})}, label: LABEL[key] ?? key, group: ['prompt', 'negative'].includes(key) ? '提示词' : ['width', 'height', 'batch'].includes(key) ? '尺寸' : key === 'model' ? '模型' : '采样', order: order++, defaultValue: f.value, ...extra});
  };
  for (const key of ['prompt', 'negative', 'width', 'height', 'batch', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'model']) push(key, key === 'seed' && b.seed?.readonly ? b.seedSource : b[key]);
  (b.references ?? []).forEach((r, i) => push(`ref${i}`, r, {label: `参考图 ${i + 1}`, group: '参考图', widgetType: 'image', slot: `ref${i + 1}`}));
  if (b.enhancer?.toggleInput) out.push({scopePath: [], nodeId: b.enhancer.nodeId, nodeType: b.enhancer.nodeType, fieldName: b.enhancer.toggleInput, widgetType: 'boolean', constraints: {}, label: '自动润色（Gemma）', group: '润色', order: order++, defaultValue: true});
  return out;
}
function validateSchema(list) {
  if (!Array.isArray(list) || list.length > 200) return ['表单字段须为数组且不超过 200 个。'];
  const errors = [];
  const seen = new Set();
  list.forEach((b, i) => {
    errors.push(...check(schemas.ParameterBinding, b, `字段[${i}]`));
    const key = `${b?.nodeId}/${b?.fieldName}`;
    if (seen.has(key)) errors.push(`字段[${i}] 与前面的字段绑定同一个输入 ${key}。`);
    seen.add(key);
    const c = b?.constraints ?? {};
    if (c.min !== undefined && c.max !== undefined && c.min > c.max) errors.push(`字段[${i}] 最小值大于最大值。`);
  });
  return errors;
}
/** T04：用当前编译结果校验映射。状态：ok / missing-node / type-changed / missing-field / linked。 */
function validateMapping(list, prompt) {
  return list.map(b => {
    const node = prompt?.[b.nodeId];
    let status = 'ok', reason = null;
    if (!node) { status = 'missing-node'; reason = `节点 ${b.nodeId} 已不存在（被删除或子图结构变化）。`; }
    else if (node.class_type !== b.nodeType) { status = 'type-changed'; reason = `节点 ${b.nodeId} 的类型从 ${b.nodeType} 变为 ${node.class_type}，不会自动套用。`; }
    else if (!Object.hasOwn(node.inputs ?? {}, b.fieldName)) { status = 'missing-field'; reason = `节点 ${b.nodeId} 没有输入 ${b.fieldName}。`; }
    else if (isLink(node.inputs[b.fieldName])) { status = 'linked'; reason = `输入 ${b.fieldName} 已改为连线，表单不能再写入。`; }
    const candidates = status === 'ok' ? [] : Object.keys(prompt ?? {}).filter(id => prompt[id].class_type === b.nodeType && Object.hasOwn(prompt[id].inputs ?? {}, b.fieldName) && !isLink(prompt[id].inputs[b.fieldName]));
    return {binding: b, status, reason, candidates};
  });
}
/** 重新绑定：目标节点必须同类型、同字段且未连线。 */
function rebind(binding, prompt, nodeId) {
  const node = prompt?.[nodeId];
  if (!node) throw new Error(`节点 ${nodeId} 不存在。`);
  if (node.class_type !== binding.nodeType) throw new Error(`节点 ${nodeId} 类型是 ${node.class_type}，与字段要求的 ${binding.nodeType} 不同。`);
  if (!Object.hasOwn(node.inputs ?? {}, binding.fieldName) || isLink(node.inputs[binding.fieldName])) throw new Error(`节点 ${nodeId} 的 ${binding.fieldName} 不可写入。`);
  return {...binding, nodeId: String(nodeId)};
}
/**
 * C06：字段约束校验（纯函数，主进程写回入口与运行前共用；前端只做即时提示）。
 * 返回 null 表示通过，否则返回中文原因。检查类型、有限数字、整数、范围、选项与步长。
 */
const INT_TYPES = new Set(['int', 'seed']), NUM_TYPES = new Set(['number', 'int', 'float', 'seed']), BOOL_TYPES = new Set(['toggle', 'boolean']), STR_TYPES = new Set(['string', 'text', 'customtext']);
function checkFieldValue(binding, value) {
  const name = binding?.label ?? binding?.fieldName ?? '字段', t = binding?.widgetType, c = binding?.constraints ?? {};
  if (NUM_TYPES.has(t) || (t === undefined && typeof value === 'number')) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `“${name}”必须是有效数字。`;
    if (INT_TYPES.has(t) && !Number.isInteger(value)) return `“${name}”必须是整数。`;
    if (c.min !== undefined && value < c.min) return `“${name}”不能小于 ${c.min}。`;
    if (c.max !== undefined && value > c.max) return `“${name}”不能大于 ${c.max}。`;
    if (c.step && c.step > 0 && INT_TYPES.has(t) && c.step >= 1) { const base = c.min ?? 0; if (Math.abs(((value - base) / c.step) - Math.round((value - base) / c.step)) > 1e-9) return `“${name}”须按步长 ${c.step} 取值。`; }
    return null;
  }
  if (BOOL_TYPES.has(t)) return typeof value === 'boolean' ? null : `“${name}”必须是开/关。`;
  if (STR_TYPES.has(t)) return typeof value === 'string' ? (value.length > 200000 ? `“${name}”过长。` : null) : `“${name}”必须是文本。`;
  if (t === 'combo') { if (Array.isArray(c.values) && c.values.length && !c.values.some(v => String(v) === String(value))) return `“${name}”不是可选项之一。`; return ['string', 'number'].includes(typeof value) ? null : `“${name}”取值无效。`; }
  if (t === 'image') return typeof value === 'string' ? null : `“${name}”必须是图片文件名。`;
  return null;
}
/** 表单值 → prompt 副本（运行时使用；失效字段拒绝）。 */
function applyForm(list, prompt, values) {
  const next = structuredClone(prompt);
  const map = validateMapping(list, prompt);
  for (const [i, value] of Object.entries(values ?? {})) {
    const m = map[Number(i)];
    if (!m) throw new Error(`表单没有第 ${i} 个字段。`);
    if (m.status !== 'ok') throw new Error(`字段“${m.binding.label ?? m.binding.fieldName}”映射失效：${m.reason}`);
    const bad = checkFieldValue(m.binding, value); if (bad) throw new Error(bad);
    next[m.binding.nodeId].inputs[m.binding.fieldName] = value;
  }
  return next;
}
module.exports = {fromBindings, validateSchema, validateMapping, rebind, applyForm, checkFieldValue};
