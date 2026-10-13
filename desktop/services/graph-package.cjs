'use strict';
// S08：版本化的“图 + 参考素材”包（.yingzuo.json）。包含 UI 图、模板/表单版本、参考关系（槽位 nodeId/input、内容 ID、
// sha256、大小），以及素材本体（base64）。导入时先整体校验所有路径/编号/hash，再写入素材库并分配新的标签。
// 包内不含凭据：图中的凭据占位导出时清空。
const crypto = require('node:crypto');
const fs = require('node:fs');
const {AppError, CODES} = require('../core/errors.cjs');
const SF = require('../../shared/secret-fields.cjs');

const KIND = 'yingzuo-graph-package', VERSION = 1;
const REF_ID = /^([0-9a-f]{64})\.(png|jpe?g|webp)$/;
const MAX_REFS = 64, MAX_REF_BYTES = 50 * 1024 * 1024, MAX_TOTAL = 300 * 1024 * 1024;
const strip = v => (typeof v === 'string' ? (v.startsWith(SF.PLACEHOLDER_PREFIX) ? '' : v) : Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)])) : v);
const cleanText = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);

/** relations: [{nodeId,input,refId,name}]；readRef(refId) → 文件路径或抛错（素材丢失）。 */
function buildPackage({title, graph, template = null, relations = [], readRef, exportGraph = null}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new AppError(CODES.INVALID_ARGUMENT, '没有可导出的图。');
  let total = 0;
  const references = relations.slice(0, MAX_REFS).map(r => {
    const base = {nodeId: String(r.nodeId), input: String(r.input ?? 'image'), refId: r.refId, name: cleanText(r.name)};
    let file; try { file = readRef(r.refId); } catch { return {...base, missing: true}; }
    const buf = fs.readFileSync(file); total += buf.length;
    if (total > MAX_TOTAL) throw new AppError(CODES.INVALID_ARGUMENT, '参考素材合计超过 300 MB，不能打包。');
    return {...base, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, data: buf.toString('base64')};
  });
  return {kind: KIND, version: VERSION, exportedAt: new Date().toISOString(), title: cleanText(title), ...(() => { const ex = exportGraph ? exportGraph(graph) : {graph: strip(graph), refill: []}; return {graph: ex.graph, refill: ex.refill}; })(), template: template ? {templateId: template.templateId ?? null, versionId: template.versionId ?? null, formSchema: template.formSchema ?? null} : null, references};
}
/** 解析并完整校验；任一项不合格整体拒绝（不写任何文件）。 */
function parsePackage(text) {
  if (typeof text !== 'string' || text.length > MAX_TOTAL * 1.4) throw new AppError(CODES.INVALID_ARGUMENT, '包过大或不是文本。');
  let p; try { p = JSON.parse(text); } catch { throw new AppError(CODES.INVALID_ARGUMENT, '包不是有效的 JSON。'); }
  if (p?.kind !== KIND) throw new AppError(CODES.INVALID_ARGUMENT, '不是映作图包。');
  if (p.version !== VERSION) throw new AppError(CODES.UNSUPPORTED, `不支持的图包版本：${p.version}`);
  if (!p.graph || !Array.isArray(p.graph.nodes)) throw new AppError(CODES.INVALID_ARGUMENT, '图包缺少 UI 图。');
  if (!Array.isArray(p.references) || p.references.length > MAX_REFS) throw new AppError(CODES.INVALID_ARGUMENT, '参考素材清单无效。');
  const nodeIds = new Set(); const walk = g => { for (const n of g?.nodes ?? []) nodeIds.add(String(n.id)); };
  walk(p.graph);
  const refs = p.references.map((r, i) => {
    const where = `第 ${i + 1} 项参考素材`;
    if (!r || typeof r.nodeId !== 'string' || !/^[\w:.-]{1,80}$/.test(r.nodeId)) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：槽位无效。`);
    if (typeof r.input !== 'string' || !/^[\w.-]{1,80}$/.test(r.input)) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：输入名无效。`);
    const m = REF_ID.exec(String(r.refId ?? '')); if (!m) throw new AppError(CODES.INVALID_ARGUMENT, `${where}：内容编号无效。`);
    const base = {nodeId: r.nodeId, input: r.input, refId: r.refId, name: cleanText(r.name)};
    if (r.missing) return {...base, missing: true};
    if (typeof r.data !== 'string') throw new AppError(CODES.INVALID_ARGUMENT, `${where}：缺少数据。`);
    const buf = Buffer.from(r.data, 'base64');
    if (buf.length > MAX_REF_BYTES || buf.length !== r.size) throw new AppError(CODES.INTEGRITY, `${where}：大小不符。`);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== r.sha256 || sha !== m[1]) throw new AppError(CODES.INTEGRITY, `${where}：内容校验失败（文件已损坏或被修改）。`);
    return {...base, buffer: buf};
  });
  return {title: cleanText(p.title) || '导入的图', graph: p.graph, template: p.template ?? null, references: refs};
}
module.exports = {buildPackage, parsePackage, KIND, VERSION};
