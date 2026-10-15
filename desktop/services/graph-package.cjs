'use strict';
// S08/C07：版本化的“图 + 参考素材”包（.yingzuo.json）。包含 UI 图、模板/表单版本、参考关系（槽位 nodeId/input、内容 ID、
// sha256、大小、存在状态），以及素材本体（base64）。导入时先整体校验所有路径/编号/hash/槽位，再写入素材库并分配新的标签。
// 包内不含凭据：导出经统一导出政策（C01），并附需要重新填写的字段清单。
// C07 槽位规则：nodeId 为根图节点编号，或“外层子图实例编号:内层节点编号”（逐层）；节点必须存在；输入名能在节点 inputs 或
// object_info 中确认时必须存在，离线且节点未声明该输入时标“待核实”（连接后诊断），不假装已验证；同一槽位不能出现两次。
// C08：读写整包的重活在 worker 中执行（packBuild / packParse），主进程只传路径与小结果。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../core/errors.cjs');
const {sanitizeFields} = require('../../shared/form-secrets.cjs');
const {createGraphStoragePolicy, assertSafeExport} = require('../../shared/graph-storage-policy.cjs');

const KIND = 'yingzuo-graph-package', VERSION = 1;
const REF_ID = /^([0-9a-f]{64})\.(png|jpe?g|webp)$/;
const MAX_REFS = 64, MAX_REF_BYTES = 50 * 1024 * 1024, MAX_TOTAL = 300 * 1024 * 1024, MAX_FILE = Math.ceil(MAX_TOTAL * 1.4) + 16 * 1024 * 1024;
const cleanText = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);

