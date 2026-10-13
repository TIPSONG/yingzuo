'use strict';
// 工作区（E03/E06/F05）：工作区元数据 workspace.json（v2）+ 每个标签一份草稿图 drafts/<id>.json。
// 内存结构仍带 graph，便于主进程使用；磁盘上以 graphRef + graphHash 引用并校验。
// v1（图内嵌）文件读取时自动迁移；首次以 v2 写入前由调用方保留 v1 备份。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {randomUUID} = crypto;
const {describe} = require('../workflow-import.js');

const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_TABS = 20;
const WORKSPACE_VERSION = 2;
const MODES = ['graph', 'parameters', 'app'];
function validateGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('请导入含 nodes 的 ComfyUI 工作流（UI 格式）；API 格式需走导入管线转换。');
  if (Buffer.byteLength(JSON.stringify(graph)) > MAX_GRAPH_BYTES) throw new Error('工作副本超过 8 MB，暂不保存。');
  // Array.map skips holes, while JSON would persist them as invalid null nodes.
  for (const node of graph.nodes) if (node === undefined) throw new Error('工作流中存在缺少 id 或 type 的节点。');
  describe(graph);
  return graph;
}
const graphHash = graph => crypto.createHash('sha256').update(JSON.stringify(graph)).digest('hex');
function safeName(name) {
  let value = String(name || '工作流').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80).replace(/[. ]+$/g, '') || '工作流';
  // Windows device names are reserved even with extensions, and trailing dots
  // or spaces are stripped by Win32. Keep exported paths valid on the target OS.
  if (/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(value)) value = ('_' + value).slice(0, 80).replace(/[. ]+$/g, '');
  return value;
}
function emptyWorkspace() { return {version:WORKSPACE_VERSION, activeId:null, tabs:[]}; }
function validViewport(v) {
  return v && typeof v === 'object' && Number.isFinite(v.scale) && v.scale > 0 && v.scale <= 100 && Array.isArray(v.offset) && v.offset.length === 2 && v.offset.every(Number.isFinite) ? {scale:v.scale, offset:[...v.offset]} : null;
}
function normalizeTab(tab, ids) {
  if (!tab || typeof tab !== 'object' || Array.isArray(tab) || typeof tab.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(tab.id) || ids.has(tab.id)) throw new Error('工作区标签标识不正确。');
  ids.add(tab.id); validateGraph(tab.graph);
  const out = {...tab, title:safeName(tab.title), mode:MODES.includes(tab.mode) ? tab.mode : 'graph'};
  out.revision = Number.isInteger(tab.revision) && tab.revision >= 0 ? tab.revision : 0;
  out.viewport = validViewport(tab.viewport);
  out.referenceIds = Array.isArray(tab.referenceIds) ? tab.referenceIds.filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x)).slice(0, 64) : [];
  if (out.formSchemaId !== undefined && out.formSchemaId !== null && typeof out.formSchemaId !== 'string') out.formSchemaId = null;
  return out;
}
function validateWorkspace(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || ![1, WORKSPACE_VERSION].includes(data.version) || !Array.isArray(data.tabs) || data.tabs.length > MAX_TABS) throw new Error('工作区版本或标签数据不正确。');
  const ids = new Set();
  const tabs = Array.from(data.tabs, tab => normalizeTab(tab, ids));
  return {...data, version:WORKSPACE_VERSION, tabs, activeId:ids.has(data.activeId) ? data.activeId : tabs[0]?.id || null};
}
const draftsDir = file => path.join(path.dirname(file), 'drafts');
function readWorkspace(file) {
  if (!fs.existsSync(file)) return emptyWorkspace();
  if (fs.statSync(file).size > MAX_WORKSPACE_BYTES) throw new Error('工作区记录超过大小限制，请保留文件并检查。');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data?.version > WORKSPACE_VERSION) throw new Error(`工作区来自更新的映作版本（v${data.version}），已保留原文件，不覆盖。`);
  if (data?.version === WORKSPACE_VERSION && Array.isArray(data.tabs)) {
    const dir = draftsDir(file);
    data.tabs = data.tabs.map(tab => {
      if (tab && tab.graphRef === undefined && tab.graph) return tab; // 内嵌图（手工或旧工具写入）
      if (!tab || typeof tab.graphRef !== 'string' || !/^drafts\/[a-zA-Z0-9-]{1,80}\.json$/.test(tab.graphRef)) throw new Error('工作区标签缺少草稿引用。');
      const draftFile = path.join(dir, path.basename(tab.graphRef));
      if (!fs.existsSync(draftFile)) throw new Error(`草稿文件缺失：${tab.graphRef}`);
      const graph = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
      if (tab.graphHash && graphHash(graph) !== tab.graphHash) throw new Error(`草稿校验不一致：${tab.graphRef}，已保留原文件。`);
      const {graphRef, graphHash: _h, nativeIdentity, ...rest} = tab;
      const out = {...rest, graph};
      const workflowPath = nativeIdentity?.workflowPath ?? tab.workflowPath, documentId = nativeIdentity?.documentId ?? tab.documentId;
      if (workflowPath != null) out.workflowPath = workflowPath;
      if (documentId != null) out.documentId = documentId;
      return out;
    });
  }
  return validateWorkspace(data);
}
function writeAtomic(target, body) {
  const temp = target + '.tmp';
  fs.writeFileSync(temp, body, 'utf8');
  fs.renameSync(temp, target);
}
function writeWorkspace(file, data) {
  // Validate before touching disk: a successful save must remain readable after
  // restart, and malformed data must never replace the previous valid draft.
  const valid = validateWorkspace(data);
  const dir = draftsDir(file);
  const tabs = valid.tabs.map(tab => {
    const {graph, workflowPath, documentId, ...meta} = tab;
    const body = JSON.stringify(graph);
    if (Buffer.byteLength(body) > MAX_GRAPH_BYTES) throw new Error('工作副本超过 8 MB，暂不保存。');
    const nativeIdentity = workflowPath || documentId ? {hostName:`yingzuo-${tab.id}`, workflowPath:workflowPath ?? null, documentId:documentId ?? null} : null;
    return {meta:{...meta, graphRef:`drafts/${tab.id}.json`, graphHash:graphHash(graph), nativeIdentity, ...(workflowPath ? {workflowPath} : {}), ...(documentId ? {documentId} : {})}, body};
  });
  const index = JSON.stringify({...valid, tabs:tabs.map(t => t.meta)}, null, 2);
  if (Buffer.byteLength(index) > MAX_WORKSPACE_BYTES) throw new Error('工作区记录过大，未覆盖已有草稿。');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.mkdirSync(dir, {recursive:true});
  // 先写索引临时文件（确认可写），再写草稿，最后原子替换索引。
  // 任一步失败：回滚本次改写的草稿，旧索引与旧草稿保持一致。
  const probe = file + '.tmp';
  fs.writeFileSync(probe, index, 'utf8');
  const previous = new Map();
  try {
    for (const {meta, body} of tabs) {
      const target = path.join(dir, `${meta.id}.json`);
      if (fs.existsSync(target)) { const old = fs.readFileSync(target, 'utf8'); if (old === body) continue; previous.set(target, old); }
      else previous.set(target, null);
      writeAtomic(target, body);
    }
    fs.renameSync(probe, file);
  } catch (error) {
    for (const [target, old] of previous) { try { if (old === null) fs.rmSync(target, {force:true}); else writeAtomic(target, old); } catch { /* 尽力 */ } }
    try { if (fs.statSync(probe).isFile()) fs.rmSync(probe, {force:true}); } catch { /* 尽力 */ }
    throw error;
  }
}
function addTab(workspace, title, graph, templateId = null) {
  if (workspace.tabs.length >= MAX_TABS) throw new Error('最多同时打开 20 个工作副本。');
  const tab = {id:randomUUID(), title:safeName(title), graph:structuredClone(validateGraph(graph)), templateId, mode:'graph', revision:0, viewport:null, referenceIds:[]};
  workspace.tabs.push(tab);
  return tab;
}
/** 写入新图；内容变化时 revision+1。返回是否变化。 */
function setGraph(tab, graph) {
  validateGraph(graph);
  if (tab.graph && graphHash(tab.graph) === graphHash(graph)) { tab.graph = graph; return false; }
  tab.graph = graph; tab.revision = (tab.revision || 0) + 1; return true;
}
function validateBounds(bounds, size) {
  if (!bounds || ['x','y','width','height'].some(key => !Number.isFinite(bounds[key]))) throw new Error('画布尺寸无效。');
  const x = Math.max(0, Math.min(Math.round(bounds.x), size[0]));
  const y = Math.max(0, Math.min(Math.round(bounds.y), size[1]));
  return {x,y,width:Math.max(0,Math.min(Math.round(bounds.width),size[0]-x)),height:Math.max(0,Math.min(Math.round(bounds.height),size[1]-y))};
}
module.exports = {MAX_GRAPH_BYTES, MAX_TABS, WORKSPACE_VERSION, validateGraph, graphHash, safeName, emptyWorkspace, readWorkspace, writeWorkspace, addTab, setGraph, validateBounds, validViewport};
