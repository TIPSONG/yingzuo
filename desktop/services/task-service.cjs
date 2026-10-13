'use strict';
// Q06/Q08/Q09/Q10/E07/E08/E09：把编辑器编译、绑定、参考图、任务仓库和调度器组装成 tasks.* 接口。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {AppError, CODES} = require('../core/errors.cjs');
const {TaskRepository, SnapshotStore} = require('../repositories/task-repo.cjs');
const {QueueService, expandBatch} = require('./queue-service.cjs');
const {ComfyHttpClient, ComfySocket} = require('../adapters/comfy-http.cjs');
const {checkPrompt} = require('../../shared/prompt-check.cjs');
const B = require('../../shared/bindings.cjs');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};

/** E08：参考图本地持久化（内容寻址）。 */
class ReferenceStore {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, {recursive: true}); }
  importFile(file) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXT.has(ext)) throw new AppError(CODES.INVALID_ARGUMENT, '参考图只支持 PNG/JPEG/WebP。');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 50 * 1024 * 1024) throw new AppError(CODES.INVALID_ARGUMENT, '参考图不存在或超过 50 MB。');
    const buf = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const rel = path.join(hash.slice(0, 2), hash + ext);
    const target = path.join(this.dir, rel);
    if (!fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target + '.tmp', buf); fs.renameSync(target + '.tmp', target); }
    return {id: `${hash}${ext}`, hash, ext, name: path.basename(file), size: st.size};
  }
  pathOf(id) {
    if (!/^[0-9a-f]{64}\.(png|jpe?g|webp)$/.test(id)) throw new AppError(CODES.INVALID_ARGUMENT, '参考图编号无效。');
    const p = path.join(this.dir, id.slice(0, 2), id);
    if (!fs.existsSync(p)) throw new AppError(CODES.NOT_FOUND, '参考图文件丢失，请重新选择。');
    return p;
  }
}
/** E08：提交前上传参考图，写回后端返回的文件名（以服务器返回值为准，不自己拼）。重启后重跑任务会自动补传。 */
async function uploadReferences(prompt, references, client, refStore) {
  const next = structuredClone(prompt);
  for (const ref of references ?? []) {
    if (!next[ref.nodeId]) throw new AppError(CODES.INVALID_ARGUMENT, `参考图目标节点 ${ref.nodeId} 不存在。`);
    const file = refStore.pathOf(ref.refId);
    const hash = ref.refId.slice(0, 16);
    const r = await client.uploadImage({buffer: fs.readFileSync(file), filename: `yingzuo_${hash}${path.extname(file)}`, subfolder: 'yingzuo', overwrite: true, mime: MIME[path.extname(file)]});
    next[ref.nodeId].inputs[ref.input ?? 'image'] = r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }
  return next;
}

