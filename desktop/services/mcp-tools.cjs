'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {applyValues} = require('../../shared/bindings.cjs');
const {isSecretInput, defOf, isPlaceholder} = require('../../shared/secret-fields.cjs');
const {resolveInside} = require('../core/paths.cjs');
const {CODES} = require('../core/errors.cjs');

const id = {type: 'string', minLength: 1, maxLength: 128};
const revision = {type: 'integer', minimum: 0};
const paging = {offset: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 100}};
const promptText = {type: 'string', maxLength: 32768};
const positiveInt = {type: 'integer', minimum: 1};
const overrides = {prompt: promptText, negative: promptText, seed: {type: 'integer'}, steps: positiveInt,
  cfg: {type: 'number'}, width: positiveInt, height: positiveInt, denoise: {type: 'number', minimum: 0, maximum: 1}};

function tool(name, description, properties, required = [], readOnlyHint = true) {
  return {name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false},
    annotations: {readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false}};
}
const tools = [
  tool('list_templates', 'Search saved workflow templates. Use open_template with a returned templateId.', {search: {type: 'string', maxLength: 200}, ...paging}),
  tool('open_template', 'Open the current saved version in the desktop editor. Its new or existing tab becomes active. Use its tabId with get_workflow.', {templateId: id}, ['templateId'], false),
  tool('list_workflows', 'List open workflow tabs and the connected state of the ComfyUI editor.', {}),
  tool('get_workflow', 'Read the revision, supported per-run parameter names, reference counts and preflight error count for an open tab.', {tabId: id}, ['tabId']),
  tool('run_workflow', 'Queue one generation from an open tab. Use the revision and parameter names from get_workflow. Overrides affect this submission only. Each successful call queues a new job; do not automatically retry an interrupted call.', {tabId: id, expectedRevision: revision, ...overrides}, ['tabId', 'expectedRevision'], false),
  tool('get_task', 'Poll task state and list indexed output images. After success, image indexing can finish later. Use assetId with get_result_preview.', {taskId: id, ...paging}, ['taskId']),
  tool('get_result_preview', 'Read a WebP preview (up to 512 pixels) of a generated image listed by get_task.', {taskId: id, assetId: id}, ['taskId', 'assetId']),
];

class ToolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError(CODES.INVALID_ARGUMENT, '参数须为 JSON 对象。');
  for (const name of schema.required) if (!Object.hasOwn(args, name)) throw new ToolError(CODES.INVALID_ARGUMENT, `缺少参数 ${name}。`);
  for (const [name, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, name)) throw new ToolError(CODES.INVALID_ARGUMENT, '包含工具未声明的参数。');
    const rule = schema.properties[name];
    const valid = rule.type === 'string' ? typeof value === 'string' && value.length >= (rule.minLength ?? 0) && value.length <= rule.maxLength :
      Number.isFinite(value) && (rule.type !== 'integer' || Number.isSafeInteger(value)) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity);
    if (!valid) throw new ToolError(CODES.INVALID_ARGUMENT, `参数 ${name} 的类型或取值超出工具定义。`);
  }
}
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const tabSummary = t => ({tabId: t.id, title: t.title, revision: t.revision ?? 0, templateId: t.templateId ?? null});

// Return names and binding targets only inside this process. A bound widget may contain a prompt or a credential.
function editable(compiled) {
  const found = new Map();
  for (const [key, schema] of Object.entries(overrides)) {
    const b = key === 'seed' && compiled.bindings.seed?.readonly ? compiled.bindings.seedSource : compiled.bindings[key];
    if (!b || b.readonly || isPlaceholder(b.value)) continue;
    if (typeof b.value !== (schema.type === 'integer' ? 'number' : schema.type)) continue;
    if (isSecretInput(b.nodeType, b.input, defOf(compiled.objectInfo, b.nodeType, b.input))) continue;
    found.set(key, b);
  }
  return found;
}
const publicErrors = {
  INVALID_ARGUMENT: '工作流未通过参数或节点校验，请查看映作创作页。',
  INVALID_STATE: '当前工作流或服务状态不支持此操作，请在映作检查。',
  NOT_FOUND: '找不到工作流、任务、输出图片或引用素材。',
  REVISION_MISMATCH: '工作流已修改，请重新调用 get_workflow 获取 revision。',
  CONFLICT: '状态已变化，请重新读取工作流或任务。',
  CREDENTIAL_UNAVAILABLE: '工作流需要在映作中配置凭据。',
  SERVICE_UNAVAILABLE: '映作服务暂不可用。',
  FORBIDDEN: '此操作当前不可用。',
};

