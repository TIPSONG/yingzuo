'use strict';
// S07：把表单字段（API 节点编号，子图内为“实例:内部节点”）映射到 UI 根图中的可编辑 widget {graphId, nodeId, widgetName}。
// 正式参数面板的修改写回同一 UI 根图（经编辑器桥接），运行/快捷键/批量/润色都从该图编译，因此共用同一份工作副本。
// 子图定义被多个实例共享时，写定义会同时改变所有实例——这种字段标为 shared，不提供单独编辑，避免串写。

function subgraphDefs(ui) { return new Map((ui?.definitions?.subgraphs ?? []).map(d => [String(d.id), d])); }
function instanceCounts(ui, defs) {
  const n = new Map();
  for (const g of [ui, ...defs.values()]) for (const node of g?.nodes ?? []) if (defs.has(String(node.type))) n.set(String(node.type), (n.get(String(node.type)) ?? 0) + 1);
  return n;
}
/**
 * @returns [{index, target: {graphId|null, nodeId, widgetName}|null, status: 'ok'|'missing'|'shared'|'type', reason}]
 */
function mapFormTargets(fields, ui) {
  const defs = subgraphDefs(ui), counts = instanceCounts(ui, defs);
  return (fields ?? []).map((f, index) => {
    const segs = String(f.nodeId ?? '').split(':').filter(Boolean);
    if (!segs.length) return {index, target: null, status: 'missing', reason: '字段没有节点编号。'};
    let graph = ui, graphId = null, node = null;
    for (let i = 0; i < segs.length; i++) {
      node = (graph?.nodes ?? []).find(n => String(n.id) === segs[i]);
      if (!node) return {index, target: null, status: 'missing', reason: `节点 ${segs.slice(0, i + 1).join(':')} 不存在。`};
      if (i < segs.length - 1) {
        const def = defs.get(String(node.type));
        if (!def) return {index, target: null, status: 'missing', reason: `节点 ${segs.slice(0, i + 1).join(':')} 不是子图。`};
        if ((counts.get(String(node.type)) ?? 0) > 1) return {index, target: null, status: 'shared', reason: '该子图在图中被多处使用，修改会同时影响所有实例，请在画布中编辑。'};
        graph = def; graphId = String(def.id);
      }
    }
    if (f.nodeType && node.type !== f.nodeType) return {index, target: null, status: 'type', reason: `节点类型已变为 ${node.type}。`};
    return {index, target: {graphId, nodeId: node.id, widgetName: f.fieldName}, status: 'ok', reason: null};
  });
}
module.exports = {mapFormTargets};
