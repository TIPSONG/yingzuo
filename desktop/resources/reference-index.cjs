'use strict';
// R03：引用索引。从模板、开放草稿、任务快照（UI workflow 或 API prompt）以及插件依赖声明中收集模型引用；
// 目录变化后重新诊断；移动／移除前给出影响列表。
const path = require('node:path');
const {MODEL_EXT} = require('./model-scan.cjs');

const norm = s => String(s).replace(/\\/g, '/');
const looksLikeModel = v => typeof v === 'string' && MODEL_EXT.has(path.extname(v).toLowerCase());

/** 从图中抽取 {nodeId, nodeType, field, value}。兼容 UI workflow（nodes[]/widgets_values）与 API prompt。 */
function extractRefs(graph) {
  const out = [];
  if (!graph || typeof graph !== 'object') return out;
  if (Array.isArray(graph.nodes)) {
    const visit = nodes => { for (const n of nodes) {
      const w = n.widgets_values;
      const vals = Array.isArray(w) ? w.map((v, i) => [String(i), v]) : w && typeof w === 'object' ? Object.entries(w) : [];
      for (const [field, v] of vals) if (looksLikeModel(v)) out.push({nodeId: String(n.id), nodeType: n.type, field, value: norm(v)});
    } };
    visit(graph.nodes);
    for (const sg of graph.definitions?.subgraphs ?? []) if (Array.isArray(sg.nodes)) visit(sg.nodes);
  } else {
    for (const [id, n] of Object.entries(graph)) {
      if (!n || typeof n !== 'object' || !n.inputs) continue;
      for (const [field, v] of Object.entries(n.inputs)) if (looksLikeModel(v)) out.push({nodeId: id, nodeType: n.class_type, field, value: norm(v)});
    }
  }
  return out;
}

class ReferenceIndex {
  constructor() { this.refs = []; }
  /** source: {kind:'template'|'draft'|'task'|'plugin', id, title?, graph?, requires?: string[]} */
  add(source) {
    this.remove(source.kind, source.id);
    if (source.graph) for (const r of extractRefs(source.graph)) this.refs.push({...r, kind: source.kind, sourceId: source.id, title: source.title ?? source.id});
    for (const req of source.requires ?? []) this.refs.push({kind: source.kind, sourceId: source.id, title: source.title ?? source.id, field: 'requires', value: norm(req)});
    return this;
  }
  remove(kind, id) { this.refs = this.refs.filter(r => !(r.kind === kind && r.sourceId === id)); }
  /** 某资源（R01 item）被谁引用。精确按 Comfy 相对名匹配；仅文件名相同的列为“可能”。 */
  referencesTo(item) {
    const name = norm(item.name), base = path.posix.basename(name);
    const exact = [], possible = [];
    for (const r of this.refs) {
      if (r.value === name) exact.push(r);
      else if (path.posix.basename(r.value) === base) possible.push(r);
    }
    return {exact, possible};
  }
  /** 对照扫描结果诊断：缺失引用、仅文件名匹配（子目录变了）。 */
  diagnose(items) {
    const names = new Set(items.map(i => norm(i.name)));
    const byBase = new Map(); for (const i of items) { const b = path.posix.basename(norm(i.name)); (byBase.get(b) ?? byBase.set(b, []).get(b)).push(i); }
    const missing = [], relocated = [];
    for (const r of this.refs) {
      if (names.has(r.value)) continue;
      const cands = byBase.get(path.posix.basename(r.value));
      if (cands?.length) relocated.push({...r, candidates: cands.map(c => c.name)}); else missing.push(r);
    }
    return {missing, relocated, ok: !missing.length && !relocated.length};
  }
  /** 移动／移除影响：返回受影响的来源分组，用于先展示再执行。 */
  impact(item, action = 'remove') {
    const {exact, possible} = this.referencesTo(item);
    const group = list => Object.values(list.reduce((m, r) => { const k = `${r.kind}:${r.sourceId}`; (m[k] ??= {kind: r.kind, sourceId: r.sourceId, title: r.title, nodes: []}).nodes.push({nodeId: r.nodeId, nodeType: r.nodeType, field: r.field}); return m; }, {}));
    return {action, resource: item.name, affected: group(exact), possiblyAffected: group(possible), safe: exact.length === 0,
      note: action === 'move' ? '移动后这些引用需要改成新路径或在 Comfy 中重新选择。' : '移除后这些工作流将无法运行。'};
  }
}

module.exports = {ReferenceIndex, extractRefs};
