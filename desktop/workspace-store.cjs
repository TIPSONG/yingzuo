'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {describe} = require('../workflow-import.js');

const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_TABS = 20;
function validateGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('桌面 P0 请导入含 nodes 的 ComfyUI 工作流；API 图的可视化转换将在后续适配。');
  if (Buffer.byteLength(JSON.stringify(graph)) > MAX_GRAPH_BYTES) throw new Error('工作副本超过 8 MB，暂不保存。');
  describe(graph);
  return graph;
}
function safeName(name) {
  return String(name || '工作流').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80) || '工作流';
}
function emptyWorkspace() { return {version:1, activeId:null, tabs:[]}; }
function readWorkspace(file) {
  if (!fs.existsSync(file)) return emptyWorkspace();
  if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('工作区记录超过大小限制，请保留文件并检查。');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.tabs) || data.tabs.length > MAX_TABS) throw new Error('工作区版本或标签数据不正确。');
  const ids = new Set();
  for (const tab of data.tabs) {
    if (typeof tab.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(tab.id) || ids.has(tab.id)) throw new Error('工作区标签标识不正确。');
    ids.add(tab.id); validateGraph(tab.graph);
    tab.title = safeName(tab.title); tab.mode = ['graph','parameters','app'].includes(tab.mode) ? tab.mode : 'graph';
  }
  data.activeId = ids.has(data.activeId) ? data.activeId : data.tabs[0]?.id || null;
  return data;
}
function writeWorkspace(file, data) {
  const body = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new Error('工作区记录过大，未覆盖已有草稿。');
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
