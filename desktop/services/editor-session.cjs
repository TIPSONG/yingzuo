'use strict';
// F02/E03/E06：编辑器会话。原 P0 主进程中的视图、工作副本、身份核对与串行操作逻辑，
// 以依赖注入方式拆出（计时器、fetch、Electron 对象均由 main.cjs 传入，便于测试）。
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const ImportPipeline = require('../../shared/import-pipeline.cjs');
function createEditorSession(env) {
const {electron:{WebContentsView, dialog, session}, Store, Bridge, paths, log, getWindow, serveResource, timers:{setTimeout, clearTimeout}, fetch, AbortSignal, templates, comfyUrlProvider, partition = 'persist:yingzuo-p0-comfy'} = env;
let window = null;
let comfyUrl = null;
const currentComfyUrl = () => { try { return comfyUrlProvider(); } catch { return null; } };
let workspace, startupError = null;
try { workspace = Store.readWorkspace(paths.workspace); }
catch (error) { startupError = error.message; workspace = Store.emptyWorkspace(); }
let comfyView, previewView, bounds, currentView = 'editor', loadedId = null, connected = false;
let overlay = false;
let connecting = null, lastSnapshot = null, capabilities = null, autosaveQueued = false, quitting = false;
let editorGeneration = 0, editorCrashed = false, recoveryPending = false, pendingForeignGraph = null, foreignRecoveryPath = null;
let persistedWorkspace = JSON.stringify(workspace);
let commandTail = Promise.resolve();
const enqueue = operation => { const task = commandTail.then(operation); commandTail = task.catch(()=>{}); return task; };
const active = () => workspace.tabs.find(tab => tab.id === workspace.activeId);
const expectedName = () => active() ? `yingzuo-${active().id}` : undefined;
const currentSnapshot = () => connected && loadedId === workspace.activeId ? lastSnapshot : null;
const state = () => ({tabs:workspace.tabs.map(({id,title,templateId,mode,revision})=>({id,title,templateId,mode,revision})), activeId:workspace.activeId, connected, transportConnected:connected && (currentSnapshot()?.connected??capabilities?.connected??false), currentView, capabilities, recoveryPending, startupError, savedPath:paths.workspace, comfyUrl:currentComfyUrl()?.href ?? null});
const notify = data => { if (window && !window.isDestroyed()) window.webContents.send('yingzuo:p0-status', {...state(),snapshot:currentSnapshot(),...data}); };
function persist() { if (startupError) throw new Error('旧工作区读取失败，已保留原文件。请先检查后再保存新草稿。'); Store.writeWorkspace(paths.workspace,workspace);persistedWorkspace=JSON.stringify(workspace); }
function layout() {
  if (!window || !bounds) return;
  const rect = Store.validateBounds(bounds,window.getContentSize());
  const hasArea = rect.width > 0 && rect.height > 0;
  comfyView?.setBounds(rect); previewView?.setBounds(rect);
  comfyView?.setVisible(hasArea && !overlay && currentView === 'editor' && (recoveryPending || connected && !!active() && active().mode !== 'parameters'));
  previewView?.setVisible(hasArea && !overlay && currentView === 'preview');
}
function disconnectEditor() {
  editorGeneration++; connected=false;loadedId=null;lastSnapshot=null;capabilities=null;layout();
}
function protectView(view, allowed, onFailure) {
  view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  view.webContents.on('will-navigate',(event,url)=>{if(!allowed(event.url??url))event.preventDefault();});
  view.webContents.on('will-redirect',(event,url)=>{if(!allowed(event.url??url))event.preventDefault();});
  view.webContents.on('render-process-gone',onFailure);
}
function isComfyPage(url) { try { return new URL(url).origin === comfyUrl.origin; } catch {return false;} }
function configureDownloads(ses) {
  ses.on('will-download',(_event,item)=>{
    try {
      const folder = paths.exports; fs.mkdirSync(folder,{recursive:true});
      const filename = Store.safeName(path.basename(item.getFilename()));
      const target = path.join(folder,`${Date.now()}-${randomUUID()}-${filename}`);
      item.setSavePath(target);
      item.once('done',(_event,status)=>notify(status === 'completed' ? {message:`文件已保存：${target}`,download:{path:target,status}} : {error:`下载未完成：${status}`}));
    } catch (error) {
      item.cancel();
      notify({error:`下载无法保存：${error.message}`});
    }
  });
}
async function execute(source) {
  if (!comfyView || comfyView.webContents.isDestroyed() || !isComfyPage(comfyView.webContents.getURL())) throw new Error('ComfyUI 视图尚未连接。');
  const contents = comfyView.webContents;
  const generation = editorGeneration;
  let timer;
  let result;
  try {
    result = await Promise.race([contents.executeJavaScript(source), new Promise((_,reject)=>{timer=setTimeout(()=>{
      disconnectEditor();contents.forcefullyCrashRenderer();
      reject(new Error('编辑器响应超时；已停止该视图以避免迟到的修改。请重新连接。'));
    },30000);})]);
  } catch (error) {
    disconnectEditor();
    throw error;
  } finally {clearTimeout(timer);}
  if (generation !== editorGeneration || contents.isDestroyed()) throw new Error('编辑器连接已改变，已忽略过期结果。请重新连接。');
  if (!result?.ok) {const error=new Error(result?.error?.message || 'ComfyUI 桥接未返回有效结果。');error.code=result?.error?.code;error.needsSnapshot=result?.needsSnapshot;throw error;}
  return result;
}
function keepSnapshot(result, tab) {
  Store.setGraph(tab, result.graph);
  const viewport = Store.validViewport(result.viewport);
  if (viewport) tab.viewport = viewport;
  tab.workflowPath = result.workflow?.path;
  tab.documentId = result.workflow?.documentId;
  lastSnapshot = result;
}
async function recoverForeignGraph() {
  if (!recoveryPending) return;
  try {
    const archive=graph=>{
      const folder=paths.closed;fs.mkdirSync(folder,{recursive:true});
      const file=path.join(folder,`native-${Date.now()}-${randomUUID()}.json`);
      fs.writeFileSync(file,JSON.stringify(graph,null,2));
      foreignRecoveryPath=file;
    };
    // First make any earlier capture durable, even if the renderer has since
    // crashed. Then refresh a still-live canvas so edits made during a disk
    // failure are also backed up before any destructive reconnect.
    const earlier=pendingForeignGraph;
    if(earlier){archive(earlier);pendingForeignGraph=null;}
    if(!editorCrashed) {
      const foreign=await execute(Bridge.snapshotSource());
      pendingForeignGraph=structuredClone(Store.validateGraph(foreign.graph));
      if(!earlier || JSON.stringify(earlier)!==JSON.stringify(pendingForeignGraph))archive(pendingForeignGraph);
      pendingForeignGraph=null;
    }
    if(!foreignRecoveryPath)throw new Error('编辑器已退出，无法取得恢复快照');
    recoveryPending=false;disconnectEditor();
    return foreignRecoveryPath;
  } catch (error) {
    throw new Error(`恢复副本尚未保存：${error.message}。已暂停重新连接与退出，避免覆盖该图；请修复保存位置后重试，也可在原生画布中手动导出。`);
  }
}
async function capture() {
  if(recoveryPending){await recoverForeignGraph();return null;}
  const tab = active();
  if (!tab || !connected || loadedId !== tab.id) return null;
  let snapshot;
  try { snapshot = await execute(Bridge.snapshotSource({expectedName:expectedName()})); }
  catch(error) {
    if(error.code==='WORKFLOW_CHANGED') {
      // An unarchived native graph must survive failed disk writes. Keep its
      // snapshot in memory and prohibit reload/exit until the archive is durable.
      recoveryPending=true;foreignRecoveryPath=null;
      try {
        const file=await recoverForeignGraph();
        error.message=`ComfyUI 内部切换的图已另存为 ${file}，未覆盖桌面标签。请重新连接。`;
      } catch (recoveryError) { error.message=recoveryError.message; }
      finally { disconnectEditor(); }
      notify({error:error.message});
    }
    throw error;
  }
  keepSnapshot(snapshot,tab);
  return snapshot;
}
async function saveCurrent() { await capture(); persist(); return {state:state(),snapshot:currentSnapshot()}; }
async function connect() {
  if(recoveryPending)await recoverForeignGraph();
  if (connected) return {state:state(),snapshot:currentSnapshot()};
  if (connecting) return connecting;
  const before = structuredClone(workspace);
  connecting = (async()=>{
    comfyUrl = comfyUrlProvider();
    const response = await fetch(new URL('system_stats',comfyUrl),{signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error(`ComfyUI 状态检查失败：HTTP ${response.status}`);
    const stats = await response.json();
    if (!stats.system || !Array.isArray(stats.devices)) throw new Error('该端口未返回 ComfyUI 状态。');
    if (!comfyView) {
      const ses = session.fromPartition('persist:yingzuo-p0-comfy');
      ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
      ses.setPermissionCheckHandler(()=>false);
      configureDownloads(ses);
      comfyView = new WebContentsView({webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
      window.contentView.addChildView(comfyView); comfyView.setVisible(false);
      protectView(comfyView,isComfyPage,()=>{editorCrashed=true;disconnectEditor();notify({error:'编辑器进程已退出，已保存的草稿保留。请重新连接。'});});
      comfyView.webContents.on('did-start-navigation',(event,_url,isInPlace,isMainFrame)=>{
        if ((event.isMainFrame??isMainFrame) && !(event.isSameDocument??isInPlace)) {disconnectEditor();notify({message:'编辑器页面正在重新载入，请等待连接完成。'});}
      });
    }
    if(bounds)comfyView.setBounds(Store.validateBounds(bounds,window.getContentSize()));
    comfyView.setVisible(true);
    await comfyView.webContents.loadURL(comfyUrl.href);
    editorCrashed=false;
    let readinessError;
    for (let attempt=0;attempt<60;attempt++) {
      try { capabilities = await execute(Bridge.getCapabilitiesSource()); readinessError=null; break; }
      catch (error) { readinessError=error;if(error.code!=='NOT_READY')break;await new Promise(resolve=>setTimeout(resolve,500)); }
    }
    if (readinessError) throw readinessError;
    connected = true; loadedId = null;
    if (active()) {await loadActive();persist();}
    layout(); notify({message:'真实 ComfyUI 已连接。'});
    return {state:state(),snapshot:currentSnapshot()};
  })();
  try { return await connecting; }
  catch (error) { workspace=before;disconnectEditor();throw new Error(`连接未完成：${error.message}。P0 不自动启动服务，可使用现有启动脚本。`); }
  finally { connecting=null; }
}
async function loadActive() {
  const tab = active();
  loadedId=null;lastSnapshot=null;
  if (!tab) {layout();return;}
  const result = await execute(Bridge.loadGraphSource({graph:tab.graph,name:`yingzuo-${tab.id}`,workflowPath:tab.workflowPath,documentId:tab.documentId,viewport:tab.viewport??undefined}));
  if (tab.mode === 'app') {
    try {await execute(Bridge.setModeSource('app',expectedName()));}
    catch (error) {
      if (error.code !== 'APP_NOT_CONFIGURED') throw error;
      await execute(Bridge.setModeSource('graph',expectedName()));
      tab.mode='parameters';
    }
  } else await execute(Bridge.setModeSource('graph',expectedName()));
  keepSnapshot(result,tab);loadedId=tab.id;
  layout();
}
// Save the old draft before changing selection or membership. If a new native
// graph was touched, rollback the host workspace and require an explicit reconnect.
async function changeWorkspace(change, showEditor=false) {
  await capture();persist();
  const before=structuredClone(workspace), previousSnapshot=lastSnapshot, previousLoadedId=loadedId, previousView=currentView;
  let changedEditor=false;
  try {
    await change();
    if(showEditor)currentView='editor';
    if(workspace.activeId!==before.activeId) {
      lastSnapshot=null;loadedId=null;
      if(connected){changedEditor=true;await loadActive();}
    }
    persist();layout();
  } catch(error) {
    workspace=before;currentView=previousView;
    if(changedEditor)disconnectEditor();
    else if(connected){lastSnapshot=previousSnapshot;loadedId=previousLoadedId;}
    layout();throw error;
  }
  return {state:state(),snapshot:currentSnapshot()};
}
async function activate(id) {
  const target = workspace.tabs.find(tab=>tab.id===id);
  if (!target) throw new Error('找不到该工作副本。');
  if (workspace.activeId === id) {currentView='editor';const snapshot=await capture();layout();return {state:state(),snapshot};}
  const result=await changeWorkspace(()=>{workspace.activeId=id;},true);
  notify({message:`已切换：${target.title}`});
  return result;
}
async function newTab(title,graph,templateId=null) {
  return changeWorkspace(()=>{workspace.activeId=Store.addTab(workspace,title,graph,templateId).id;},true);
}
// E05：统一导入。UI 图直接成为新标签；API 图先保存原文件，再在新空白标签中用官方 loadApiJson 重建。
async function importText(text,name){
  const info=ImportPipeline.analyze(text,{name});
  if(info.format==='ui')return {...await newTab(info.name,Store.validateGraph(info.graph)),importInfo:{format:'ui',nodeCount:info.nodeCount,notes:info.notes}};
  const folder=path.join(paths.root,'imports');fs.mkdirSync(folder,{recursive:true});
  const original=path.join(folder,`${Date.now()}-${Store.safeName(info.name)}.api.json`);
  fs.writeFileSync(original,JSON.stringify(info.apiPrompt,null,2));
  if(!connected)throw new Error(`这是 API 格式工作流，需要连接 ComfyUI 才能用官方转换重建可视图。原文件已保存：${original}`);
  await newTab(`${info.name}（API 转换）`,{last_node_id:0,last_link_id:0,nodes:[],links:[],groups:[],config:{},extra:{},version:0.4});
  const tab=active();
  let converted;
  try{converted=await execute(Bridge.convertApiSource({expectedName:expectedName(),prompt:info.apiPrompt,fileName:`${info.name}.json`}));}
  catch(error){throw new Error(`API 转换失败：${error.message}。已保留空白标签和原文件 ${original}，没有伪造连线。`);}
  keepSnapshot(converted,tab);persist();
  const check=ImportPipeline.compareConversion(info.apiPrompt,converted.nodes);
  return {state:state(),snapshot:currentSnapshot(),importInfo:{format:'api',original,nodeCount:info.nodeCount,complete:check.complete,missingTypes:check.missingTypes,notes:info.notes},message:check.complete?`已用官方转换重建 ${check.total} 个节点；原文件：${original}`:`已转换，但以下节点类型未能重建：${check.missingTypes.join('、')}。原文件：${original}`};
}
const commands = {
  boot: async()=>({state:state(),templates:templates().map(t=>({id:t.id,name:t.name,available:fs.existsSync(t.path)}))}),
  connect,
  openTemplate: async id=>{
    const template=templates().find(t=>t.id===id);
    if (!template) throw new Error('未知模板。');
    const existing=workspace.tabs.find(t=>t.templateId===id);
    if (existing) return activate(existing.id);
    const graph=JSON.parse(fs.readFileSync(template.path,'utf8').replace(/^\uFEFF/,''));
    return newTab(template.name,Store.validateGraph(graph),id);
  },
  activateTab: activate,
  duplicateTab: async()=>{await capture();const tab=active();if(!tab)throw new Error('请先打开工作流。');return newTab(`${tab.title} · 副本`,structuredClone(tab.graph));},
  closeTab: async id=>{
    const index=workspace.tabs.findIndex(t=>t.id===id);if(index<0)return {state:state(),snapshot:currentSnapshot()};
    return changeWorkspace(()=>{
      // Keep the latest copy on disk before removing its tab. Failed loads or
      // workspace writes restore membership and selection, leaving this backup.
      const archive=paths.closed;fs.mkdirSync(archive,{recursive:true});
      fs.writeFileSync(path.join(archive,`${id}.json`),JSON.stringify(workspace.tabs[index].graph,null,2));
      workspace.tabs.splice(index,1);
      if(workspace.activeId===id)workspace.activeId=workspace.tabs[Math.min(index,workspace.tabs.length-1)]?.id||null;
    });
  },
  importWorkflow: async()=>{
    const result=await dialog.showOpenDialog(window,{title:'导入 ComfyUI 工作流',properties:['openFile'],filters:[{name:'ComfyUI 工作流',extensions:['json']}]});
    if(result.canceled||!result.filePaths?.length)return {cancelled:true};
    const file=result.filePaths[0];if(fs.statSync(file).size>Store.MAX_GRAPH_BYTES)throw new Error('工作流文件过大。');
    return importText(fs.readFileSync(file,'utf8'),path.basename(file));
  },
  importText: async(text,name)=>importText(text,typeof name==='string'?name:'粘贴的工作流'),
  newBlank: async()=>newTab('空白节点画布',{last_node_id:0,last_link_id:0,nodes:[],links:[],groups:[],config:{},extra:{},version:0.4}),
  snapshot: async()=>({state:state(),snapshot:await capture()}),
  applyParameters: async (updates,tabId,expectedRevision)=>{
    if(tabId!==workspace.activeId)throw new Error('该参数来自另一个标签，请重新读取当前表单。');
    if(expectedRevision!==undefined&&expectedRevision!==active()?.revision)throw new Error('该标签已被修改（版本不一致），已拒绝写入，请刷新表单后重试。');
    if(!connected||!active()||loadedId!==workspace.activeId)throw new Error('请先重新连接并打开该工作副本。');
    if(!Array.isArray(updates)||updates.length>100)throw new Error('一次最多修改 100 个参数。');
    let result;
    try {result=await execute(Bridge.applyParametersSource({updates,expectedName:expectedName()}));}
    catch(error){if(error.needsSnapshot||error.code==='WORKFLOW_CHANGED'){await capture();persist();}throw error;}
    keepSnapshot(result,active());persist();
    return {state:state(),snapshot:result};
  },
  setMode: async mode=>{
    if(!['graph','parameters','app'].includes(mode)||!active())throw new Error('请先打开工作流。');
    await capture();
    if(connected)await execute(Bridge.setModeSource(mode==='parameters'?'graph':mode,expectedName()));
    active().mode=mode;currentView='editor';persist();layout();
    return {state:state(),snapshot:currentSnapshot()};
  },
  save: saveCurrent,
  exportWorkflow: async()=>{
    await capture();const tab=active();if(!tab)throw new Error('请先打开工作流。');
    const folder=paths.exports;fs.mkdirSync(folder,{recursive:true});
    const result=await dialog.showSaveDialog(window,{title:'导出工作流副本',defaultPath:path.join(folder,`${Store.safeName(tab.title)}.json`),filters:[{name:'ComfyUI 工作流',extensions:['json']}]});
    if(result.canceled||!result.filePath)return {cancelled:true};
    fs.writeFileSync(result.filePath,JSON.stringify(tab.graph,null,2),'utf8');
    return {state:state(),path:result.filePath,message:`工作流已保存：${result.filePath}`};
  },
  showPreview: async()=>{
    await capture();persist();currentView='preview';
    if(!previewView){
      const ses=session.fromPartition('persist:yingzuo-alpha-preview');
      if(!ses.protocol.isProtocolHandled('yingzuo'))ses.protocol.handle('yingzuo',serveResource);
      ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
      previewView=new WebContentsView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,session:ses}});
      window.contentView.addChildView(previewView);
      const view=previewView;
      const discard=()=>{if(previewView===view){window.contentView.removeChildView(view);previewView=null;currentView='editor';layout();}};
      protectView(view,url=>url.startsWith('yingzuo://app/'),()=>{discard();view.webContents.close();notify({error:'A 测预览进程已退出，可重新打开预览。'});});
      try {await view.webContents.loadURL('yingzuo://app/index.html');}
      catch(error){discard();view.webContents.close();throw error;}
    }
    layout();return {state:state()};
  },
  renameTab: async (id,title)=>{
    const tab=workspace.tabs.find(t=>t.id===id);if(!tab)throw new Error('找不到该工作副本。');
    if(typeof title!=='string'||!title.trim())throw new Error('名称不能为空。');
    await capture();tab.title=Store.safeName(title);persist();notify({});
    return {state:state(),snapshot:currentSnapshot()};
  },
  // E09：编译指定标签。后台标签先切换过去编译，再切回原标签；编译结果与当时的 UI 图、修订号一起返回。
  compileTab: async tabId=>{
    const id=tabId??workspace.activeId;const tab=workspace.tabs.find(t=>t.id===id);
    if(!tab)throw new Error('请先打开工作流。');
    if(!connected)throw new Error('ComfyUI 编辑器未连接，无法编译。');
    const previous=workspace.activeId;
    if(previous!==id)await activate(id);
    try{
      await capture();
      const result=await execute(Bridge.compileSource({expectedName:expectedName()}));
      if(!result?.ok)throw Object.assign(new Error(result?.error?.message??result?.message??'编译失败。'),{code:result?.error?.code??result?.code});
      return {tabId:id,title:tab.title,revision:tab.revision??0,uiGraph:result.workflow,apiPrompt:result.prompt};
    }finally{if(previous&&previous!==id&&workspace.tabs.some(t=>t.id===previous))await activate(previous).catch(()=>{});}
  },
  showEditor: async()=>{currentView='editor';layout();return {state:state(),snapshot:currentSnapshot()};},
};
return {
  commands,
  state, notify, enqueue, capture, saveCurrent, persist, layout, active, currentSnapshot, connect, disconnectEditor,
  attachWindow(w) { window = w; },
  setBounds(value) { bounds = Store.validateBounds(value, window.getContentSize()); layout(); },
  get workspace() { return workspace; },
  get startupError() { return startupError; },
  get connected() { return connected; },
  get autosaveQueued() { return autosaveQueued; }, set autosaveQueued(v) { autosaveQueued = v; },
  get quitting() { return quitting; }, set quitting(v) { quitting = v; },
  get persistedWorkspace() { return persistedWorkspace; },
  get lastSnapshot() { return lastSnapshot; },
  closeViews() { comfyView?.webContents.close(); previewView?.webContents.close(); },
  /** 弹窗遮罩期间隐藏原生视图（E10），避免盖住按钮。 */
  setOverlay(value) { overlay = !!value; layout(); },
};
}
module.exports = {createEditorSession};
