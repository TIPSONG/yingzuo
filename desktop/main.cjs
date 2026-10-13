'use strict';
// 映作主进程：生命周期与组装。具体逻辑在 core/ repositories/ services/ adapters/。
const electron = require('electron');
const {app, BrowserWindow, WebContentsView, ipcMain, protocol, net, dialog, session} = electron;
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {randomUUID} = require('node:crypto');
const Store = require('./workspace-store.cjs');
const Bridge = require('./comfy-bridge-source.cjs');
const {createEditorSession} = require('./services/editor-session.cjs');
const {resolveDataRoot, ensureLayout, importLegacy} = require('./repositories/data-root.cjs');
const {ConfigRepository, checkLocalUrl} = require('./repositories/config-repo.cjs');
const {Logger} = require('./core/logger.cjs');
const {EventBus} = require('./core/events.cjs');
const {createLocks} = require('./core/locks.cjs');
const {AppError, CODES, toIpcError} = require('./core/errors.cjs');
const {createApi} = require('./services/api.cjs');
const {Database} = require('./repositories/database.cjs');
const {ComfyHttpClient} = require('./adapters/comfy-http.cjs');
const {createTaskService} = require('./services/task-service.cjs');
const {createMaintenanceService} = require('./services/maintenance-service.cjs');
const {createTemplateService} = require('./services/template-service.cjs');
const {createDiagnosticsService} = require('./services/diagnostics-service.cjs');
const {createOnlineService} = require('./services/online/online-service.cjs');
const {createDependencyService} = require('./services/online/dependency-plan.cjs');
const {createUpdateService} = require('./services/update-check.cjs');
const {CredentialStore} = require('./core/credentials.cjs');
const ROOT = path.resolve(__dirname, '..');
const LEGACY_LOCAL = path.join(ROOT, '.local');
const WORKBENCH = 'yingzuo://app/desktop/workbench.html';
const TEMPLATE_NAMES = [
  ['text','文生图','Qwen 2.1 Q6_K - Text to Image.json'],
  ['edit','多图参考编辑','Qwen 2.1 Q6_K - Multi Image Edit.json'],
  ['gemma-text','Gemma 润色 · 文生图','Qwen 2.1 Q6_K + Gemma - Text to Image.json'],
  ['gemma-edit','Gemma 润色 · 多图编辑','Qwen 2.1 Q6_K + Gemma - Multi Image Edit.json'],
  ['prompt','单独润色提示词','Gemma 4 - Prompt Enhancer.json'],
];

