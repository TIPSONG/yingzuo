// Parse data only. Imported node types, scripts and URLs are never executed.
const WorkflowImport = (() => {
 const MAX_BYTES = 2 * 1024 * 1024;
 const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
 const validId = value => (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'number' && Number.isFinite(value));
 function describe(document) {
  if (!object(document)) throw new Error('需要一个 ComfyUI 工作流 JSON 对象。');
  let nodes, links, format;
  if (Array.isArray(document.nodes)) {
   format = 'ComfyUI 工作流';
   const subgraphs = new Map((Array.isArray(document.definitions?.subgraphs) ? document.definitions.subgraphs : []).filter(graph => object(graph) && typeof graph.name === 'string').map(graph => [graph.id,graph.name]));
   nodes = document.nodes.map(node => {
    if (!object(node) || !validId(node.id) || typeof node.type !== 'string' || !node.type.trim()) throw new Error('工作流中存在缺少 id 或 type 的节点。');
    return {id:String(node.id), type:node.type, title:typeof node.title === 'string' ? node.title : subgraphs.get(node.type) || node.type};
   });
   if (document.links !== undefined && !Array.isArray(document.links)) throw new Error('工作流的 links 必须是数组。');
   links = (document.links || []).map(link => Array.isArray(link) ? {from:String(link[1]), to:String(link[3])} : {from:String(link?.origin_id), to:String(link?.target_id)});
  } else {
   const prompt = object(document.prompt) ? document.prompt : document;
   const entries = Object.entries(prompt);
   if (!entries.length || entries.some(([,node]) => !object(node) || typeof node.class_type !== 'string' || !node.class_type.trim() || !object(node.inputs))) throw new Error('没有找到 ComfyUI 节点。请导入包含 nodes 的工作流，或 API 格式的工作流。');
   format = 'ComfyUI API 工作流';
   nodes = entries.map(([id,node]) => ({id, type:node.class_type, title:typeof node._meta?.title === 'string' ? node._meta.title : node.class_type}));
   const ids = new Set(nodes.map(node => node.id));
   links = entries.flatMap(([id,node]) => Object.values(node.inputs).filter(value => Array.isArray(value) && value.length === 2 && ids.has(String(value[0])) && Number.isInteger(value[1])).map(value => ({from:String(value[0]), to:id})));
  }
  if (nodes.length > 5000) throw new Error('A 测版最多导入 5000 个顶层节点，请使用较小的工作流。');
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) throw new Error('工作流有重复的节点 id，请检查 JSON。');
  const visibleLinks = links.filter(link => ids.has(link.from) && ids.has(link.to));
  return {document, format, nodes, links:visibleLinks, skippedLinks:links.length-visibleLinks.length};
 }
 function parse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请先粘贴 JSON，或选择一个工作流文件。');
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('A 测版支持 2 MB 以内的 JSON 文件。');
  let document;
  try {document = JSON.parse(text.replace(/^\uFEFF/, ''));}
  catch {throw new Error('JSON 格式不正确，请检查括号、逗号和引号后重试。');}
  return describe(document);
 }
 return {parse, describe, MAX_BYTES};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorkflowImport;
