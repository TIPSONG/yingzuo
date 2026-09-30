'use strict';
const {app, BrowserWindow, WebContentsView, ipcMain, protocol, net, dialog, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {randomUUID} = require('node:crypto');
const Store = require('./workspace-store.cjs');
const Bridge = require('./comfy-bridge-source.cjs');
const ROOT = path.resolve(__dirname, '..');
const LOCAL = path.join(ROOT, '.local');
const log = message => {
  try { fs.appendFileSync(path.join(LOCAL,'desktop-events.log'),`${new Date().toISOString()} ${message}\n`); }
  catch { /* Diagnostic logging must not block draft recovery or export. */ }
};
const WORKSPACE_FILE = path.join(LOCAL, 'desktop-workspace.json');
const WORKBENCH = 'yingzuo://app/desktop/workbench.html';
const TEMPLATE_NAMES = [
  ['text','文生图','Qwen 2.1 Q6_K - Text to Image.json'],
  ['edit','多图参考编辑','Qwen 2.1 Q6_K - Multi Image Edit.json'],
  ['gemma-text','Gemma 润色 · 文生图','Qwen 2.1 Q6_K + Gemma - Text to Image.json'],
  ['gemma-edit','Gemma 润色 · 多图编辑','Qwen 2.1 Q6_K + Gemma - Multi Image Edit.json'],
  ['prompt','单独润色提示词','Gemma 4 - Prompt Enhancer.json'],
];
fs.mkdirSync(LOCAL, {recursive:true});
app.setName('映作 P0');
app.setPath('userData', path.join(LOCAL, 'electron-profile'));
protocol.registerSchemesAsPrivileged([{scheme:'yingzuo',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
let config = {comfyRoot:'D:/agent/ComfyUI', comfyUrl:'http://127.0.0.1:8188/'};
const configFile = path.join(__dirname, 'config.local.json');
if (fs.existsSync(configFile)) config = {...config,...JSON.parse(fs.readFileSync(configFile,'utf8'))};
const comfyUrl = new URL(config.comfyUrl);
if (comfyUrl.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(comfyUrl.hostname) || comfyUrl.username || comfyUrl.password || comfyUrl.pathname !== '/') throw new Error('P0 仅支持固定的本机 ComfyUI 根地址。');
config.comfyRoot = path.resolve(config.comfyRoot);
const templates = TEMPLATE_NAMES.map(([id,name,file]) => ({id,name,file,path:path.join(config.comfyRoot,'user','default','workflows',file)}));
let workspace, startupError = null;
try { workspace = Store.readWorkspace(WORKSPACE_FILE); }
catch (error) { startupError = error.message; workspace = Store.emptyWorkspace(); }
let window, comfyView, previewView, bounds, currentView = 'editor', loadedId = null, connected = false;
let connecting = null, lastSnapshot = null, capabilities = null, autosaveQueued = false, quitting = false;
let editorGeneration = 0, editorCrashed = false, recoveryPending = false, pendingForeignGraph = null, foreignRecoveryPath = null;
let persistedWorkspace = JSON.stringify(workspace);
let commandTail = Promise.resolve();
const enqueue = operation => { const task = commandTail.then(operation); commandTail = task.catch(()=>{}); return task; };
const active = () => workspace.tabs.find(tab => tab.id === workspace.activeId);
const expectedName = () => active() ? `yingzuo-${active().id}` : undefined;
const currentSnapshot = () => connected && loadedId === workspace.activeId ? lastSnapshot : null;
const state = () => ({tabs:workspace.tabs.map(({id,title,templateId,mode})=>({id,title,templateId,mode})), activeId:workspace.activeId, connected, transportConnected:connected && (currentSnapshot()?.connected??capabilities?.connected??false), currentView, capabilities, recoveryPending, startupError, savedPath:WORKSPACE_FILE, comfyUrl:comfyUrl.href});
const notify = data => { if (window && !window.isDestroyed()) window.webContents.send('yingzuo:p0-status', {...state(),snapshot:currentSnapshot(),...data}); };
function persist() { if (startupError) throw new Error('旧工作区读取失败，已保留原文件。请先检查后再保存新草稿。'); Store.writeWorkspace(WORKSPACE_FILE,workspace);persistedWorkspace=JSON.stringify(workspace); }
function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== WORKBENCH) throw new Error('拒绝未知页面请求。');
}
function layout() {
  if (!window || !bounds) return;
  const rect = Store.validateBounds(bounds,window.getContentSize());
  const hasArea = rect.width > 0 && rect.height > 0;
  comfyView?.setBounds(rect); previewView?.setBounds(rect);
  comfyView?.setVisible(hasArea && currentView === 'editor' && (recoveryPending || connected && !!active() && active().mode !== 'parameters'));
  previewView?.setVisible(hasArea && currentView === 'preview');
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
      const folder = path.join(LOCAL,'exports'); fs.mkdirSync(folder,{recursive:true});
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
  Store.validateGraph(result.graph);
  tab.graph = result.graph;
  tab.workflowPath = result.workflow?.path;
  tab.documentId = result.workflow?.documentId;
  lastSnapshot = result;
}
async function recoverForeignGraph() {
  if (!recoveryPending) return;
  try {
    const archive=graph=>{
      const folder=path.join(LOCAL,'closed-workflows');fs.mkdirSync(folder,{recursive:true});
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
  const result = await execute(Bridge.loadGraphSource({graph:tab.graph,name:`yingzuo-${tab.id}`,workflowPath:tab.workflowPath,documentId:tab.documentId}));
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
const commands = {
  boot: async()=>({state:state(),templates:templates.map(t=>({id:t.id,name:t.name,available:fs.existsSync(t.path)}))}),
  connect,
  openTemplate: async id=>{
    const template=templates.find(t=>t.id===id);
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
      const archive=path.join(LOCAL,'closed-workflows');fs.mkdirSync(archive,{recursive:true});
      fs.writeFileSync(path.join(archive,`${id}.json`),JSON.stringify(workspace.tabs[index].graph,null,2));
      workspace.tabs.splice(index,1);
      if(workspace.activeId===id)workspace.activeId=workspace.tabs[Math.min(index,workspace.tabs.length-1)]?.id||null;
    });
  },
  importWorkflow: async()=>{
    const result=await dialog.showOpenDialog(window,{title:'导入 ComfyUI 工作流',properties:['openFile'],filters:[{name:'ComfyUI 工作流',extensions:['json']}]});
    if(result.canceled||!result.filePaths?.length)return {cancelled:true};
    const file=result.filePaths[0];if(fs.statSync(file).size>Store.MAX_GRAPH_BYTES)throw new Error('工作流文件过大。');
    const graph=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    return newTab(path.basename(file,'.json'),Store.validateGraph(graph));
  },
  newBlank: async()=>newTab('空白节点画布',{last_node_id:0,last_link_id:0,nodes:[],links:[],groups:[],config:{},extra:{},version:0.4}),
  snapshot: async()=>({state:state(),snapshot:await capture()}),
  applyParameters: async (updates,tabId)=>{
    if(tabId!==workspace.activeId)throw new Error('该参数来自另一个标签，请重新读取当前表单。');
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
    const folder=path.join(LOCAL,'exports');fs.mkdirSync(folder,{recursive:true});
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
  showEditor: async()=>{currentView='editor';layout();return {state:state(),snapshot:currentSnapshot()};},
};

function serveResource(request) {
  const url=new URL(request.url);
  let file;
  try{file=path.resolve(ROOT,'.'+decodeURIComponent(url.pathname));}catch{return new Response('',{status:400});}
  const relative=path.relative(ROOT,file);
  if(url.host!=='app'||relative.startsWith('..')||path.isAbsolute(relative)||relative.split(path.sep).some(x=>x.startsWith('.'))||!['.html','.js','.css','.svg','.png'].includes(path.extname(file))||!fs.existsSync(file)||!fs.statSync(file).isFile())return new Response('',{status:404});
  return net.fetch(pathToFileURL(file).href);
}
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(async()=>{
    protocol.handle('yingzuo',serveResource);
    window=new BrowserWindow({width:1500,height:980,minWidth:1050,minHeight:700,backgroundColor:'#131514',title:'映作 · 桌面接入验证 P0',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if((event.url??url)!==WORKBENCH)event.preventDefault();});
    ipcMain.handle('yingzuo:p0',async(event,message)=>{
      try {assertSender(event);if(quitting)throw new Error('正在保存并退出，请稍候。');if(!message||!Object.hasOwn(commands,message.method)||typeof commands[message.method]!=='function'||!Array.isArray(message.args))throw new Error('未知桌面操作。');log(`begin ${message.method}`);const result=await enqueue(()=>commands[message.method](...message.args));log(`done ${message.method}`);return {ok:true,...result};}
      catch(error){log(`failed ${message?.method}: ${error.message}`);return {ok:false,error:error.message,state:state(),snapshot:currentSnapshot()};}
    });
    ipcMain.on('yingzuo:p0-bounds',(event,value)=>{try{assertSender(event);bounds=Store.validateBounds(value,window.getContentSize());layout();}catch{}});
    window.on('resize',layout);
    window.on('close',event=>{
      event.preventDefault();if(quitting)return;quitting=true;
      enqueue(async()=>{if(startupError){await capture();if(workspace.tabs.length)Store.writeWorkspace(path.join(LOCAL,`recovered-workspace-${Date.now()}.json`),workspace);}else await saveCurrent();}).then(()=>{comfyView?.webContents.close();previewView?.webContents.close();window.destroy();app.quit();}).catch(error=>{quitting=false;notify({error:`保存未完成，窗口已保留：${error.message}`});dialog.showErrorBox('草稿尚未保存',`${error.message}\n窗口已保留，请重试保存或导出工作流后再退出。`);});
    });
    await window.loadURL(WORKBENCH);
    window.show();window.focus();
    const timer=setInterval(()=>{
      if(autosaveQueued||!connected||!active()||quitting)return;
      autosaveQueued=true;enqueue(async()=>{if(!active())return;const transport=currentSnapshot()?.connected;await capture();if(persistedWorkspace!==JSON.stringify(workspace)){persist();notify({message:'草稿已自动保存。'});}else if(transport!==lastSnapshot?.connected)notify({message:lastSnapshot?.connected?'WebSocket 已重新连接。':'WebSocket 已断开，当前画布和草稿仍保留。'});}).catch(error=>notify({error:`自动保存失败：${error.message}`})).finally(()=>autosaveQueued=false);
    },2500);timer.unref();
  }).catch(error=>{dialog.showErrorBox('映作启动失败',error.message);app.quit();});
  app.on('window-all-closed',()=>app.quit());
}