// ---------- 数据根、迁移、配置、日志（F04/F05/F07/S01） ----------
const dataRoot = resolveDataRoot({isPackaged: !!app.isPackaged, exePath: app.isPackaged ? process.execPath : null, userData: app.isPackaged ? app.getPath('userData') : null, devRoot: ROOT});
const layout = ensureLayout(dataRoot.root);
layout.exports = path.join(layout.root, 'exports');
layout.closed = layout['closed-workflows'];
const logger = new Logger(layout.logs);
const log = message => logger.info(message);
let migration = null;
if (globalThis.__yzAppRestore) logger.info('应用数据恢复', globalThis.__yzAppRestore);
if (dataRoot.mode === 'development') {
  try { migration = importLegacy({legacyDir: LEGACY_LOCAL, layout, writeWorkspace: Store.writeWorkspace, readLegacyWorkspace: Store.readWorkspace}); }
  catch (error) { migration = {status: 'failed', error: error.message}; logger.error('legacy import failed', {error: error.message}); }
}
app.setName('映作');
if (!app.isPackaged) app.setPath('userData', path.join(LEGACY_LOCAL, 'electron-profile'));
protocol.registerSchemesAsPrivileged([{scheme:'yingzuo',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const configRepo = new ConfigRepository(layout.config, {legacyFile: path.join(__dirname, 'config.local.json')});
configRepo.load();
const comfyUrlProvider = () => {
  const value = configRepo.config.comfy.url, problem = checkLocalUrl(value, {pathname:'/'});
  if (problem) throw new AppError(CODES.INVALID_ARGUMENT, `ComfyUI 地址配置有误：${problem}。请在设置中修复。`);
  return new URL(value);
};
const templates = () => {
  const dir = configRepo.derived(layout).workflows;
  return TEMPLATE_NAMES.map(([id,name,file]) => ({id,name,file,path:dir ? path.join(dir,file) : ''}));
};
const events = new EventBus();
const locks = createLocks();
let window = null, tray = null, explicitQuit = false;

function serveResource(request) {
  const url=new URL(request.url);
  let file;
  try{file=path.resolve(ROOT,'.'+decodeURIComponent(url.pathname));}catch{return new Response('',{status:400});}
  const relative=path.relative(ROOT,file);
  if(url.host!=='app'||relative.startsWith('..')||path.isAbsolute(relative)||relative.split(path.sep).some(x=>x.startsWith('.'))||!['.html','.js','.css','.svg','.png'].includes(path.extname(file))||!fs.existsSync(file)||!fs.statSync(file).isFile())return new Response('',{status:404});
  return net.fetch(pathToFileURL(file).href);
}
const editor = createEditorSession({
  electron: {WebContentsView, dialog, session}, Store, Bridge, paths: layout, log, serveResource, templates, comfyUrlProvider,
  getWindow: () => window, timers: {setTimeout, clearTimeout}, fetch, AbortSignal,
});
// ---------- 任务（Q01–Q10） ----------
let taskService = null, templateService = null, onlineService = null, appDb = null;
const credentials = new CredentialStore(path.join(layout.root, 'credentials.json'), electron.safeStorage);
const graphPolicy = require('../shared/graph-storage-policy.cjs').createGraphStoragePolicy({credentials, objectInfo: () => taskService?.cachedObjectInfo?.() ?? null});
try {
  const db = appDb = Database.open(layout.database);
  taskService = createTaskService({credentials, db, layout, configRepo, events, locks, logger, editor, fetchImpl: fetch, WebSocketImpl: globalThis.WebSocket, dialog, getWindow: () => window, onTerminal: async task => { const linked = await Promise.resolve().then(() => api.methods['assets.linkTask'](task.id)).catch(e => { logger.warn('作品关联失败', {error: e.message}); return []; }); try { const snap = taskService.tasks.snapshotOf(task); const img = (linked ?? []).find(x => x.status === 'linked' && /\.(png|jpe?g|webp)$/i.test(x.path)); if (task.state === 'succeeded' && img) await templateService?.autoThumbnail(snap.templateId ?? snap.form?.templateId ?? null, img.path); } catch (e) { logger.warn('模板缩略图生成失败', {error: e.message}); } return linked; }}); /* T01：模板首个成功输出作为缩略图 */
  templateService = createTemplateService({db, layout, editor, taskService, dialog, getWindow: () => window, builtins: templates, pool: require('./core/worker-pool.cjs').sharedPool()});
  taskService.setTemplateRepo(templateService.repo); /* C07：图包表单恢复为新的本地模板版本 */
  taskService.setFormProvider((id, versionId) => { try { const v = versionId ? templateService.repo.version(versionId) : templateService.repo.current(id); if (v && v.templateId !== id) return null; return v ? {versionId: v.versionId ?? null, fields: v.formSchema ?? null, pinned: !!versionId} : null; } catch { return null; } }); /* S07：按标签固定的模板版本读取表单 */
  onlineService = createOnlineService({db, configRepo, layout, credentials, fetchImpl: fetch, events, logger, templateRepo: templateService.repo, dialog, getWindow: () => window});
} catch (error) { logger.error('任务数据库不可用，运行功能停用', {error: error.message}); }
const diagnostics = createDiagnosticsService({editor, client: () => new ComfyHttpClient(configRepo.config.comfy.url, {fetchImpl: fetch}), fetchImpl: fetch, configRepo, layout, dialog, getWindow: () => window});
const dependencies = onlineService ? createDependencyService({editor, diagnostics, online: onlineService, configRepo, layout}) : null;
const updates = onlineService ? createUpdateService({app, configRepo, layout, fetchImpl: fetch, online: onlineService, electron, events, logger}) : null;
const api = createApi({taskService, credentials, extraMethods: {...updates?.methods, ...templateService?.methods, ...diagnostics.methods, ...onlineService?.methods, ...dependencies?.methods}, electron, app, layout, dataRoot, configRepo, logger, events, locks, editor, migration, getWindow: () => window, fetch, root: ROOT, comfyUrlProvider});
if (appDb) { const m = createMaintenanceService({db: appDb, credentials, layout, configRepo, locks, events, logger, comfy: api.comfy, taskService, templateRepo: templateService?.repo, editor, fetchImpl: fetch}); Object.assign(api.methods, m.methods); api.setStartGate(m.gate); /* S02/C03：恢复阻断期间不启动服务；在环境锁内检查 */ m.recoverModelMoves().then(r => { if (r.length) logger.info('模型移动启动核对', {results: r}); }, e => logger.warn('模型移动启动核对失败', {error: e.message})); }

function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== WORKBENCH) throw new Error('拒绝未知页面请求。');
}

// ---------- 托盘（S06） ----------
function showWindow() { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
function buildTray() {
  if (tray || typeof electron.Tray !== 'function') return;
  try {
    const icon = electron.nativeImage.createFromPath(path.join(ROOT, 'assets', process.platform === 'win32' ? 'tray-16.png' : 'tray-32.png'));
    tray = new electron.Tray(icon);
    tray.setToolTip('映作');
    tray.on('click', showWindow);
    refreshTrayMenu();
  } catch (error) { logger.warn('tray unavailable', {error: error.message}); tray = null; }
}
function refreshTrayMenu(status = api.lastServiceSummary?.()) {
  if (!tray) return;
  const comfy = status?.comfy ?? '未检测', lm = status?.lmstudio ?? '未检测';
  tray.setContextMenu(electron.Menu.buildFromTemplate([
    {label: '显示映作', click: showWindow},
    {label: `ComfyUI：${comfy}`, enabled: false},
    {label: `LM Studio：${lm}`, enabled: false},
    {type: 'separator'},
    {label: '打开输出目录', click: () => api.openKnownLocation('output').catch(e => logger.warn('open output failed', {error: e.message}))},
    {type: 'separator'},
    {label: '退出映作', click: () => requestQuit()},
  ]));
}
events.subscribe(event => { if (event.type === 'settings.changed') taskService?.connectSocket(); });
events.subscribe(event => { if (event.type === 'services.status') refreshTrayMenu(event.data.summary); });

// ---------- 退出（S07） ----------
let quitInProgress = null;
async function requestQuit() {
  if (quitInProgress) return quitInProgress;
  quitInProgress = (async () => {
    const decision = await api.prepareQuit(); // 运行中任务：等待／取消后退出／返回
    if (decision === 'return') return false;
    editor.quitting = true;
    try {
      await editor.enqueue(async()=>{if(editor.startupError){await editor.capture();if(editor.workspace.tabs.length)Store.writeWorkspace(path.join(layout.root,`recovered-workspace-${Date.now()}.json`),editor.workspace,{secureGraph:editor.secureDisk});}else await editor.saveCurrent();});
    } catch (error) {
      editor.quitting = false;
      api.hooks.resumeSubmissions();
      editor.notify({error:`保存未完成，窗口已保留：${error.message}`});
      dialog.showErrorBox('草稿尚未保存',`${error.message}\n窗口已保留，请重试保存或导出工作流后再退出。`);
      return false;
    }
    await api.shutdownOwnedServices();
    explicitQuit = true;
    taskService?.stop(); updates?.stopSchedule(); editor.closeViews(); tray?.destroy?.(); window?.destroy(); app.quit();
    return true;
  })().finally(() => { quitInProgress = null; });
  return quitInProgress;
}

// 单实例锁已在 entry.cjs 中先于迁移取得；这里保留检查以兼容直接加载 main.cjs
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>showWindow());
  app.whenReady().then(async()=>{
    protocol.handle('yingzuo',serveResource);
    window=new BrowserWindow({width:1500,height:980,minWidth:1050,minHeight:700,backgroundColor:'#131514',title:'映作',icon:path.join(ROOT,'assets','icon-256.png'),autoHideMenuBar:true,frame:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    editor.attachWindow(window);
    editor.setGraphPolicy(graphPolicy); /* C01：系统加密存储在 ready 之后可用 */
    if (appDb) { try { const rep = require('./maintenance/secret-migration.cjs').migrateStoredGraphs({db: appDb, layout, repo: templateService?.repo, policy: graphPolicy, credentials, persistDrafts: () => editor.persist()}); if (rep.migrated.length || rep.pending.length) logger.info('已保存图的敏感字段迁移/检查', {migrated: rep.migrated.length, pending: rep.pending.length}); } catch (e) { logger.warn('敏感字段迁移检查失败', {error: e.message}); } }
    taskService?.start();
    onlineService?.start(); updates?.startSchedule();
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if((event.url??url)!==WORKBENCH)event.preventDefault();});
    ipcMain.handle('yingzuo:p0',async(event,message)=>{
      try {assertSender(event);if(editor.quitting)throw new Error('正在保存并退出，请稍候。');if(!message||!Object.hasOwn(editor.commands,message.method)||typeof editor.commands[message.method]!=='function'||!Array.isArray(message.args))throw new Error('未知桌面操作。');log(`begin ${message.method}`);const result=await editor.enqueue(()=>editor.commands[message.method](...message.args));log(`done ${message.method}`);return {ok:true,...result};}
      catch(error){log(`failed ${message?.method}: ${error.message}`);return {ok:false,error:error.message,state:editor.state(),snapshot:editor.currentSnapshot()};}
    });
    ipcMain.handle('yingzuo:api',async(event,message)=>{
      try { assertSender(event); return await api.dispatch(message); }
      catch (error) { return {ok:false,error:toIpcError(error)}; }
    });
    ipcMain.on('yingzuo:p0-bounds',(event,value)=>{try{assertSender(event);editor.setBounds(value);}catch{}});
    ipcMain.on('yingzuo:overlay',(event,value)=>{try{assertSender(event);editor.setOverlay(value===true);}catch{}});
    ipcMain.handle('yingzuo:window', async (event, message) => {
      assertSender(event);
      if (!window || window.isDestroyed()) return {ok: false};
      const op = message?.op;
      if (op === 'minimize') { window.minimize(); return {ok: true}; }
      if (op === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); return {ok: true, maximized: window.isMaximized()}; }
      if (op === 'close') { window.close(); return {ok: true}; }
      if (op === 'isMaximized') return {ok: true, maximized: window.isMaximized()};
      throw new Error('未知窗口操作。');
    });
    const sendWindowState = () => { if (window && !window.isDestroyed()) window.webContents.send('yingzuo:window-state', {maximized: window.isMaximized()}); };
    window.on('maximize', sendWindowState);
    window.on('unmaximize', sendWindowState);
    events.subscribe(event => { if (window && !window.isDestroyed()) window.webContents.send('yingzuo:event', event); });
    window.on('resize',editor.layout);
    window.on('close',event=>{
      if (explicitQuit) return;
      event.preventDefault();
      if (editor.quitting) return;
      if (configRepo.config.tray.closeToTray && tray) {
        // 关窗：先保存草稿再缩到托盘；保存失败时保留窗口。
        editor.enqueue(()=>editor.saveCurrent()).then(()=>window.hide()).catch(error=>{editor.notify({error:`保存未完成，窗口已保留：${error.message}`});});
        return;
      }
      requestQuit();
    });
    buildTray();
    await window.loadURL(WORKBENCH);
    window.show();window.focus();
    const timer=setInterval(()=>{
      if(editor.autosaveQueued||!editor.connected||!editor.active()||editor.quitting)return;
      editor.autosaveQueued=true;editor.enqueue(async()=>{if(!editor.active())return;const transport=editor.currentSnapshot()?.connected;await editor.capture();if(editor.persistedWorkspace!==JSON.stringify(editor.workspace)){editor.persist();editor.notify({message:'草稿已自动保存。'});}else if(transport!==editor.lastSnapshot?.connected)editor.notify({message:editor.lastSnapshot?.connected?'WebSocket 已重新连接。':'WebSocket 已断开，当前画布和草稿仍保留。'});}).catch(error=>editor.notify({error:`自动保存失败：${error.message}`})).finally(()=>editor.autosaveQueued=false);
    },2500);timer.unref();
    api.start();
    // R21：CI 业务初始化检查（仅在设置 YZ_INIT_CHECK 时；须同时用 YINGZUO_DATA_ROOT 指向隔离目录）
    if (typeof process !== "undefined" && process.env?.YZ_INIT_CHECK) {
      const isolated = dataRoot.mode === 'override';
      const result = {ok: isolated && !!taskService && !!templateService && !!onlineService && Object.keys(api.methods).length > 50, dataRootMode: dataRoot.mode, taskService: !!taskService, templateService: !!templateService, onlineService: !!onlineService, methods: Object.keys(api.methods).length, workbench: window.webContents.getURL(), at: new Date().toISOString()};
      fs.writeFileSync(process.env.YZ_INIT_CHECK, JSON.stringify(result, null, 2));
      explicitQuit = true; app.exit(result.ok ? 0 : 1);
    }
  }).catch(error=>{dialog.showErrorBox('映作启动失败',error.message);app.quit();});
  app.on('before-quit', event => { if (!explicitQuit) { event.preventDefault(); requestQuit(); } });
  app.on('will-quit', () => { require('./core/worker-pool.cjs').closeShared().catch(() => {}); }); /* S09：退出时终止全部 worker */
  app.on('window-all-closed',()=>{ if (explicitQuit) app.quit(); });
}
