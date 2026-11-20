'use strict';
// R20：稳定输出身份 + 保存节点适配（纯函数）。
// workflowId 取稳定来源（模板 ID > 导入工作流 ID > 内容指纹），不用每次打开都会变的 tabId。
// SaveImageAdvanced 等非标准保存节点：仅当 object_info 确认存在字符串型前缀字段时才视为可改；否则保持原设置并说明。
const crypto = require('node:crypto');

const PREFIX_CANDIDATES = ['filename_prefix', 'prefix', 'output_prefix'];
const KNOWN = {SaveImage: 'filename_prefix', SaveAnimatedWEBP: 'filename_prefix', SaveAnimatedPNG: 'filename_prefix', SaveVideo: 'filename_prefix', SaveWEBM: 'filename_prefix'};

/** 稳定工作流身份。sources: {templateId, importedWorkflowId, uiGraph}。 */
function stableWorkflowId({templateId = null, importedWorkflowId = null, uiGraph = null} = {}) {
  if (templateId) return `tpl_${String(templateId)}`;
  if (importedWorkflowId) return `wf_${String(importedWorkflowId)}`;
  if (uiGraph?.extra?.yingzuo?.workflowId) return `wf_${uiGraph.extra.yingzuo.workflowId}`;
  if (uiGraph) {
    // 结构指纹：只取节点类型与连线拓扑，忽略 widget 值与位置，参数修改不改变归属
    const nodes = (uiGraph.nodes ?? []).map(n => `${n.id}:${n.type}`).sort();
    const links = (uiGraph.links ?? []).map(l => Array.isArray(l) ? l.slice(1, 5).join(',') : '').sort();
    return `fp_${crypto.createHash('sha256').update(JSON.stringify([nodes, links])).digest('hex').slice(0, 16)}`;
  }
  return null;
}

/** 返回保存节点前缀字段：{key, source:'registered'|'object_info'} 或 {key:null, reason}。 */
function saveNodePrefixKey(classType, objectInfo = null) {
  if (KNOWN[classType]) return {key: KNOWN[classType], source: 'registered'};
  const def = objectInfo?.[classType];
  if (!def) return {key: null, reason: `未取得 ${classType} 的节点定义，保持原保存设置；实际位置以 history 为准`};
  if (!def.output_node) return {key: null, reason: `${classType} 不是输出节点`};
  const inputs = {...(def.input?.required ?? {}), ...(def.input?.optional ?? {})};
  const key = PREFIX_CANDIDATES.find(k => Array.isArray(inputs[k]) && inputs[k][0] === 'STRING');
  return key ? {key, source: 'object_info'} : {key: null, reason: `${classType} 没有可识别的文件名前缀字段，保持原设置并展示原位置`};
}

/** 对 prompt 副本应用目录前缀；dir 由 output-prefix.prefixDir 计算（传入 stableWorkflowId 结果）。 */
function planSavePrefix(prompt, {dir, objectInfo = null}) {
  const copy = structuredClone(prompt ?? {}), changed = [], untouched = [];
  for (const [nodeId, node] of Object.entries(copy)) {
    const type = String(node?.class_type ?? '');
    const isSave = KNOWN[type] || objectInfo?.[type]?.output_node || (/save|export/i.test(type) && !/preview/i.test(type));
    if (!isSave) continue;
    const {key, reason} = saveNodePrefixKey(type, objectInfo);
    if (!key) { untouched.push({nodeId, classType: type, reason}); continue; }
    const before = node.inputs?.[key];
    if (typeof before !== 'string') { untouched.push({nodeId, classType: type, reason: '前缀由连线输入提供，保持原设置；实际位置以 history 为准'}); continue; }
    if (!dir || before.startsWith(`${dir}/`)) continue;
    const leaf = before.split(/[\\/]+/).filter(Boolean).at(-1) || 'ComfyUI';
    node.inputs[key] = `${dir}/${leaf}`;
    changed.push({nodeId, classType: type, key, before, after: node.inputs[key]});
  }
  return {prompt: copy, changed, untouched};
}
module.exports = {stableWorkflowId, saveNodePrefixKey, planSavePrefix};
