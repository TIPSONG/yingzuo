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
const F = require('../../shared/form-schema.cjs');
const B = require('../../shared/bindings.cjs');
const SF = require('../../shared/secret-fields.cjs');
const {stableWorkflowId, planSavePrefix} = require('../../shared/output-plan.cjs');
const {planBatch} = require('../../shared/batch-plan.cjs');
const {prefixDir} = require('./output-prefix.cjs');

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
  has(id) { try { this.pathOf(id); return true; } catch { return false; } }
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

function createTaskService({credentials = null, db, layout, configRepo, events, locks, logger, editor, fetchImpl, WebSocketImpl, clientId = crypto.randomUUID(), dialog, getWindow, onTerminal = null}) {
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
    prepare: async (task, snapshot, c) => {
      // R12：意图快照（不可变）与实际提交记录分开。上传在解析凭据之前完成，记录里只含占位符
      const uploaded = await uploadReferences(snapshot.apiPrompt, snapshot.references, c, refs);
      recordSubmission(task, snapshot, uploaded);
      return resolveSecrets(uploaded);
    },
    // A01/A02：终态时把任务输出关联进作品库（失败只记日志，不影响任务状态）
    onTerminal: task => { if (!onTerminal || task.state !== 'succeeded') return; Promise.resolve().then(() => onTerminal(task)).catch(e => logger?.warn('作品关联失败', {id: task.id, error: e.message})); },
  });
  /** A03：按设置（或单次覆盖）调整已登记保存节点的输出前缀；返回调整后的 prompt 与改动说明。 */
  const workflowIdOf = c => stableWorkflowId({templateId: c.templateId, uiGraph: c.uiGraph}) ?? c.tabId;
  function withPrefix(prompt, c, mode) {
    const m = mode ?? configRepo.config.output?.prefixMode ?? 'none';
    if (m === 'none') return {prompt, prefix: null};
    // R20：目录用稳定工作流身份；SaveImageAdvanced 等按 object_info 确认前缀字段
    const dir = prefixDir({mode: m, workflowId: workflowIdOf(c), workflowName: c.title});
    const r = planSavePrefix(prompt, {dir, objectInfo});
    return {prompt: r.prompt, prefix: {dir, changed: r.changed, untouched: r.untouched}};
  }
  let socket = null;
  function connectSocket() {
    socket?.close();
    try { socket = new ComfySocket(configRepo.config.comfy.url, clientId, {WebSocketImpl, onEvent: m => { try { queue.handleSocketEvent(m); } catch (e) { logger?.warn('socket event', {error: e.message}); } }, onState: s => events.emit('queue.socket', null, s)}); socket.open(); }
    catch (e) { logger?.warn('无法建立 ComfyUI WebSocket', {error: e.message}); }
  }

  /** PR11-R09：必须显式给出发起标签；expectedRevision 不一致时拒绝，绝不回退到当前活动标签。 */
  async function compile(tabId, {expectedRevision = null} = {}) {
    if (typeof tabId !== 'string' || !tabId) throw new AppError(CODES.INVALID_ARGUMENT, '缺少发起任务的标签。');
    if (editor.workspace && !editor.workspace.tabs.some(t => t.id === tabId)) throw new AppError(CODES.NOT_FOUND, '发起任务的标签已关闭。', {details: {tabId}});
    const r = await editor.enqueue(() => editor.commands.compileTab(tabId));
    if (r.tabId !== tabId) throw new AppError(CODES.CONFLICT, '编译结果不属于发起标签。');
    if (expectedRevision !== null && expectedRevision !== undefined && r.revision !== expectedRevision) throw new AppError(CODES.REVISION_MISMATCH, `标签「${r.title}」在等待期间已被修改（版本 ${expectedRevision} → ${r.revision}）。`, {details: {tabId, expectedRevision, revision: r.revision}});
    const info = await getObjectInfo();
    const issues = checkPrompt(r.apiPrompt, {objectInfo: info});
    return {...r, issues, objectInfoAvailable: !!info, bindings: B.inferBindings(r.apiPrompt)};
  }
  const blocking = issues => issues.filter(i => i.level === 'error');
  function assertRunnable(issues) { const e = blocking(issues); if (e.length) throw new AppError(CODES.INVALID_ARGUMENT, `提交前检查未通过：${e[0].message}`, {details: {issues: e}}); }
  function snapshotFor(c, apiPrompt, extra = {}) { return {uiGraph: c.uiGraph, apiPrompt, tabId: c.tabId, title: c.title, references: extra.references ?? [], params: extra.params ?? {}, ...extra.meta}; }

  /* ---------- R12：实际提交记录（每次尝试追加；上传后的文件名、最终 prompt 指纹、采用文本与输出前缀） ---------- */
  const subDir = path.join(layout.root, 'task-submissions');
  const subFile = id => path.join(subDir, `${String(id).replace(/[^\w-]/g, '')}.json`);
  function recordSubmission(task, snapshot, prompt) {
    fs.mkdirSync(subDir, {recursive: true});
    const prev = readSubmission(task.id) ?? {taskId: task.id, attempts: []};
    const uploads = (snapshot.references ?? []).map(r => ({nodeId: r.nodeId, input: r.input ?? 'image', refId: r.refId, uploaded: prompt[r.nodeId]?.inputs?.[r.input ?? 'image'] ?? null}));
    prev.attempts.push({at: new Date().toISOString(), requestId: task.requestId, promptSha256: crypto.createHash('sha256').update(JSON.stringify(prompt)).digest('hex'), uploads, outputPrefix: snapshot.outputPrefix?.dir ?? null, adopted: snapshot.adopted ?? null, params: snapshot.params ?? {}});
    const tmp = `${subFile(task.id)}.tmp`; fs.writeFileSync(tmp, JSON.stringify(prev, null, 2)); fs.renameSync(tmp, subFile(task.id));
  }
  function readSubmission(id) { try { return JSON.parse(fs.readFileSync(subFile(id), 'utf8')); } catch { return null; } }

  /* ---------- R11：参考图关系持久化到应用数据（按标签，记录版本），不再依赖浏览器 localStorage ---------- */
  const relFile = path.join(layout.root, 'reference-relations.json');
  const readRel = () => { try { return JSON.parse(fs.readFileSync(relFile, 'utf8')); } catch { return {version: 1, tabs: {}}; } };
  const writeRel = d => { const tmp = `${relFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, relFile); };
  const REF_ID = /^[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/i;
  function setRelations(tabId, items, revision = null) {
    if (typeof tabId !== 'string' || !tabId) throw new AppError(CODES.INVALID_ARGUMENT, '缺少标签。');
    if (!Array.isArray(items) || items.length > 64) throw new AppError(CODES.INVALID_ARGUMENT, '参考图关系无效。');
    const clean = items.map(r => { if (!r || typeof r.nodeId !== 'string' || typeof r.refId !== 'string' || !REF_ID.test(r.refId)) throw new AppError(CODES.INVALID_ARGUMENT, '参考图编号无效。'); return {nodeId: r.nodeId, input: typeof r.input === 'string' ? r.input : 'image', refId: r.refId, name: String(r.name ?? '').slice(0, 200)}; });
    const d = readRel(); d.tabs[tabId] = {revision, items: clean, updatedAt: new Date().toISOString()}; writeRel(d); return clean;
  }
  /** 关系 + 每项素材是否仍在本机（不能仅凭目录存在就认为引用有效）。 */
  function relationsOf(tabId) { return (readRel().tabs[tabId]?.items ?? []).map(r => ({...r, missing: !refs.has(r.refId)})); }
  function refsForRun(tabId, given) {
    if (given) return given;
    const list = relationsOf(tabId), lost = list.filter(r => r.missing);
    if (lost.length) throw new AppError(CODES.NOT_FOUND, `参考图文件已丢失：${lost.map(r => r.name || r.refId).join('、')}。请在“参考图”中重新选择或移除。`, {details: {missing: lost}});
    return list.map(({nodeId, input, refId}) => ({nodeId, input, refId}));
  }

  /* ---------- R18/D15：快照不存敏感输入明文；提交前在内存中还原 ---------- */
  function redactSnapshot(snapshot) {
    const r = SF.redactForStorage({prompt: snapshot.apiPrompt, objectInfo});
    if (!r.refs.length) return snapshot;
    if (!credentials?.available?.()) throw new AppError(CODES.CREDENTIAL_UNAVAILABLE, '工作流含敏感输入（如 API Key），但系统加密存储不可用；为避免明文写入任务快照，未创建任务。');
    const values = new Map(); let prompt = JSON.stringify(r.prompt);
    for (const {credentialRef} of r.refs) {
      const secret = r.secrets.get(credentialRef);
      const name = `node-secret:${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
      credentials.set(name, secret); values.set(secret, name);
      prompt = prompt.split(JSON.stringify(SF.PLACEHOLDER_PREFIX + credentialRef)).join(JSON.stringify(SF.PLACEHOLDER_PREFIX + name));
    }
    const {apiPrompt: _p, ...rest} = snapshot;
    return {...SF.redactValues(rest, values), apiPrompt: JSON.parse(prompt), secretRefs: [...values.values()]};
  }
  const resolveSecrets = prompt => SF.resolveSecrets(prompt, async name => credentials?.get(name) ?? null).catch(e => { throw new AppError(CODES.CREDENTIAL_UNAVAILABLE, e.message, {details: {missing: e.missing}}); });
  const enqueue = spec => queue.enqueue({...spec, snapshot: redactSnapshot(spec.snapshot)});

  /* ---------- D04/PR11-R10：模板自定义表单进入正式运行 ---------- */
  let formProvider = null;
  const formOf = c => (c.templateId && formProvider ? formProvider(c.templateId) : null);
  function applyCustomForm(c, prompt, formValues) {
    if (formValues === undefined || formValues === null) return {prompt, form: null};
    const form = formOf(c);
    if (!form?.fields?.length) throw new AppError(CODES.INVALID_STATE, '该标签没有已保存的自定义表单。');
    try { return {prompt: F.applyForm(form.fields, prompt, formValues), form: {templateId: c.templateId, versionId: form.versionId ?? null, fields: form.fields, values: formValues}}; }
    catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
  }

  const methods = {
    /** 正式创作表单：已保存的自定义表单（含映射状态）；没有时返回 null，界面回退到推断表单。 */
    'tasks.form': async tabId => {
      const c = await compile(tabId); const form = formOf(c);
      if (!form?.fields?.length) return {tabId: c.tabId, revision: c.revision, templateId: c.templateId ?? null, fields: null};
      const map = F.validateMapping(form.fields, c.apiPrompt);
      return {tabId: c.tabId, revision: c.revision, templateId: c.templateId, versionId: form.versionId ?? null, fields: map.map((m, i) => ({index: i, ...m.binding, status: m.status, reason: m.reason, value: m.status === 'ok' ? c.apiPrompt[m.binding.nodeId].inputs[m.binding.fieldName] : null})).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))};
    },
    'tasks.preview': async tabId => { const c = await compile(tabId); return {tabId: c.tabId, title: c.title, revision: c.revision, issues: c.issues, objectInfoAvailable: c.objectInfoAvailable, bindings: c.bindings, nodeCount: Object.keys(c.apiPrompt).length}; },
    /** Q06：运行当前（或指定）标签。values 为绑定参数覆盖，references 为 [{nodeId,input,refId}]。 */
    'tasks.run': async (tabId, options = {}) => {
      const c = await compile(tabId, {expectedRevision: options.expectedRevision});
      assertRunnable(c.issues);
      const custom = applyCustomForm(c, c.apiPrompt, options.formValues);
      let prompt = B.applyValues(custom.prompt, c.bindings, options.values);
      const enh = c.bindings.enhancer;
      if (enh) { const notes = B.checkEnhancerRun(prompt, enh, {contextLength: configRepo.config.gemma?.contextLength, maxReferenceImages: configRepo.config.gemma?.maxReferenceImages}); assertRunnable(notes); }
      if (enh && options.adoptedText) { try { prompt = B.adoptEnhanced(prompt, enh, options.adoptedText, {objectInfo: await getObjectInfo()}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); } }
      const p = withPrefix(prompt, c, options.prefixMode);
      return enqueue({workflowId: workflowIdOf(c), inputRevision: c.revision, snapshot: snapshotFor(c, p.prompt, {references: refsForRun(c.tabId, options.references), params: options.values, meta: {...(p.prefix ? {outputPrefix: p.prefix} : {}), ...(options.adoptedText ? {adopted: String(options.adoptedText)} : {}), ...(custom.form ? {templateId: custom.form.templateId, form: custom.form} : {})}})});
    },
    /** Q10：批量。按提示词 × seed × 参数展开，同一分组 FIFO。 */
    'tasks.previewBatch': async (tabId, spec) => { const c = await compile(tabId); return {count: expandBatch(spec).length, max: 100, bindings: c.bindings, issues: c.issues}; },
    'tasks.runBatch': async (tabId, spec = {}) => {
      const c = await compile(tabId, {expectedRevision: spec.expectedRevision}); assertRunnable(c.issues);
      // R19：先全量规划与校验，任何一项无效整体拒绝；之后整组一次登记
      const types = {}; for (const [k, b] of Object.entries(c.bindings)) if (b && !b.readonly && 'value' in b) types[k] = {type: typeof b.value === 'number' ? (Number.isInteger(b.value) ? 'int' : 'float') : typeof b.value === 'boolean' ? 'bool' : 'string', label: k};
      const plan = planBatch({prompts: spec.prompts?.length ? spec.prompts : null, seeds: spec.seeds, count: spec.count, seedStart: spec.seedStart, variations: spec.variations}, types);
      if (!plan.ok) throw new AppError(CODES.INVALID_ARGUMENT, `批量计划无效：${plan.errors[0].message}`, {details: {errors: plan.errors}});
      const params = Array.isArray(spec.params) && spec.params.length ? spec.params : [{}];
      if (plan.total * params.length > 100) throw new AppError(CODES.INVALID_ARGUMENT, `批量共 ${plan.total * params.length} 个任务，超过上限 100。`);
      const items = plan.items.flatMap(it => params.map(p => ({prompt: it.prompt, seed: it.seed, params: {...p, ...it.values}})));
      if ((spec.prompts?.length > 0) && !c.bindings.prompt) throw new AppError(CODES.INVALID_ARGUMENT, '无法确定此工作流的提示词输入，不能批量替换提示词。');
      if (items.some(i => i.seed !== null) && !(c.bindings.seed && (!c.bindings.seed.readonly || c.bindings.seedSource))) throw new AppError(CODES.INVALID_ARGUMENT, '无法确定此工作流的 seed 输入。');
      const custom = applyCustomForm(c, c.apiPrompt, spec.formValues); // D04：批量同样按自定义表单写入
      const groupId = crypto.randomUUID();
      const specs = items.map(item => {
        const values = {...item.params, ...(item.prompt !== null ? {prompt: item.prompt} : {}), ...(item.seed !== null ? {seed: item.seed} : {})};
        const p = withPrefix(B.applyValues(custom.prompt, c.bindings, values), c, spec.prefixMode);
        return {workflowId: workflowIdOf(c), inputRevision: c.revision, groupId, snapshot: redactSnapshot(snapshotFor(c, p.prompt, {references: refsForRun(c.tabId, spec.references), params: values, meta: p.prefix ? {outputPrefix: p.prefix} : {}}))};
      });
      const created = queue.enqueueGroup(specs);
      return {groupId, tasks: created};
    },
    /** Q08：仅润色。只提交润色节点及其上游，完成后在任务输出中读取文本，不执行绘图。 */
    'tasks.enhance': async (tabId, {text, references = null, rerun = false, expectedRevision = null} = {}) => {
      const c = await compile(tabId, {expectedRevision});
      const enh = c.bindings.enhancer;
      if (!enh) throw new AppError(CODES.NOT_FOUND, '此工作流没有 Gemma 润色节点。');
      let prompt = c.apiPrompt;
      if (typeof text === 'string' && text.trim()) { try { prompt = B.setEnhancerOriginal(prompt, enh, text); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); } }
      const info = await getObjectInfo();
      if (!info) throw new AppError(CODES.SERVICE_UNAVAILABLE ?? CODES.INTERNAL, '无法读取 ComfyUI 节点信息，不能构造仅润色任务。');
      let sub;
      try { sub = B.extractEnhanceOnly(prompt, enh.nodeId, {objectInfo: info, rerun}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
      assertRunnable([...checkPrompt(sub.prompt, {objectInfo: info}), ...B.checkEnhancerRun(sub.prompt, enh, {contextLength: configRepo.config.gemma?.contextLength, maxReferenceImages: configRepo.config.gemma?.maxReferenceImages})]);
      return enqueue({kind: 'enhance', workflowId: workflowIdOf(c), inputRevision: c.revision, snapshot: snapshotFor(c, sub.prompt, {references: refsForRun(c.tabId, references).filter(r => sub.prompt[r.nodeId]), meta: {enhance: {outputNode: sub.outputNode, enhancer: enh}}})});
    },
    'tasks.enhanceResult': async id => {
      const t = tasks.get(id); if (!t || t.kind !== 'enhance') throw new AppError(CODES.NOT_FOUND, '不是润色任务。');
      if (t.state !== 'succeeded') return {state: t.state, text: null, error: t.error};
      const s = tasks.snapshotOf(t);
      const text = (t.outputs ?? []).filter(o => o.kind === 'text' && o.nodeId === s.enhance.outputNode).map(o => o.text).join('\n').trim();
      return {state: t.state, text: text || null, original: B.enhancerOriginal(s.apiPrompt, s.enhance.enhancer), error: text ? null : {message: '任务成功但没有读取到润色文本。'}};
    },
    'tasks.list': async (filter = {}) => ({tasks: tasks.list({states: filter.states, limit: Math.min(500, filter.limit ?? 100), groupId: filter.groupId}), queue: queue.state()}),
    'tasks.get': async id => { const t = tasks.get(id); if (!t) throw new AppError(CODES.NOT_FOUND, '任务不存在。'); return {...t, events: tasks.events_(id), lineage: tasks.lineage(id), submission: readSubmission(id)}; },
    'tasks.cancel': (id, opts) => queue.cancel(id, {globalInterrupt: opts?.globalInterrupt === true}),
    /** R12：状态未知的任务可能已在后端执行；重试必须显式确认可能重复出图。 */
    'tasks.retry': async (id, {confirmDuplicate = false} = {}) => {
      if (queue.tasks.get(id)?.state === 'unknown' && confirmDuplicate !== true) throw new AppError(CODES.INVALID_STATE, '该任务状态未知，可能已经执行过；重试可能重复出图，需要确认。', {details: {needsConfirm: true}});
      return queue.retry(id);
    },
    'tasks.recheck': id => queue.recheck(id),
    'tasks.pause': async () => { queue.pause(); return queue.state(); },
    'tasks.resume': async () => { queue.resume(); return queue.state(); },
    'tasks.refs': async tabId => relationsOf(tabId),
    'tasks.setRefs': async (tabId, items) => setRelations(tabId, items, editor.workspace?.tabs?.find(t => t.id === tabId)?.revision ?? null),
    'tasks.copyRefs': async (fromTabId, toTabId) => setRelations(toTabId, relationsOf(fromTabId).map(({missing, ...r}) => r)),
    'tasks.pickReference': async () => {
      const r = await dialog.showOpenDialog(getWindow(), {title: '选择参考图', properties: ['openFile'], filters: [{name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp']}]});
      if (r.canceled || !r.filePaths?.length) return {cancelled: true};
      return refs.importFile(r.filePaths[0]);
    },
  };
  const hooks = {
    activeTasks: () => queue.activeTasks(),
    waitForIdle: o => queue.waitForIdle(o),
    cancelActive: async ({timeoutMs = 15000} = {}) => { for (const t of queue.activeTasks()) { try { await queue.cancel(t.id); } catch (e) { logger?.warn('退出时取消失败', {id: t.id, error: e.message}); } } await queue.waitForIdle({timeoutMs}); },
    /** 返回释放函数（租约）；不改变用户暂停状态。 */
    pauseSubmissions: (reason = 'quit') => queue.acquirePause(reason),
    resumeSubmissions: (reason = 'quit') => queue.releasePauses(reason),
  };
  async function start() { connectSocket(); try { await queue.recoverOnStartup(); } catch (e) { logger?.error('任务恢复失败', {error: e.message}); } }
  function stop() { queue.stop(); socket?.close(); }
  return {tasks, queue, refs, methods, hooks, start, stop, compile, connectSocket, setFormProvider: f => { formProvider = f; }};
}
module.exports = {createTaskService, ReferenceStore, uploadReferences};
