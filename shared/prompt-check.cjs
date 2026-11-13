'use strict';
// E09：提交前本地检查（不替代 ComfyUI 的服务端校验）。只检查能确定的结构问题，不猜节点语义。
function checkPrompt(prompt, {objectInfo = null} = {}) {
  const issues = [];
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return [{level: 'error', message: 'API prompt 不是对象。'}];
  const ids = Object.keys(prompt);
  if (!ids.length) return [{level: 'error', message: '空图：没有可执行节点。'}];
  for (const id of ids) {
    const node = prompt[id];
    if (!node || typeof node.class_type !== 'string' || !node.class_type) { issues.push({level: 'error', nodeId: id, message: `节点 ${id} 缺少 class_type。`}); continue; }
    if (objectInfo && !objectInfo[node.class_type]) issues.push({level: 'error', nodeId: id, nodeType: node.class_type, message: `节点类型 ${node.class_type} 在当前 ComfyUI 中不存在（缺少自定义节点？）。`});
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1])) {
        if (!Object.hasOwn(prompt, value[0])) issues.push({level: 'error', nodeId: id, nodeType: node.class_type, input: name, message: `输入 ${name} 连接到不存在的节点 ${value[0]}（可能被静音/删除）。`});
      }
    }
    const req = objectInfo?.[node.class_type]?.input?.required;
    if (req) for (const name of Object.keys(req)) if (!Object.hasOwn(node.inputs ?? {}, name)) issues.push({level: 'error', nodeId: id, nodeType: node.class_type, input: name, message: `必填输入 ${name} 未提供。`});
  }
  if (objectInfo && !ids.some(id => objectInfo[prompt[id]?.class_type]?.output_node)) issues.push({level: 'error', message: '没有输出节点（如 SaveImage），ComfyUI 会拒绝执行。'});
  return issues;
}
module.exports = {checkPrompt};
