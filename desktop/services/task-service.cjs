'use strict';
// Q06/Q08/Q09/Q10/E07/E08/E09：把编辑器编译、绑定、参考图、任务仓库和调度器组装成 tasks.* 接口。
const fs = require('node:fs');
const {secureSnapshot} = require('./snapshot-secrets.cjs');
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
const {mapFormTargets} = require('../../shared/form-targets.cjs');
const GP = require('./graph-package.cjs');
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
  /** C08：采用 worker 已校验并写好的暂存文件（同盘改名，不在主进程读整文件）。 */
  adoptFile(staged, refId) {
    if (!/^[0-9a-f]{64}\.(png|jpe?g|webp)$/.test(refId)) throw new AppError(CODES.INVALID_ARGUMENT, '参考图编号无效。');
    const target = path.join(this.dir, refId.slice(0, 2), refId);
    if (fs.existsSync(target)) { fs.rmSync(staged, {force: true}); return refId; }
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.renameSync(staged, target); return refId;
  }
  /** S08：从图包导入：内容编号即 sha256，写入前已由调用方校验。 */
  importBuffer(buf, refId) {
    if (!/^[0-9a-f]{64}\.(png|jpe?g|webp)$/.test(refId) || crypto.createHash('sha256').update(buf).digest('hex') !== refId.slice(0, 64)) throw new AppError(CODES.INTEGRITY, '参考图内容与编号不符。');
    const target = path.join(this.dir, refId.slice(0, 2), refId);
    if (!fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target + '.tmp', buf); fs.renameSync(target + '.tmp', target); }
    return refId;
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

