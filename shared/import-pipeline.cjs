'use strict';
// E05：导入管线。大小／结构检查 → 区分 UI / API 格式 → 统一错误。只解析数据，不执行脚本、
// 不安装插件、不下载模型。UI 图原样保留（包括 definitions.subgraphs）。
const {describe} = require('../workflow-import.js');
const MAX_BYTES = 8 * 1024 * 1024;
class ImportError extends Error { constructor(code, message) { super(message); this.code = code; } }
function analyze(text, {name = '工作流'} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new ImportError('EMPTY', '文件为空，请选择工作流 JSON 或粘贴内容。');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new ImportError('TOO_LARGE', `工作流超过 ${MAX_BYTES / 1024 / 1024} MB。`);
  let document;
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (e) { throw new ImportError('INVALID_JSON', `JSON 格式不正确：${e.message}`); }
  // PNG/WebP 元数据导出的 {workflow, prompt} 包装：优先使用 UI 图
  if (document && typeof document === 'object' && document.workflow && Array.isArray(document.workflow.nodes)) document = document.workflow;
  let info;
  try { info = describe(document); }
  catch (e) { throw new ImportError('INVALID_STRUCTURE', e.message); }
  const isUi = Array.isArray(document.nodes);
  const subgraphs = isUi && Array.isArray(document.definitions?.subgraphs) ? document.definitions.subgraphs.length : 0;
  const api = isUi ? null : (document.prompt && typeof document.prompt === 'object' ? document.prompt : document);
  return {
    name: String(name).replace(/\.json$/i, '').slice(0, 80) || '工作流',
    format: isUi ? 'ui' : 'api',
    graph: isUi ? document : null,
    apiPrompt: api,
    nodeCount: info.nodes.length,
    nodeTypes: [...new Set(info.nodes.map(n => n.type))],
    subgraphs,
    linkCount: info.links.length,
    skippedLinks: info.skippedLinks,
    notes: isUi ? (subgraphs ? [`保留 ${subgraphs} 个子图定义。`] : []) : ['API 格式没有节点位置和界面信息；将用当前 ComfyUI 前端的官方 loadApiJson 重建可视图，原文件另存保留。未知节点会以缺失节点显示，不会伪造连线。'],
  };
}
/** API 转换结果核对：列出 API 中存在但重建图中缺失的节点类型。 */
function compareConversion(apiPrompt, snapshotNodes) {
  const wanted = Object.entries(apiPrompt).map(([id, n]) => ({id, type: n.class_type}));
  const present = new Set((snapshotNodes || []).map(n => String(n.type)));
  const missing = wanted.filter(w => !present.has(w.type));
  return {total: wanted.length, missingTypes: [...new Set(missing.map(m => m.type))], complete: missing.length === 0};
}
module.exports = {analyze, compareConversion, ImportError, MAX_BYTES};
