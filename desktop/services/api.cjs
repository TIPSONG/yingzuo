'use strict';
// 公开 API（第 5.2 节）：按职责分组，命令 {requestId, method, args, expectedRevision?}，
// 返回 {ok:true,data}|{ok:false,error:{code,message,retryable,details?}}。没有通用 exec/readFile/writeFile。
const fs = require('node:fs');
const path = require('node:path');
const {validateCommand} = require('../../shared/schema.cjs');
const {AppError, CODES, toIpcError} = require('../core/errors.cjs');
const {CredentialStore} = require('../core/credentials.cjs');
const {redact} = require('../core/logger.cjs');
const {writeJsonAtomic} = require('../core/fs-atomic.cjs');
const {probeComfy, probeLmStudio, findModel} = require('./service-probe.cjs');
const {ComfyProcessManager} = require('./comfy-process.cjs');
const {LmStudioAdapter} = require('./lmstudio.cjs');
const {collectEnvironmentRecord} = require('./environment-record.cjs');
const {createAssetsMethods} = require('./assets-api.cjs');

const {prepareQuit: prepareQuitFlow} = require('./quit-flow.cjs');
function createApi(ctx) {
  const {electron, app, layout, dataRoot, configRepo, logger, events, locks, editor, migration, getWindow, fetch: fetchImpl, root} = ctx;
  const credentials = ctx.credentials ?? new CredentialStore(path.join(layout.root, 'credentials.json'), electron.safeStorage);
  const comfy = ctx.comfy ?? new ComfyProcessManager({registryFile: path.join(layout.root, 'services.json'), logsDir: layout.logs, probe: url => probeComfy(url, {fetchImpl})});
  const lmFor = () => new LmStudioAdapter({cliPath: configRepo.config.lmstudio.cli, registryFile: path.join(layout.root, 'lmstudio.json')});
  let lastStatus = null;
  let startGate = () => null;
  const hooks = ctx.taskService?.hooks ?? {activeTasks: () => [], waitForIdle: async () => {}, cancelActive: async () => {}, pauseSubmissions: () => {}, resumeSubmissions: () => {}};

  async function serviceStatus() {
    const config = configRepo.config;
    let comfyProbe, lmProbe;
    try { comfyProbe = await probeComfy(config.comfy.url, {fetchImpl, editorReady: {ready: editor.connected}}); }
    catch (e) { comfyProbe = {summary: 'config-error', error: e.message}; }
    if (comfyProbe.summary === 'ready' || comfyProbe.summary === 'degraded') comfyProbe.ownership = (await comfy.verifyOwned()) ? 'owned' : 'external';
    if (comfyProbe.summary === 'ready') ctx.taskService?.warmObjectInfo?.().catch?.(() => {}); // RV02：连上即缓存节点定义（落盘），供首次保存识别敏感字段
    const lm = lmFor();
    const cli = await lm.detect();
    try { lmProbe = await probeLmStudio(config.lmstudio.url, {fetchImpl, cli: {...cli, listLoaded: cli.available && cli.canListLoaded ? () => lm.listLoaded() : null}}); }
    catch (e) { lmProbe = {summary: 'config-error', error: e.message}; }
    lmProbe.gemma = findModel(lmProbe.models, ['gemma-4', 'gemma']);
    lmProbe.serverOwnership = lm.registry().serverOwned ? 'owned' : (lmProbe.api?.ok ? 'external' : null);
    const label = {ready: '已就绪', degraded: '已连接（WebSocket 异常）', offline: '未运行', 'port-occupied': '端口被占用', 'config-error': '配置错误', 'api-ready': 'API 已就绪', 'app-only': '已安装，API 未启动'};
    lastStatus = {comfy: comfyProbe, lmstudio: lmProbe, summary: {comfy: label[comfyProbe.summary] ?? comfyProbe.summary, lmstudio: label[lmProbe.summary] ?? lmProbe.summary}};
    events.emit('services.status', null, lastStatus);
    return lastStatus;
  }
  const diskInfo = dir => { try { const s = fs.statfsSync(dir); return {path: dir, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize}; } catch (e) { return {path: dir, error: e.message}; } };
  const knownLocations = () => {
    const d = configRepo.derived(layout);
    return {data: layout.root, logs: layout.logs, drafts: layout.drafts, output: d.output, input: d.input, workflows: d.workflows, favorites: d.favorites, downloads: d.downloads, backups: d.backups, templates: d.templates, comfy: configRepo.config.comfy.root};
  };
  async function openKnownLocation(name) {
    const target = knownLocations()[name];
    if (!target) throw new AppError(CODES.NOT_FOUND, '该位置尚未配置。');
    if (!fs.existsSync(target)) throw new AppError(CODES.NOT_FOUND, `目录不存在：${target}`);
    const error = await electron.shell.openPath(target);
    if (error) throw new AppError(CODES.INTERNAL, `无法打开 ${target}：${error}`);
    return {opened: target};
  }
  /* RV06：停止/释放显存与维护使用同一保护：环境锁 → 暂停提交 → 拒绝运行中任务并等待 starting 消退 →
     锁内重新核实服务归属与后端队列（有其他来源任务或无法确认时拒绝）→ 执行 → 释放租约与锁。 */
  async function backendForeignJobs() {
    const q = await fetchImpl(new URL('queue', configRepo.config.comfy.url), {signal: AbortSignal.timeout(3000)}).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
    const ids = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].map(i => i?.[1]).filter(Boolean);
    return ids.filter(id => !ctx.taskService?.tasks?.byPromptId?.(id));
  }
  async function guardedServiceOp(name, fn, {allowExternal = false} = {}) {
    const release = locks.environment.tryAcquire(name);
    if (!release) throw new AppError(CODES.LOCKED, `环境维护锁正被 ${locks.environment.holder ?? '其他操作'} 占用，请稍后再试。`);
    let lease = null;
    try {
      lease = hooks.pauseSubmissions(name) ?? null;
      if (hooks.activeTasks().length) throw new AppError(CODES.INVALID_STATE, '仍有本应用任务在提交或运行，请先等待完成或取消后再操作。');
      try { await hooks.waitForIdle({timeoutMs: 5000}); } catch { throw new AppError(CODES.INVALID_STATE, '有任务正在启动，请稍后再试。'); }
      if (hooks.activeTasks().length) throw new AppError(CODES.INVALID_STATE, '仍有本应用任务在提交或运行（等待期间已启动），请先等待完成或取消后再操作。');
      let owned = false; try { owned = !!(await comfy.verifyOwned()); } catch { owned = false; }
      if (!owned && !allowExternal) throw new AppError(CODES.NOT_OWNED, '当前 ComfyUI 不是本应用启动的实例（或无法核实），为安全起见不操作。');
      let foreign;
      try { foreign = await backendForeignJobs(); } catch (e) { throw new AppError(CODES.INVALID_STATE, `无法确认 ComfyUI 后端队列（${e.message}），为避免影响其他任务已停止操作。`); }
      if (foreign.length) throw new AppError(CODES.INVALID_STATE, `ComfyUI 后端还有 ${foreign.length} 个其他来源（原生画布或其他程序）的任务，已阻止。`, {details: {foreign: foreign.length}});
      const r = await fn({owned});
      serviceStatus().catch(() => {});
      return r;
    } finally { lease?.(); release(); }
  }
  const pickable = new Set(['comfy.root', 'comfy.python', 'comfy.workflowsDir', 'comfy.outputDir', 'comfy.inputDir', 'lmstudio.cli', 'paths.templates', 'paths.favorites', 'paths.downloads', 'paths.backups', 'gemma.patchFile']);

  const methods = {
    // ----- assets（A01–A08，见 assets-api.cjs）-----
    ...createAssetsMethods({electron, layout, configRepo, getWindow, logger}),
    // ----- services -----
    'services.status': serviceStatus,
    'services.startComfy': () => locks.environment.run(async () => {
      const held = startGate(); if (held) throw held; // C03：在实际取得环境锁之后检查维护阻断
      events.emit('services.comfy', null, {phase: 'starting'});
      try {
        const result = await comfy.ensureRunning(configRepo.config, {onProgress: p => events.emit('services.comfy', null, {phase: 'waiting', summary: p.summary})});
        events.emit('services.comfy', null, {phase: 'ready', ownership: result.ownership});
        await serviceStatus();
        return result;
      } catch (error) { events.emit('services.comfy', null, {phase: 'failed', error: error.message}); throw error; }
    }, {owner: 'start-comfy', timeoutMs: 1000}),
    'services.stopComfy': async () => guardedServiceOp('stop-comfy', async ({owned}) => {
      if (!owned) throw new AppError(CODES.NOT_OWNED, '当前 ComfyUI 不是本应用启动的实例（或无法核实），为安全起见不停止。');
      const result = await comfy.stop();
      if (editor.connected) editor.disconnectEditor();
      return result;
    }),
    /** RV06：释放显存会卸载后端所有模型。本应用实例在无任何任务时可直接释放；外部实例需显式确认（影响其他程序），且后端有任务时一律拒绝。 */
    'services.freeComfyMemory': async ({confirmExternal = false} = {}) => guardedServiceOp('free-comfy-memory', async ({owned}) => {
      if (!owned && confirmExternal !== true) throw new AppError(CODES.INVALID_STATE, '这是外部启动的 ComfyUI，释放显存会卸载它为其他程序加载的模型。需要确认后才执行。', {details: {needsConfirm: true}});
      return comfy.freeMemory(configRepo.config.comfy.url, fetchImpl);
    }, {allowExternal: true}),
    'services.startLmServer': async () => {
      const lm = lmFor(); const cli = await lm.detect();
      if (!cli.available) throw new AppError(CODES.NOT_FOUND, `${cli.error} 也可以手动打开 LM Studio，在 Developer 页面启动 Server。`);
      const status = lastStatus ?? await serviceStatus();
      const url = new URL(configRepo.config.lmstudio.url ?? 'http://127.0.0.1:1234');
      const port = Number(url.port) || null;
      const waitReady = async () => { for (let i = 0; i < 30; i++) { try { const r = await fetchImpl(new URL('models', url.href.replace(/\/?$/, '/')), {signal: AbortSignal.timeout(2000)}); if (r.ok) return true; } catch { /* 未就绪 */ } await new Promise(r => setTimeout(r, 1000)); } return false; };
      const result = await lm.startServer({apiReachable: !!status.lmstudio?.api?.ok, port, waitReady});
      await serviceStatus(); return result;
    },
    'services.stopLmServer': async () => { const lm = lmFor(); await lm.detect(); const r = await lm.stopServer({port: Number(new URL(configRepo.config.lmstudio.url ?? 'http://127.0.0.1:1234').port) || null}); await serviceStatus(); return r; },
    'services.logs': async () => ({comfy: comfy.logTail(), app: logger.tail(200)}),
    // ----- settings -----
    'settings.get': async () => ({...configRepo.snapshot(), dataRoot, locations: knownLocations(), credentials: credentials.status()}),
    'settings.update': async patch => { const r = configRepo.update(patch); logger.info('settings updated', {keys: Object.keys(patch)}); events.emit('settings.changed', null, {}); return r; },
    'settings.pickPath': async field => {
      if (!pickable.has(field)) throw new AppError(CODES.INVALID_ARGUMENT, '该配置项不能通过选择器设置。');
      const isFile = ['comfy.python', 'lmstudio.cli', 'gemma.patchFile'].includes(field);
      const result = await electron.dialog.showOpenDialog(getWindow(), {title: '选择位置', properties: [isFile ? 'openFile' : 'openDirectory']});
      if (result.canceled || !result.filePaths?.length) return {cancelled: true};
      const [group, key] = field.split('.');
      return configRepo.update({[group]: {[key]: result.filePaths[0]}});
    },
    'settings.setCredential': async (name, secret) => { credentials.set(name, secret); return credentials.status(); },
    'settings.removeCredential': async name => { credentials.remove(name); return credentials.status(); },
    // ----- maintenance -----
    'maintenance.info': async () => ({dataRoot, migration, appVersion: app.getVersion?.() ?? null, disk: [diskInfo(layout.root), ...(configRepo.config.comfy.root ? [diskInfo(configRepo.config.comfy.root)] : [])], locations: knownLocations(), logFile: logger.file, sequence: events.sequence}),
    'maintenance.eventsSince': async sequence => { const list = events.since(Number(sequence) || 0); return list === null ? {resync: true, sequence: events.sequence} : {events: list, sequence: events.sequence}; },
    'maintenance.openLocation': openKnownLocation,
    'maintenance.exportDiagnostics': async () => {
      const result = await electron.dialog.showSaveDialog(getWindow(), {title: '导出诊断信息', defaultPath: `yingzuo-diagnostics-${Date.now()}.json`, filters: [{name: 'JSON', extensions: ['json']}]});
      if (result.canceled || !result.filePath) return {cancelled: true};
      const record = await collectEnvironmentRecord({root, configRepo, layout, fetchImpl});
      // 诊断包不含凭据、密文、模型文件；路径中的用户名脱敏。
      const body = redact({createdAt: new Date().toISOString(), dataRoot, migration, environment: record, services: lastStatus, appLog: logger.tail(500), comfyLog: comfy.logTail(200)});
      writeJsonAtomic(result.filePath, body);
      return {path: result.filePath};
    },
    'maintenance.importAlphaDrafts': async () => {
      const result = await electron.dialog.showOpenDialog(getWindow(), {title: '导入 A 测浏览器草稿', properties: ['openFile'], filters: [{name: 'A 测导出', extensions: ['json']}]});
      if (result.canceled || !result.filePaths?.length) return {cancelled: true};
      const file = result.filePaths[0];
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new AppError(CODES.INVALID_ARGUMENT, '文件过大。');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.kind !== 'yingzuo-alpha-export' || data.version !== 1) throw new AppError(CODES.INVALID_ARGUMENT, '不是 A 测界面导出的草稿文件。');
      const tabs = Array.isArray(data.workspaceTabs) ? data.workspaceTabs.slice(0, 50) : [];
      const needReselect = tabs.filter(t => Number.isInteger(t.refsDropped) && t.refsDropped > 0).map(t => ({title: t.title, dropped: t.refsDropped}));
      const target = path.join(layout.migrations, `alpha-drafts-${Date.now()}.json`);
      writeJsonAtomic(target, {importedAt: new Date().toISOString(), source: path.basename(file), drafts: data.drafts ?? {}, workspaceTabs: tabs, needReselect});
      return {stored: target, tabs: tabs.length, needReselect};
    },
  };
  if (ctx.taskService) Object.assign(methods, ctx.taskService.methods);
  if (ctx.extraMethods) Object.assign(methods, ctx.extraMethods);
  async function dispatch(message) {
    const command = validateCommand(message);
    const fn = methods[command.method];
    if (!fn) throw new AppError(CODES.FORBIDDEN, `未知接口：${command.method}`);
    const started = Date.now();
    try {
      const data = await fn(...command.args);
      logger.info('api ok', {method: command.method, ms: Date.now() - started});
      return {ok: true, data};
    } catch (error) {
      logger.warn('api failed', {method: command.method, code: error.code, message: error.message});
      return {ok: false, error: toIpcError(error.code && !(error instanceof AppError) ? new AppError(CODES[error.code] ? error.code : 'INTERNAL', error.message) : error)};
    }
  }
  const prepareQuit = () => prepareQuitFlow({hooks, showMessageBox: opts => electron.dialog.showMessageBox(getWindow(), opts)});
  async function shutdownOwnedServices() {
    // RV06：退出时 owned 服务里若有其他来源任务（或无法确认），不停止它，保持运行并记录
    try {
      if (await comfy.verifyOwned()) {
        let foreign = null; try { foreign = await backendForeignJobs(); } catch (e) { foreign = null; logger.warn('退出时无法确认 ComfyUI 后端队列，保持运行', {error: e.message}); }
        if (foreign && !foreign.length) await comfy.stop();
        else if (foreign) logger.warn('退出时 ComfyUI 中还有其他来源任务，保持运行', {foreign: foreign.length});
      }
    } catch (e) { logger.warn('stop owned comfy failed', {error: e.message}); }
    try { const lm = lmFor(); if (lm.registry().serverOwned) { await lm.detect(); await lm.stopServer(); } } catch (e) { logger.warn('stop owned lm server failed', {error: e.message}); }
  }
  return {
    dispatch, methods, hooks, prepareQuit, shutdownOwnedServices, openKnownLocation, credentials, comfy, serviceStatus,
    setStartGate(fn) { startGate = typeof fn === 'function' ? fn : () => null; },
    lastServiceSummary: () => lastStatus?.summary,
    start() { serviceStatus().catch(e => logger.warn('initial probe failed', {error: e.message})); },
  };
}
module.exports = {createApi};