function createTaskService({db, layout, configRepo, events, locks, logger, editor, fetchImpl, WebSocketImpl, clientId = crypto.randomUUID(), dialog, getWindow}) {
  const tasks = new TaskRepository(db, new SnapshotStore(layout['task-snapshots']), {events});
  const refs = new ReferenceStore(layout.references);
  let clientCache = null;
  const client = () => {
    const url = configRepo.config.comfy.url;
    if (!clientCache || clientCache.base.href !== new URL(url).href) clientCache = new ComfyHttpClient(url, {fetchImpl});
    return clientCache;
  };
  let objectInfo = null, objectInfoAt = 0;
  async function getObjectInfo() {
    if (objectInfo && Date.now() - objectInfoAt < 60000) return objectInfo;
    try { objectInfo = await client().objectInfo(); objectInfoAt = Date.now(); } catch (e) { logger?.warn('object_info 获取失败', {error: e.message}); }
    return objectInfo;
  }
  const queue = new QueueService({
    tasks, client, gpuLock: locks.gpu, events, logger, clientId,
    prepare: async (_task, snapshot, c) => uploadReferences(snapshot.apiPrompt, snapshot.references, c, refs),
  });
  let socket = null;
  function connectSocket() {
    socket?.close();
    try { socket = new ComfySocket(configRepo.config.comfy.url, clientId, {WebSocketImpl, onEvent: m => { try { queue.handleSocketEvent(m); } catch (e) { logger?.warn('socket event', {error: e.message}); } }, onState: s => events.emit('queue.socket', null, s)}); socket.open(); }
    catch (e) { logger?.warn('无法建立 ComfyUI WebSocket', {error: e.message}); }
  }

  async function compile(tabId) {
    const r = await editor.enqueue(() => editor.commands.compileTab(tabId));
    const info = await getObjectInfo();
    const issues = checkPrompt(r.apiPrompt, {objectInfo: info});
    return {...r, issues, objectInfoAvailable: !!info, bindings: B.inferBindings(r.apiPrompt)};
  }
  const blocking = issues => issues.filter(i => i.level === 'error');
  function assertRunnable(issues) { const e = blocking(issues); if (e.length) throw new AppError(CODES.INVALID_ARGUMENT, `提交前检查未通过：${e[0].message}`, {details: {issues: e}}); }
  function snapshotFor(c, apiPrompt, extra = {}) { return {uiGraph: c.uiGraph, apiPrompt, tabId: c.tabId, title: c.title, references: extra.references ?? [], params: extra.params ?? {}, ...extra.meta}; }

  const methods = {
    'tasks.preview': async tabId => { const c = await compile(tabId); return {tabId: c.tabId, title: c.title, revision: c.revision, issues: c.issues, objectInfoAvailable: c.objectInfoAvailable, bindings: c.bindings, nodeCount: Object.keys(c.apiPrompt).length}; },
    /** Q06：运行当前（或指定）标签。values 为绑定参数覆盖，references 为 [{nodeId,input,refId}]。 */
    'tasks.run': async (tabId, options = {}) => {
      const c = await compile(tabId);
      assertRunnable(c.issues);
      let prompt = B.applyValues(c.apiPrompt, c.bindings, options.values);
      const enh = c.bindings.enhancer;
      if (enh) { const notes = B.checkEnhancerRun(prompt, enh, {contextLength: configRepo.config.gemma?.contextLength, maxReferenceImages: configRepo.config.gemma?.maxReferenceImages}); assertRunnable(notes); }
      if (enh && options.adoptedText) prompt = B.adoptEnhanced(prompt, enh, options.adoptedText);
      return queue.enqueue({workflowId: c.tabId, inputRevision: c.revision, snapshot: snapshotFor(c, prompt, {references: options.references, params: options.values})});
    },
    /** Q10：批量。按提示词 × seed × 参数展开，同一分组 FIFO。 */
    'tasks.previewBatch': async (tabId, spec) => { const c = await compile(tabId); return {count: expandBatch(spec).length, max: 100, bindings: c.bindings, issues: c.issues}; },
    'tasks.runBatch': async (tabId, spec = {}) => {
      const c = await compile(tabId); assertRunnable(c.issues);
      const items = expandBatch(spec);
      if ((spec.prompts?.length > 0) && !c.bindings.prompt) throw new AppError(CODES.INVALID_ARGUMENT, '无法确定此工作流的提示词输入，不能批量替换提示词。');
      if (items.some(i => i.seed !== null) && !(c.bindings.seed && (!c.bindings.seed.readonly || c.bindings.seedSource))) throw new AppError(CODES.INVALID_ARGUMENT, '无法确定此工作流的 seed 输入。');
      const groupId = crypto.randomUUID();
      const created = [];
      for (const item of items) {
        const values = {...item.params, ...(item.prompt !== null ? {prompt: item.prompt} : {}), ...(item.seed !== null ? {seed: item.seed} : {})};
        const prompt = B.applyValues(c.apiPrompt, c.bindings, values);
        created.push(queue.enqueue({workflowId: c.tabId, inputRevision: c.revision, groupId, snapshot: snapshotFor(c, prompt, {references: spec.references, params: values})}));
      }
      return {groupId, tasks: created};
    },
    /** Q08：仅润色。只提交润色节点及其上游，完成后在任务输出中读取文本，不执行绘图。 */
    'tasks.enhance': async (tabId, {text} = {}) => {
      const c = await compile(tabId);
      const enh = c.bindings.enhancer;
      if (!enh) throw new AppError(CODES.NOT_FOUND, '此工作流没有 Gemma 润色节点。');
      let prompt = c.apiPrompt;
      if (typeof text === 'string' && text.trim()) { if (!enh.textInput) throw new AppError(CODES.INVALID_ARGUMENT, '润色节点没有可写入的文本输入。'); prompt = structuredClone(prompt); prompt[enh.nodeId].inputs[enh.textInput] = text; }
      const info = await getObjectInfo();
      if (!info) throw new AppError(CODES.SERVICE_UNAVAILABLE ?? CODES.INTERNAL, '无法读取 ComfyUI 节点信息，不能构造仅润色任务。');
      let sub;
      try { sub = B.extractEnhanceOnly(prompt, enh.nodeId, {objectInfo: info}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
      assertRunnable([...checkPrompt(sub.prompt, {objectInfo: info}), ...B.checkEnhancerRun(sub.prompt, enh, {contextLength: configRepo.config.gemma?.contextLength, maxReferenceImages: configRepo.config.gemma?.maxReferenceImages})]);
      return queue.enqueue({kind: 'enhance', workflowId: c.tabId, inputRevision: c.revision, snapshot: snapshotFor(c, sub.prompt, {meta: {enhance: {outputNode: sub.outputNode, enhancer: enh}}})});
    },
    'tasks.enhanceResult': async id => {
      const t = tasks.get(id); if (!t || t.kind !== 'enhance') throw new AppError(CODES.NOT_FOUND, '不是润色任务。');
      if (t.state !== 'succeeded') return {state: t.state, text: null, error: t.error};
      const s = tasks.snapshotOf(t);
      const text = (t.outputs ?? []).filter(o => o.kind === 'text' && o.nodeId === s.enhance.outputNode).map(o => o.text).join('\n').trim();
      return {state: t.state, text: text || null, original: s.apiPrompt[s.enhance.enhancer.nodeId]?.inputs?.[s.enhance.enhancer.textInput] ?? null, error: text ? null : {message: '任务成功但没有读取到润色文本。'}};
    },
    'tasks.list': async (filter = {}) => ({tasks: tasks.list({states: filter.states, limit: Math.min(500, filter.limit ?? 100), groupId: filter.groupId}), queue: queue.state()}),
    'tasks.get': async id => { const t = tasks.get(id); if (!t) throw new AppError(CODES.NOT_FOUND, '任务不存在。'); return {...t, events: tasks.events_(id), lineage: tasks.lineage(id)}; },
    'tasks.cancel': id => queue.cancel(id),
    'tasks.retry': async id => queue.retry(id),
    'tasks.recheck': id => queue.recheck(id),
    'tasks.pause': async () => { queue.pause(); return queue.state(); },
    'tasks.resume': async () => { queue.resume(); return queue.state(); },
    'tasks.pickReference': async () => {
      const r = await dialog.showOpenDialog(getWindow(), {title: '选择参考图', properties: ['openFile'], filters: [{name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp']}]});
      if (r.canceled || !r.filePaths?.length) return {cancelled: true};
      return refs.importFile(r.filePaths[0]);
    },
  };
  const hooks = {
    activeTasks: () => queue.activeTasks(),
    waitForIdle: () => queue.waitForIdle(),
    cancelActive: async () => { for (const t of queue.activeTasks()) { try { await queue.cancel(t.id); } catch (e) { logger?.warn('退出时取消失败', {id: t.id, error: e.message}); } } await Promise.race([queue.waitForIdle(), new Promise(r => setTimeout(r, 15000))]); },
    pauseSubmissions: () => queue.pause(),
    resumeSubmissions: () => queue.resume(),
  };
  async function start() { connectSocket(); try { await queue.recoverOnStartup(); } catch (e) { logger?.error('任务恢复失败', {error: e.message}); } }
  function stop() { queue.stop(); socket?.close(); }
  return {tasks, queue, refs, methods, hooks, start, stop, compile, connectSocket};
}
module.exports = {createTaskService, ReferenceStore, uploadReferences};
