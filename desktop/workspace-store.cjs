'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {describe} = require('../workflow-import.js');

const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_TABS = 20;
function validateGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('桌面 P0 请导入含 nodes 的 ComfyUI 工作流；API 图的可视化转换将在后续适配。');
  if (Buffer.byteLength(JSON.stringify(graph)) > MAX_GRAPH_BYTES) throw new Error('工作副本超过 8 MB，暂不保存。');
  // Array.map skips holes, while JSON would persist them as invalid null nodes.
  for (const node of graph.nodes) if (node === undefined) throw new Error('工作流中存在缺少 id 或 type 的节点。');
  describe(graph);
  return graph;
}
function safeName(name) {
  let value = String(name || '工作流').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80).replace(/[. ]+$/g, '') || '工作流';
  // Windows device names are reserved even with extensions, and trailing dots
  // or spaces are stripped by Win32. Keep exported paths valid on the target OS.
  if (/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(value)) value = ('_' + value).slice(0, 80).replace(/[. ]+$/g, '');
  return value;
}
function emptyWorkspace() { return {version:1, activeId:null, tabs:[]}; }
function validateWorkspace(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.tabs) || data.tabs.length > MAX_TABS) throw new Error('工作区版本或标签数据不正确。');
  const ids = new Set();
  const tabs = Array.from(data.tabs, tab => {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab) || typeof tab.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(tab.id) || ids.has(tab.id)) throw new Error('工作区标签标识不正确。');
    ids.add(tab.id); validateGraph(tab.graph);
    return {...tab, title:safeName(tab.title), mode:['graph','parameters','app'].includes(tab.mode) ? tab.mode : 'graph'};
  });
  return {...data, tabs, activeId:ids.has(data.activeId) ? data.activeId : tabs[0]?.id || null};
}
function readWorkspace(file) {
  if (!fs.existsSync(file)) return emptyWorkspace();
  if (fs.statSync(file).size > MAX_WORKSPACE_BYTES) throw new Error('工作区记录超过大小限制，请保留文件并检查。');
  return validateWorkspace(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function writeWorkspace(file, data) {
  // Validate before touching disk: a successful save must remain readable after
  // restart, and malformed data must never replace the previous valid draft.
  const body = JSON.stringify(validateWorkspace(data), null, 2);
  if (Buffer.byteLength(body) > MAX_WORKSPACE_BYTES) throw new Error('工作区记录过大，未覆盖已有草稿。');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = file + '.tmp';
  fs.writeFileSync(temp, body, 'utf8');
  fs.renameSync(temp, file);
}
function addTab(workspace, title, graph, templateId = null) {
  if (workspace.tabs.length >= MAX_TABS) throw new Error('P0 最多同时打开 20 个工作副本。');
  const tab = {id:randomUUID(), title:safeName(title), graph:structuredClone(validateGraph(graph)), templateId, mode:'graph'};
  workspace.tabs.push(tab);
  return tab;
}
function validateBounds(bounds, size) {
  if (!bounds || ['x','y','width','height'].some(key => !Number.isFinite(bounds[key]))) throw new Error('画布尺寸无效。');
  const x = Math.max(0, Math.min(Math.round(bounds.x), size[0]));
  const y = Math.max(0, Math.min(Math.round(bounds.y), size[1]));
  return {x,y,width:Math.max(0,Math.min(Math.round(bounds.width),size[0]-x)),height:Math.max(0,Math.min(Math.round(bounds.height),size[1]-y))};
}
module.exports = {MAX_GRAPH_BYTES, MAX_TABS, validateGraph, safeName, emptyWorkspace, readWorkspace, writeWorkspace, addTab, validateBounds};