function createMcpTools({editor, taskService, templateService, assetsMethods, getOutputRoot}) {
  function task(id) {
    const t = taskService?.tasks.get(id);
    if (!t) throw new ToolError(CODES.NOT_FOUND, '找不到该任务。');
    return t;
  }
  async function compile(tabId, expectedRevision) {
    if (!taskService || !editor.connected) throw new ToolError(CODES.SERVICE_UNAVAILABLE, '请先在映作创作页连接 ComfyUI 编辑器。');
    return taskService.compile(tabId, {expectedRevision});
  }
  function checkPreview(asset, taskId) {
    if (!asset || asset.taskId !== taskId || asset.rootId !== 'output' || asset.kind !== 'image' || asset.missing) {
      throw new ToolError(CODES.NOT_FOUND, '该任务没有这张已登记的输出图片。');
    }
    const root = getOutputRoot?.();
    if (!root || !path.isAbsolute(root) || !path.isAbsolute(asset.path)) throw new ToolError(CODES.INVALID_STATE, '请在映作中配置输出目录。');
    const file = resolveInside(root, path.relative(root, asset.path), {realpath: true});
    const stat = fs.statSync(file, {throwIfNoEntry: false});
    if (!stat?.isFile()) throw new ToolError(CODES.NOT_FOUND, '输出图片已移动或删除。');
    if (stat.size !== asset.size || stat.mtimeMs !== asset.mtime) throw new ToolError(CODES.CONFLICT, '输出图片已改变，请在映作重新扫描。');
  }
  const handlers = {
    async list_templates({search = '', offset = 0, limit = 50}) {
      if (!templateService) throw new ToolError(CODES.SERVICE_UNAVAILABLE, '模板库暂不可用。');
      const {templates} = await templateService.methods['templates.list']({search});
      return text({templates: templates.slice(offset, offset + limit).map(t => ({templateId: t.id, name: t.name, currentVersion: t.currentVersion})),
        total: templates.length, nextOffset: offset + limit < templates.length ? offset + limit : null});
    },
    async open_template({templateId}, assertActive) {
      if (!templateService) throw new ToolError(CODES.SERVICE_UNAVAILABLE, '模板库暂不可用。');
      assertActive?.();
      const {state} = await templateService.methods['templates.open'](templateId);
      const tab = state.tabs.find(t => t.id === state.activeId && t.templateId === templateId);
      if (!tab) throw new ToolError(CODES.CONFLICT, '工作标签已变化，请调用 list_workflows。');
      return text(tabSummary(tab));
    },
    list_workflows() {
      const state = editor.state();
      return text({connected: state.connected, activeTabId: state.activeId, workflows: state.tabs.map(tabSummary)});
    },
    async get_workflow({tabId}) {
      const c = await compile(tabId);
      const refs = await taskService.methods['tasks.refs'](tabId);
      return text({tabId, title: c.title, revision: c.revision, parameters: [...editable(c).keys()],
        referenceInputs: c.bindings.references?.length ?? 0, selectedReferences: refs.length, missingReferences: refs.filter(r => r.missing).length,
        preflightErrors: c.issues.filter(i => i.level === 'error').length, nodeDefinitionsAvailable: c.objectInfoAvailable});
    },
    async run_workflow({tabId, expectedRevision, ...values}, assertActive) {
      const c = await compile(tabId, expectedRevision);
      const fields = editable(c), assigned = new Map();
      for (const [name, value] of Object.entries(values)) {
        if (isPlaceholder(value)) throw new ToolError(CODES.INVALID_ARGUMENT, '运行参数必须是普通文本或数值。');
        const b = fields.get(name);
        if (!b) throw new ToolError(CODES.INVALID_ARGUMENT, `此工作流不支持覆盖 ${name}，请查看 get_workflow 的 parameters。`);
        const target = JSON.stringify([b.nodeId, b.input]);
        if (assigned.has(target) && assigned.get(target) !== value) throw new ToolError(CODES.CONFLICT, '两个参数指向同一工作流输入，请只指定一个值。');
        assigned.set(target, value);
      }
      const live = editor.workspace.tabs.find(tab => tab.id === tabId);
      if (!live || c.revision !== expectedRevision || live.revision !== expectedRevision) throw new ToolError(CODES.REVISION_MISMATCH, publicErrors.REVISION_MISMATCH);
      if (!editor.connected) throw new ToolError(CODES.SERVICE_UNAVAILABLE, 'ComfyUI 编辑器连接已断开，请重新连接后再提交。');
      assertActive?.();
      const t = taskService.submissions.enqueueCompiled(c, applyValues(c.apiPrompt, c.bindings, values), {params: values});
      return text({taskId: t.id, state: t.state, revision: c.revision});
    },
    async get_task({taskId, offset = 0, limit = 50}) {
      const t = task(taskId);
      const r = await assetsMethods['assets.list']({taskId, kind: 'image', rootId: 'output', offset, limit});
      return text({taskId, state: t.state, progress: Number.isFinite(t.progress?.value) && Number.isFinite(t.progress?.max)
        ? {value: t.progress.value, max: t.progress.max} : null, expectedImages: (t.outputs ?? []).filter(o => o.kind === 'image' && (o.type ?? 'output') === 'output').length,
        outputs: r.items.map(a => ({assetId: a.id, name: a.name, format: a.format, width: a.width, height: a.height})), total: r.total, nextOffset: r.nextOffset});
    },
    async get_result_preview({taskId, assetId}) {
      task(taskId);
      // Only gallery image IDs are valid here. Favorites and paths use different access routes in the desktop app.
      if (!/^[0-9a-f]{20}$/.test(assetId)) throw new ToolError(CODES.NOT_FOUND, '请使用 get_task 返回的 assetId。');
      const asset = await assetsMethods['assets.get'](assetId);
      checkPreview(asset, taskId);
      const {dataUrl} = await assetsMethods['assets.thumbnail'](assetId, {size: 512});
      const current = await assetsMethods['assets.get'](assetId);
      checkPreview(current, taskId);
      if (current.mtime !== asset.mtime || current.size !== asset.size) throw new ToolError(CODES.CONFLICT, '图片已变化，请重新读取任务。');
      const prefix = 'data:image/webp;base64,';
      if (!dataUrl?.startsWith(prefix) || dataUrl.length <= prefix.length || dataUrl.length > prefix.length + 2 * 1024 * 1024) throw new ToolError(CODES.UNSUPPORTED, '无法返回此图片的缩略图。');
      return {content: [{type: 'image', mimeType: 'image/webp', data: dataUrl.slice(prefix.length)}]};
    },
  };
  async function call(name, args = {}, {assertActive} = {}) {
    try {
      const spec = tools.find(t => t.name === name);
      if (!spec) throw new ToolError(CODES.NOT_FOUND, '未知的映作工具。');
      validate(spec.inputSchema, args);
      assertActive?.();
      const result = await handlers[name](args, assertActive);
      assertActive?.();
      return result;
    } catch (e) {
      // Adapter-generated messages contain only fixed text or validated field names. Backend errors can include prompts/paths.
      const code = e instanceof ToolError || Object.hasOwn(publicErrors, e?.code) ? e.code : CODES.INTERNAL;
      const message = e instanceof ToolError ? e.message : publicErrors[code] ?? '操作失败，请在映作中查看详情。';
      return {...text({code, message}), isError: true};
    }
  }
  return {tools, call};
}
module.exports = {createMcpTools};