/** 按 nodeId（可含子图实例路径 a:b:c）在图中定位节点。返回 {node, scope} 或 null。 */
function resolveSlotNode(graph, nodeId) {
  const defs = new Map((graph?.definitions?.subgraphs ?? []).map(d => [String(d.id), d]));
  const parts = String(nodeId).split(':');
  let nodes = graph?.nodes ?? [], node = null, scope = 'root';
  for (let i = 0; i < parts.length; i++) {
    node = nodes.find(n => String(n?.id) === parts[i]); if (!node) return null;
    if (i < parts.length - 1) { const def = defs.get(String(node.type)); if (!def) return null; nodes = def.nodes ?? []; scope = `subgraph:${def.id}`; }
  }
  return {node, scope};
}
/** C07：整体校验槽位；返回每项 {scope, verify: 'ok'|'unverified'}；任何不合格抛错。 */
function validateSlots(graph, refs, {objectInfo = null} = {}) {
  const seen = new Set();
  return refs.map((r, i) => {
    const where = `第 ${i + 1} 项参考素材`;
    const key = `${r.nodeId}/${r.input}`;
    if (seen.has(key)) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：与前面的素材使用同一槽位 ${key}。`);
    seen.add(key);
    const hit = resolveSlotNode(graph, r.nodeId);
    if (!hit) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：图中没有节点 ${r.nodeId}（或子图实例路径不成立）。`);
    const declared = (hit.node.inputs ?? []).some(x => x?.name === r.input || x?.widget?.name === r.input);
    const info = objectInfo?.[hit.node.type]?.input;
    if (declared || (info && (Object.hasOwn(info.required ?? {}, r.input) || Object.hasOwn(info.optional ?? {}, r.input)))) return {scope: hit.scope, verify: 'ok'};
    if (info) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：节点 ${r.nodeId}（${hit.node.type}）没有输入 ${r.input}。`);
    return {scope: hit.scope, verify: 'unverified'};
  });
}
/** relations: [{nodeId,input,refId,name}]；readRef(refId) → 文件路径或抛错（素材丢失）。超限直接拒绝，不截断、不生成无法导入的包。 */
function buildPackage({title, graph, template = null, relations = [], readRef, exportGraph = null}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new AppError(CODES.INVALID_ARGUMENT, '没有可导出的图。');
  if (relations.length > MAX_REFS) throw new AppError(CODES.INVALID_ARGUMENT, `参考素材超过 ${MAX_REFS} 项，不能打包。`);
  const dropped = [];
  const live = relations.filter(r => { if (resolveSlotNode(graph, r.nodeId)) return true; dropped.push(cleanText(r.name) || r.refId); return false; }); // 节点已删除的旧关系不进包
  const slots = validateSlots(graph, live.map(r => ({nodeId: String(r.nodeId), input: String(r.input ?? 'image')})));
  let total = 0;
  const references = live.map((r, i) => {
    const base = {nodeId: String(r.nodeId), input: String(r.input ?? 'image'), scope: slots[i].scope, refId: r.refId, name: cleanText(r.name)};
    let file; try { file = readRef(r.refId); } catch { return {...base, missing: true}; }
    const size = fs.statSync(file).size; // 读取前检查上限
    if (size > MAX_REF_BYTES) throw new AppError(CODES.INVALID_ARGUMENT, `参考素材 ${base.name || r.refId} 超过 50 MB，不能打包。`);
    if ((total += size) > MAX_TOTAL) throw new AppError(CODES.INVALID_ARGUMENT, '参考素材合计超过 300 MB，不能打包。');
    const buf = fs.readFileSync(file);
    return {...base, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, data: buf.toString('base64')};
  });
  const ex = assertSafeExport(exportGraph ? exportGraph(graph) : createGraphStoragePolicy().stripForExport(graph));
  return {kind: KIND, version: VERSION, exportedAt: new Date().toISOString(), title: cleanText(title), graph: ex.graph, refill: ex.refill ?? [], template: template ? {templateId: template.templateId ?? null, versionId: template.versionId ?? null, formSchema: sanitizeFields(template.formSchema ?? null)} : null, references, dropped};
}
/** 解析并完整校验；任一项不合格整体拒绝（不写任何文件）。 */
function parsePackage(text, {objectInfo = null} = {}) {
  if (typeof text !== 'string' || text.length > MAX_FILE) throw new AppError(CODES.INVALID_ARGUMENT, '包过大或不是文本。');
  let p; try { p = JSON.parse(text); } catch { throw new AppError(CODES.INVALID_ARGUMENT, '包不是有效的 JSON。'); }
  if (p?.kind !== KIND) throw new AppError(CODES.INVALID_ARGUMENT, '不是映作图包。');
  if (p.version !== VERSION) throw new AppError(CODES.UNSUPPORTED, `不支持的图包版本：${p.version}`);
  if (!p.graph || !Array.isArray(p.graph.nodes)) throw new AppError(CODES.INVALID_ARGUMENT, '图包缺少 UI 图。');
  if (!Array.isArray(p.references) || p.references.length > MAX_REFS) throw new AppError(CODES.INVALID_ARGUMENT, '参考素材清单无效。');
  let total = 0;
  const refs = p.references.map((r, i) => {
    const where = `第 ${i + 1} 项参考素材`;
    if (!r || typeof r.nodeId !== 'string' || !/^[\w.-]{1,40}(:[\w.-]{1,40}){0,7}$/.test(r.nodeId)) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：槽位无效。`);
    if (typeof r.input !== 'string' || !/^[\w.-]{1,80}$/.test(r.input)) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：输入名无效。`);
    const m = REF_ID.exec(String(r.refId ?? '')); if (!m) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：内容编号无效。`);
    const base = {nodeId: r.nodeId, input: r.input, refId: r.refId, name: cleanText(r.name)};
    if (r.missing) return {...base, missing: true};
    if (typeof r.data !== 'string' || !Number.isInteger(r.size) || r.size > MAX_REF_BYTES) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：缺少数据或超过 50 MB。`);
    if ((total += r.size) > MAX_TOTAL) throw new AppError(CODES.INVALID_ARGUMENT, '参考素材合计超过 300 MB。');
    const buf = Buffer.from(r.data, 'base64');
    if (buf.length !== r.size) throw new AppError(CODES.INTEGRITY, `${where}：大小不符。`);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== r.sha256 || sha !== m[1]) throw new AppError(CODES.INTEGRITY, `${where}：内容校验失败（文件已损坏或被修改）。`);
    return {...base, buffer: buf};
  });
  const slots = validateSlots(p.graph, refs, {objectInfo});
  refs.forEach((r, i) => Object.assign(r, slots[i]));
  const form = p.template?.formSchema;
  if (form != null && !Array.isArray(form)) throw new AppError(CODES.INVALID_ARGUMENT, '图包中的表单无效。');
  return {title: cleanText(p.title) || '导入的图', graph: p.graph, template: p.template ?? null, refill: Array.isArray(p.refill) ? p.refill.slice(0, 200) : [], references: refs};
}

/* ---------- C08：worker 侧（只在 worker 线程调用；主进程只传路径） ---------- */
/** relations 中的 file 由主进程解析（null 表示素材丢失）。写到 target 的临时名后改名。 */
function workerBuild({target, tmp: given, title, graph, template, relations, exportedGraph, refill}) {
  const files = new Map(relations.map(r => [r.refId, r.file]));
  const pkg = buildPackage({title, graph, template, relations, readRef: id => { const f = files.get(id); if (!f) throw new Error('missing'); return f; }, exportGraph: exportedGraph ? () => ({graph: exportedGraph, refill: refill ?? []}) : null});
  const tmp = given ?? `${target}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(pkg)); fs.renameSync(tmp, target);
  return {path: target, references: pkg.references.length, missing: pkg.references.filter(r => r.missing).map(r => r.name || r.refId), dropped: pkg.dropped, refill: pkg.refill};
}
/** 读取前检查文件大小；校验通过后把素材写入 stageDir/<refId>，返回不含 Buffer 的结果。 */
function workerParse({file, stageDir, objectInfo = null}) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_FILE) throw new AppError(CODES.INVALID_ARGUMENT, '图包过大或不是文件。');
  const p = parsePackage(fs.readFileSync(file, 'utf8'), {objectInfo});
  fs.mkdirSync(stageDir, {recursive: true});
  const references = p.references.map(({buffer, ...r}) => { if (!buffer) return r; const staged = path.join(stageDir, r.refId); fs.writeFileSync(staged, buffer); return {...r, staged}; });
  return {...p, references};
}
module.exports = {buildPackage, parsePackage, validateSlots, resolveSlotNode, workerBuild, workerParse, KIND, VERSION, MAX_REFS};