function createTaskService({graphPolicy = null, credentials = null, db, layout, configRepo, events, locks, logger, editor, fetchImpl, WebSocketImpl, clientId = crypto.randomUUID(), dialog, getWindow, onTerminal = null, pool = null}) {
  const filePool = () => pool ?? require('../core/worker-pool.cjs').sharedPool();
  let templateRepo = null;
  const tasks = new TaskRepository(db, new SnapshotStore(layout['task-snapshots']), {events});
  const refs = new ReferenceStore(layout.references);
  let clientCache = null;
  const client = () => {
    const url = configRepo.config.comfy.url;
    if (!clientCache || clientCache.base.href !== new URL(url).href) clientCache = new ComfyHttpClient(url, {fetchImpl});
    return clientCache;
  };
  // RV02：object_info 落盘缓存。首次保存/离线时用上次连接得到的节点定义识别敏感字段，不要求先运行一次任务。
  const objectInfoFile = layout.root ? require('node:path').join(layout.root, 'object-info-cache.json') : null;
  let objectInfo = null, objectInfoAt = 0;
  try { if (objectInfoFile && fs.existsSync(objectInfoFile)) { const c = JSON.parse(fs.readFileSync(objectInfoFile, 'utf8')); if (c && typeof c.data === 'object') objectInfo = c.data; } } catch (e) { logger?.warn('object_info 缓存读取失败', {error: e.message}); }
  async function getObjectInfo() {
    if (objectInfo && objectInfoAt && Date.now() - objectInfoAt < 60000) return objectInfo;
    try {
      objectInfo = await client().objectInfo(); objectInfoAt = Date.now();
      if (objectInfoFile) { try { const tmp = `${objectInfoFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify({savedAt: new Date().toISOString(), data: objectInfo})); fs.renameSync(tmp, objectInfoFile); } catch (e) { logger?.warn('object_info 缓存写入失败', {error: e.message}); } }
    } catch (e) { logger?.warn('object_info 获取失败', {error: e.message}); }
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
  function dropRelations(tabId) { const d = readRel(); if (d.tabs[tabId]) { delete d.tabs[tabId]; writeRel(d); } }
  /** 关系 + 每项素材是否仍在本机（不能仅凭目录存在就认为引用有效）。 */
  function relationsOf(tabId) { return (readRel().tabs[tabId]?.items ?? []).map(r => ({...r, missing: !refs.has(r.refId)})); }
  function refsForRun(tabId, given) {
    if (given) return given;
    const list = relationsOf(tabId), lost = list.filter(r => r.missing);
    if (lost.length) throw new AppError(CODES.NOT_FOUND, `参考图文件已丢失：${lost.map(r => r.name || r.refId).join('、')}。请在“参考图”中重新选择或移除。`, {details: {missing: lost}});
    return list.map(({nodeId, input, refId}) => ({nodeId, input, refId}));
  }

  /* ---------- R18/D15：快照不存敏感输入明文；提交前在内存中还原 ---------- */
  // RV03：统一快照边界（API 图 + UI 图 + 其他字段），在仓库创建任务时执行，覆盖 enqueue/enqueueGroup/retry。
  const redactSnapshot = snapshot => secureSnapshot(snapshot, {policy: graphPolicy, credentials, objectInfo});
  tasks.secure = redactSnapshot;
  const resolveSecrets = prompt => SF.resolveSecrets(prompt, async name => credentials?.get(name) ?? null).catch(e => { throw new AppError(CODES.CREDENTIAL_UNAVAILABLE, e.message, {details: {missing: e.missing}}); });
  const enqueue = spec => queue.enqueue({...spec, snapshot: redactSnapshot(spec.snapshot)});
  /** S05：唯一的生产提交入口。其他服务（快捷使用等）只能经此提交，统一套用工作流身份、输出前缀、参考图与敏感字段政策。 */
  const submissions = {
    /** 从已编译标签和最终 API 图生成任务（不直接接触 queue/仓库）。 */
    enqueueCompiled: (c, prompt, {kind = 'generate', params = null, meta = {}, references, prefixMode} = {}) => {
      const p = withPrefix(prompt, c, prefixMode);
      return enqueue({kind, workflowId: workflowIdOf(c), inputRevision: c.revision, snapshot: snapshotFor(c, p.prompt, {references: refsForRun(c.tabId, references), params, meta: {...(p.prefix ? {outputPrefix: p.prefix} : {}), ...formIdentity(c, p.prompt), ...meta}})});
    },
    enqueue,
    enqueueGroup: specs => queue.enqueueGroup(specs.map(sp => ({...sp, snapshot: redactSnapshot(sp.snapshot)}))),
  };

  /* ---------- D04/PR11-R10：模板自定义表单进入正式运行 ---------- */
  let formProvider = null;
  const formOf = c => (c.templateId && formProvider ? formProvider(c.templateId, c.templateVersionId ?? null) : null);
  /** S07：任务快照记录使用的模板/表单版本（参数已经由面板写入图中）。 */
  // C06：只要来自模板就记录模板来源（表单为空也保留，模板首图缩略图不漏接）；有表单时记录版本与实际使用值
  const formIdentity = (c, prompt = c.apiPrompt) => {
    if (!c.templateId) return {};
    const f = formOf(c);
    if (!f?.fields?.length) return {templateId: c.templateId, form: {templateId: c.templateId, versionId: f?.versionId ?? c.templateVersionId ?? null, pinned: !!f?.pinned, fields: null}};
    const values = Object.fromEntries(f.fields.map((b, i) => [i, prompt?.[b.nodeId]?.inputs?.[b.fieldName] ?? null]));
    return {templateId: c.templateId, form: {templateId: c.templateId, versionId: f.versionId ?? null, pinned: !!f.pinned, values}};
  };
  /** C06：运行、批量、润色在编译后统一校验表单映射与实际值（不因没有传 formValues 就跳过）。 */
  function checkFormForRun(c, formValues = null) {
    const form = formOf(c); if (!form?.fields?.length) return;
    const map = F.validateMapping(form.fields, c.apiPrompt);
    const bad = map.filter(m => m.status !== 'ok');
    if (bad.length) throw new AppError(CODES.INVALID_STATE, `表单有 ${bad.length} 个字段映射失效：${bad[0].binding.label ?? bad[0].binding.fieldName}——${bad[0].reason} 请在表单设置中重新绑定或移除后再运行。`, {details: {bad: bad.map(m => ({label: m.binding.label ?? m.binding.fieldName, status: m.status}))}});
    map.forEach((m, i) => { if (formValues && Object.hasOwn(formValues, i)) return; const err = F.checkFieldValue(m.binding, c.apiPrompt[m.binding.nodeId].inputs[m.binding.fieldName]); if (err) throw new AppError(CODES.INVALID_ARGUMENT, `当前画布中的值不符合表单约束：${err}`); });
  }
  /** RV07：全部覆盖（formValues、绑定值、批量变化、params、采用润色）完成后，对最终 prompt 再校验：
   * 表单映射与约束（类型/范围/步长/选项），以及被覆盖输入的节点定义约束（枚举选项、数值范围）。 */
  function checkFinalPrompt(c, prompt, info, label = '') {
    const at = label ? `${label}：` : '';
    const form = formOf(c);
    if (form?.fields?.length) {
      const map = F.validateMapping(form.fields, prompt);
      for (const m of map) {
        if (m.status !== 'ok') throw new AppError(CODES.INVALID_ARGUMENT, `${at}最终参数使表单字段“${m.binding.label ?? m.binding.fieldName}”映射失效：${m.reason}`);
        const err = F.checkFieldValue(m.binding, prompt[m.binding.nodeId].inputs[m.binding.fieldName]);
        if (err) throw new AppError(CODES.INVALID_ARGUMENT, `${at}最终提交值不符合表单约束：${err}`);
      }
    }
    for (const [id, node] of Object.entries(prompt)) {
      const before = c.apiPrompt[id]?.inputs ?? {};
      for (const [name, value] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(value) || JSON.stringify(before[name]) === JSON.stringify(value)) continue; // 只检查被覆盖的输入
        const def = info?.[node.class_type]?.input; const spec = def?.required?.[name] ?? def?.optional?.[name];
        if (!Array.isArray(spec)) continue;
        if (Array.isArray(spec[0])) { if (!spec[0].some(o => String(o) === String(value))) throw new AppError(CODES.INVALID_ARGUMENT, `${at}${name} 的值“${value}”不在可选项中。`); continue; }
        const o = spec[1] ?? {};
        if (['INT', 'FLOAT'].includes(spec[0])) {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError(CODES.INVALID_ARGUMENT, `${at}${name} 必须是有效数字。`);
          if (spec[0] === 'INT' && !Number.isInteger(value)) throw new AppError(CODES.INVALID_ARGUMENT, `${at}${name} 必须是整数。`);
          if (typeof o.min === 'number' && value < o.min) throw new AppError(CODES.INVALID_ARGUMENT, `${at}${name} 不能小于 ${o.min}。`);
          if (typeof o.max === 'number' && value > o.max) throw new AppError(CODES.INVALID_ARGUMENT, `${at}${name} 不能大于 ${o.max}。`);
        }
      }
    }
  }
  /** RV07：快照里的表单值记录实际最终提交值。 */
  const finalForm = (custom, c, prompt) => {
    if (!custom.form) return formIdentity(c, prompt);
    const values = Object.fromEntries(custom.form.fields.map((b, i) => [i, prompt?.[b.nodeId]?.inputs?.[b.fieldName] ?? null]));
    return {templateId: custom.form.templateId, form: {...custom.form, values, requestedValues: custom.form.values}};
  };
  /** RV14：queue.maxBatch 是批量上限的唯一来源。 */
  const maxBatch = () => { const n = configRepo.config.queue?.maxBatch; return Number.isInteger(n) && n >= 1 ? n : 100; };
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
      // S07：同时给出 UI 根图中的编辑目标，正式参数面板直接写回同一工作副本
      const targets = mapFormTargets(form.fields, c.uiGraph);
      return {tabId: c.tabId, revision: c.revision, templateId: c.templateId, versionId: form.versionId ?? null, pinned: !!form.pinned, fields: map.map((m, i) => {
        const t = targets[i];
        return {index: i, ...m.binding, status: m.status, reason: m.reason, target: m.status === 'ok' && t.status === 'ok' ? t.target : null, panelStatus: t.status, panelReason: t.reason, value: m.status === 'ok' ? c.apiPrompt[m.binding.nodeId].inputs[m.binding.fieldName] : null};
      }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))};
    },
    /** C06：表单面板写回的主进程入口——校验表单版本、标签版本、映射与约束后再写画布；任何一项变化都拒绝并要求刷新。 */
    'tasks.applyFormField': async (tabId, {index, value, expectedRevision, versionId} = {}) => {
      if (!Number.isInteger(expectedRevision)) throw new AppError(CODES.INVALID_ARGUMENT, '缺少标签版本，请刷新表单。');
      const c = await compile(tabId, {expectedRevision});
      const form = formOf(c);
      if (!form?.fields?.length) throw new AppError(CODES.INVALID_STATE, '该标签没有已保存的自定义表单。');
      if ((form.versionId ?? null) !== (versionId ?? null)) throw new AppError(CODES.CONFLICT, '表单版本已变化，已拒绝写入，请刷新表单。');
      const field = form.fields[index]; if (!field) throw new AppError(CODES.NOT_FOUND, '表单字段不存在，请刷新。');
      const m = F.validateMapping([field], c.apiPrompt)[0];
      if (m.status !== 'ok') throw new AppError(CODES.INVALID_STATE, `字段映射失效：${m.reason}`);
      const err = F.checkFieldValue(field, value); if (err) throw new AppError(CODES.INVALID_ARGUMENT, err);
      const t = mapFormTargets([field], c.uiGraph)[0];
      if (t.status !== 'ok') throw new AppError(CODES.INVALID_STATE, t.reason ?? '未在画布中找到该参数。');
      const r = await editor.enqueue(() => editor.commands.applyParameters([{nodeId: t.target.nodeId, graphId: t.target.graphId, widgetName: t.target.widgetName, value}], c.tabId, c.revision));
      return {tabId: c.tabId, revision: r?.state?.tabs?.find(x => x.id === c.tabId)?.revision ?? null, applied: {index, value}};
    },
    'tasks.preview': async tabId => { const c = await compile(tabId); return {tabId: c.tabId, title: c.title, revision: c.revision, issues: c.issues, objectInfoAvailable: c.objectInfoAvailable, bindings: c.bindings, nodeCount: Object.keys(c.apiPrompt).length, maxBatch: maxBatch()}; },
    /** Q06：运行当前（或指定）标签。values 为绑定参数覆盖，references 为 [{nodeId,input,refId}]。 */
    'tasks.run': async (tabId, options = {}) => {
      const c = await compile(tabId, {expectedRevision: options.expectedRevision});
      assertRunnable(c.issues);
      checkFormForRun(c, options.formValues);
      const custom = applyCustomForm(c, c.apiPrompt, options.formValues);
      let prompt = B.applyValues(custom.prompt, c.bindings, options.values);
      const enh = c.bindings.enhancer;
      if (enh) { const notes = B.checkEnhancerRun(prompt, enh, {contextLength: configRepo.config.gemma?.contextLength, maxReferenceImages: configRepo.config.gemma?.maxReferenceImages}); assertRunnable(notes); }
      if (enh && options.adoptedText) { try { prompt = B.adoptEnhanced(prompt, enh, options.adoptedText, {objectInfo: await getObjectInfo()}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); } }
      checkFinalPrompt(c, prompt, await getObjectInfo());
      const p = withPrefix(prompt, c, options.prefixMode);
      return enqueue({workflowId: workflowIdOf(c), inputRevision: c.revision, snapshot: snapshotFor(c, p.prompt, {references: refsForRun(c.tabId, options.references), params: options.values, meta: {...(p.prefix ? {outputPrefix: p.prefix} : {}), ...(options.adoptedText ? {adopted: String(options.adoptedText)} : {}), ...finalForm(custom, c, prompt)}})});
    },
    /** Q10：批量。按提示词 × seed × 参数展开，同一分组 FIFO。 */
    'tasks.previewBatch': async (tabId, spec) => { const c = await compile(tabId); return {count: expandBatch(spec).length, max: maxBatch(), bindings: c.bindings, issues: c.issues}; },
    'tasks.runBatch': async (tabId, spec = {}) => {
      const c = await compile(tabId, {expectedRevision: spec.expectedRevision}); assertRunnable(c.issues);
      // R19：先全量规划与校验，任何一项无效整体拒绝；之后整组一次登记
      const types = {}; for (const [k, b] of Object.entries(c.bindings)) if (b && !b.readonly && 'value' in b) types[k] = {type: typeof b.value === 'number' ? (Number.isInteger(b.value) ? 'int' : 'float') : typeof b.value === 'boolean' ? 'bool' : 'string', label: k};
      const plan = planBatch({prompts: spec.prompts?.length ? spec.prompts : null, seeds: spec.seeds, count: spec.count, seedStart: spec.seedStart, variations: spec.variations}, types, {max: maxBatch()});
      if (!plan.ok) throw new AppError(CODES.INVALID_ARGUMENT, `批量计划无效：${plan.errors[0].message}`, {details: {errors: plan.errors}});
      const params = Array.isArray(spec.params) && spec.params.length ? spec.params : [{}];
      if (plan.total * params.length > maxBatch()) throw new AppError(CODES.INVALID_ARGUMENT, `批量共 ${plan.total * params.length} 个任务，超过上限 ${maxBatch()}。`);
      const items = plan.items.flatMap(it => params.map(p => ({prompt: it.prompt, seed: it.seed, params: {...p, ...it.values}})));
      if ((spec.prompts?.length > 0) && !c.bindings.prompt) throw new AppError(CODES.INVALID_ARGUMENT, '无法确定此工作流的提示词输入，不能批量替换提示词。');
      if (items.some(i => i.seed !== null) && !(c.bindings.seed && (!c.bindings.seed.readonly || c.bindings.seedSource))) throw new AppError(CODES.INVALID_ARGUMENT, '无法确定此工作流的 seed 输入。');
      checkFormForRun(c, spec.formValues);
      const custom = applyCustomForm(c, c.apiPrompt, spec.formValues); // D04：批量同样按自定义表单写入
      const groupId = crypto.randomUUID();
      const info = await getObjectInfo();
      // RV07：整组先全部算出最终 prompt 并校验，任一项无效整组零入队
      const finals = items.map((item, i) => {
        const values = {...item.params, ...(item.prompt !== null ? {prompt: item.prompt} : {}), ...(item.seed !== null ? {seed: item.seed} : {})};
        const finalPrompt = B.applyValues(custom.prompt, c.bindings, values);
        checkFinalPrompt(c, finalPrompt, info, `第 ${i + 1} 个任务`);
        return {values, finalPrompt};
      });
      const specs = finals.map(({values, finalPrompt}) => {
        const p = withPrefix(finalPrompt, c, spec.prefixMode);
        return {workflowId: workflowIdOf(c), inputRevision: c.revision, groupId, snapshot: snapshotFor(c, p.prompt, {references: refsForRun(c.tabId, spec.references), params: values, meta: {...(p.prefix ? {outputPrefix: p.prefix} : {}), ...finalForm(custom, c, finalPrompt)}})}; // C06：批量沿用同一表单身份
      });
      const created = submissions.enqueueGroup(specs);
      return {groupId, tasks: created};
    },
    /** Q08：仅润色。只提交润色节点及其上游，完成后在任务输出中读取文本，不执行绘图。 */
    'tasks.enhance': async (tabId, {text, references = null, rerun = false, expectedRevision = null} = {}) => {
      const c = await compile(tabId, {expectedRevision});
      const enh = c.bindings.enhancer;
      if (!enh) throw new AppError(CODES.NOT_FOUND, '此工作流没有 Gemma 润色节点。');
      checkFormForRun(c);
      let prompt = c.apiPrompt;
      if (typeof text === 'string' && text.trim()) { try { prompt = B.setEnhancerOriginal(prompt, enh, text); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); } }
      const info = await getObjectInfo();
      if (!info) throw new AppError(CODES.SERVICE_UNAVAILABLE ?? CODES.INTERNAL, '无法读取 ComfyUI 节点信息，不能构造仅润色任务。');
      let sub;
      try { sub = B.extractEnhanceOnly(prompt, enh.nodeId, {objectInfo: info, rerun}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
      assertRunnable([...checkPrompt(sub.prompt, {objectInfo: info}), ...B.checkEnhancerRun(sub.prompt, enh, {contextLength: configRepo.config.gemma?.contextLength, maxReferenceImages: configRepo.config.gemma?.maxReferenceImages})]);
      return enqueue({kind: 'enhance', workflowId: workflowIdOf(c), inputRevision: c.revision, snapshot: snapshotFor(c, sub.prompt, {references: refsForRun(c.tabId, references).filter(r => sub.prompt[r.nodeId]), meta: {enhance: {outputNode: sub.outputNode, enhancer: enh}, ...formIdentity(c)}})});
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
    /* ---------- S08：图 + 参考素材包；关闭归档的重新打开 ---------- */
    'tasks.exportPackage': async (tabId, {filePath = null} = {}) => {
      const t = await editor.enqueue(() => editor.commands.tabGraph(tabId));
      const form = t.templateId && formProvider ? formProvider(t.templateId, t.templateVersionId ?? null) : null;
      let target = filePath;
      if (!target) { const r = await dialog.showSaveDialog(getWindow(), {title: '导出图与参考素材', defaultPath: `${t.title}.yingzuo.json`, filters: [{name: '映作图包', extensions: ['json']}]}); if (r.canceled || !r.filePath) return {cancelled: true}; target = r.filePath; }
      // C01：导出政策移除敏感值；C08：读取素材、base64、JSON 与写盘在 worker 中进行，这里只传路径
      const ex = editor.exportCopy ? editor.exportCopy(t.graph) : null;
      const relations = relationsOf(tabId).map(({missing, ...r}) => ({...r, file: missing ? null : refs.pathOf(r.refId)}));
      return filePool().run('packBuild', {target, title: t.title, graph: t.graph, exportedGraph: ex?.graph ?? null, refill: ex?.refill ?? [], template: t.templateId ? {templateId: t.templateId, versionId: form?.versionId ?? t.templateVersionId ?? null, formSchema: form?.fields ?? null} : null, relations});
    },
    /**
     * C07：先整体校验（worker 内：大小、hash、槽位），再导入素材、打开标签、提交关系（缺失项也作为缺失关系恢复，运行时阻止）；
     * 包内表单恢复为新的本地模板版本（来源 ID 只作追溯，不绑定本机同名模板）。任一步失败：关闭新标签、移除关系，不留半成品。
     */
    'tasks.importPackage': async ({filePath = null} = {}) => {
      let file = filePath;
      if (!file) { const r = await dialog.showOpenDialog(getWindow(), {title: '导入映作图包', properties: ['openFile'], filters: [{name: '映作图包', extensions: ['json']}]}); if (r.canceled || !r.filePaths?.length) return {cancelled: true}; file = r.filePaths[0]; }
      const stageDir = path.join(layout.root, 'staging', `pkg-${crypto.randomBytes(6).toString('hex')}`);
      let tabId = null;
      try {
        let pkg;
        try { pkg = await filePool().run('packParse', {file, stageDir, objectInfo: objectInfo ?? null}); }
        catch (e) { throw new AppError(CODES[e.code] ? e.code : CODES.INVALID_ARGUMENT, e.message); }
        const formSchema = Array.isArray(pkg.template?.formSchema) && pkg.template.formSchema.length ? pkg.template.formSchema : null;
        const formErrors = formSchema ? F.validateSchema(formSchema) : [];
        for (const r of pkg.references) if (!r.missing) refs.adoptFile(r.staged, r.refId);
        const opened = await editor.enqueue(() => editor.commands.reopenArchived(pkg.title, pkg.graph, null, null));
        tabId = opened?.state?.activeId ?? null;
        if (!tabId) throw new AppError(CODES.INTERNAL, '未能打开导入的标签。');
        if (pkg.references.length) setRelations(tabId, pkg.references.map(r => ({nodeId: r.nodeId, input: r.input, refId: r.refId, name: r.name})));
        let template = null;
        if (formSchema && !formErrors.length && templateRepo) {
          const src = pkg.template.templateId ? String(pkg.template.templateId).slice(0, 80) : '未知';
          const created = templateRepo.create({name: `${pkg.title}（图包表单）`, graph: pkg.graph, formSchema, folder: '图包导入', source: `package:${src}`, note: `来自图包；原模板 ${src} @ ${String(pkg.template.versionId ?? '?').slice(0, 80)}，仅作追溯`});
          const ver = templateRepo.current(created.id).versionId;
          await editor.enqueue(() => editor.commands.setTemplateVersion(tabId, created.id, ver));
          template = {templateId: created.id, versionId: ver, sourceTemplateId: pkg.template.templateId ?? null, note: '包内表单已恢复为新的本地模板版本，可继续编辑与运行；原模板编号仅作追溯。'};
        } else if (pkg.template) template = {templateId: null, sourceTemplateId: pkg.template.templateId ?? null, note: formErrors.length ? `包内表单无效（${formErrors[0]}），已作为独立工作副本导入。` : '图包没有可用表单；已作为独立工作副本导入。'};
        const result = {tabId, references: pkg.references.filter(r => !r.missing).length, missing: pkg.references.filter(r => r.missing).map(r => r.name || r.refId), unverified: pkg.references.filter(r => r.verify === 'unverified').map(r => `${r.nodeId}.${r.input}`), refill: pkg.refill ?? [], template};
        tabId = null; // 成功：不再回滚
        return result;
      } catch (e) {
        if (tabId) { try { dropRelations(tabId); await editor.enqueue(() => editor.commands.closeTab(tabId)); } catch (re) { logger?.warn('图包导入回滚失败', {error: re.message}); } }
        throw e;
      } finally { fs.rmSync(stageDir, {recursive: true, force: true}); }
    },
    'tasks.closedList': async () => {
      const dir = layout.closed ?? path.join(layout.root, 'closed-workflows'); if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(n => /^[\w-]+\.json$/.test(n) && !n.endsWith('.meta.json')).map(n => {
        const id = n.slice(0, -5); let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf8')); } catch { /* 旧归档无元数据 */ }
        return {id, title: meta.title ?? id, closedAt: meta.closedAt ?? fs.statSync(path.join(dir, n)).mtime.toISOString(), templateId: meta.templateId ?? null, templateVersionId: meta.templateVersionId ?? null, references: relationsOf(id).length};
      }).sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, 200);
    },
    'tasks.reopenClosed': async id => {
      if (!/^[\w-]{1,80}$/.test(id ?? '')) throw new AppError(CODES.INVALID_ARGUMENT, '归档编号无效。');
      const dir = layout.closed ?? path.join(layout.root, 'closed-workflows');
      const file = path.join(dir, `${id}.json`); if (!fs.existsSync(file)) throw new AppError(CODES.NOT_FOUND, '归档不存在。');
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf8')); } catch { /* 旧归档 */ }
      const opened = await editor.enqueue(() => editor.commands.reopenArchived(meta.title ?? '恢复的工作副本', JSON.parse(fs.readFileSync(file, 'utf8')), meta.templateId ?? null, meta.templateVersionId ?? null));
      const tabId = opened?.state?.activeId;
      const rel = relationsOf(id);
      if (tabId && rel.length) setRelations(tabId, rel.map(({missing, ...r}) => r));
      return {tabId, references: rel.length, missing: rel.filter(r => r.missing).map(r => r.name || r.refId)};
    },
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
  const secrets = {
    /** S05：模板/草稿等持久化 UI 图前调用——敏感值转入系统加密存储，图中只留占位。 */
    redactGraph: (graph, apiPrompt) => redactSnapshot({uiGraph: graph, apiPrompt}).uiGraph,
  };
  return {tasks, queue, refs, methods, hooks, submissions, secrets, start, stop, compile, connectSocket, cachedObjectInfo: () => objectInfo, warmObjectInfo: () => getObjectInfo(), setTemplateRepo: r => { templateRepo = r; }, setFormProvider: f => { formProvider = f; }};
}
module.exports = {createTaskService, ReferenceStore, uploadReferences};
