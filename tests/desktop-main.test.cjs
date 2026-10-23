'use strict';

// Runs the real main-process entry point with mocked Electron/bridge transports
// and actual temporary JSON files. These are not Windows or live ComfyUI UI tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Store = require('../desktop/workspace-store.cjs');
const source = fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const graph = prompt => ({version:0.4,nodes:[{id:1,type:'CLIPTextEncode',widgets_values:[prompt]}],links:[],extra:{}});
const tab = (id,prompt=id,mode='graph') => ({id,title:id,mode,templateId:null,graph:graph(prompt)});
const workspace = (...tabs) => ({version:1,activeId:tabs[0]?.id||null,tabs});
const tick = () => new Promise(resolve=>setImmediate(resolve));
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

async function fixture(t,initial=workspace(),options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yingzuo-main-'));
  const openedDbs=[],stopServices=[];
  let fixturePool=null;
  // 每个 main fixture 负责自己的服务生命周期；测试不触发关窗时也要释放 socket/计时器/worker。
  // Windows 上先关闭数据库再清理临时目录。
  t.after(async()=>{for(const stop of stopServices.reverse())await stop();await fixturePool?.close();for(const db of openedDbs){try{db.close();}catch{}}fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'desktop'),{recursive:true});
  fs.mkdirSync(path.join(root,'.local','data'),{recursive:true});
  if(options.objectInfo)fs.writeFileSync(path.join(root,'.local','data','object-info-cache.json'),JSON.stringify({data:options.objectInfo}));
  const file=path.join(root,'.local','data','workspace.json');
  // 测试关闭行为时不缩到托盘（mock 中也没有 Tray）。
  fs.writeFileSync(path.join(root,'.local','data','config.json'),JSON.stringify({version:1,tray:{closeToTray:false,showNotifications:false},lmstudio:{cli:''},updates:{checkFrequency:'manual'}}));
  if(options.rawWorkspace!==undefined)fs.writeFileSync(file,options.rawWorkspace);
  else if(initial)Store.writeWorkspace(file,initial);
  const comfyRoot=path.join(root,'comfy');
  fs.writeFileSync(path.join(root,'desktop','config.local.json'),JSON.stringify({comfyRoot,comfyUrl:'http://127.0.0.1:8188/'}));
  const state={root,file,views:[],windows:[],statuses:[],errors:[],calls:[],loads:[],intervals:[],timers:new Map(),partitions:new Map(),openResults:[],saveResults:[],quit:0,writeCount:0,nativeGraph:graph('native'),nativeName:null,transport:true};
  const snapshot=()=>({ok:true,graph:structuredClone(state.nativeGraph),nodes:[],connected:state.transport,workflow:{path:`workflows/${state.nativeName}`,documentId:`doc-${state.nativeName}`,hostName:state.nativeName}});
  const bridgeDefault=async (op,payload)=>{
    if(op==='capabilities')return {ok:true,connected:state.transport,loadGraph:true,snapshot:true,parameters:true,appMode:true};
    if(op==='load'){state.nativeName=payload.name;state.nativeGraph=structuredClone(payload.graph);return snapshot();}
    if(payload.expectedName!==undefined&&payload.expectedName!==state.nativeName)return {ok:false,error:{code:'WORKFLOW_CHANGED',message:'native workflow changed'}};
    if(op==='snapshot')return snapshot();
    if(op==='mode')return {ok:true,workflow:{mode:payload.mode}};
    if(op==='parameters'){state.nativeGraph.nodes[0].widgets_values[0]=payload.updates[0].value;return snapshot();}
    throw new Error(`Unexpected bridge operation ${op}`);
  };
  class Contents extends EventEmitter {
    constructor(){super();this.url='';this.destroyed=false;this.mainFrame={url:''};}
    isDestroyed(){return this.destroyed;}
    getURL(){return this.url;}
    setWindowOpenHandler(fn){this.openHandler=fn;}
    send(channel,value){if(channel==='yingzuo:event')(state.appEvents??=[]).push(plain(value));else state.statuses.push({channel,...plain(value)});}
    async loadURL(url){
      state.loads.push(url);this.emit('did-start-navigation',{url,isSameDocument:false,isMainFrame:true});this.url=url;this.mainFrame.url=url;
      if(state.loadHook)await state.loadHook(url,this);
    }
    async executeJavaScript(encoded){
      const {op,payload}=JSON.parse(encoded);state.calls.push({op,payload});
      return state.bridgeHook?state.bridgeHook(op,payload,bridgeDefault):bridgeDefault(op,payload);
    }
    close(){this.destroyed=true;}
    forcefullyCrashRenderer(){this.emit('render-process-gone',{}, {reason:'crashed'});}
  }
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.webContents=new Contents();this.children=[];this.contentView={addChildView:view=>this.children.push(view),removeChildView:view=>{this.children=this.children.filter(v=>v!==view);}};state.windows.push(this);}
    isDestroyed(){return !!this.destroyed;}
    getContentSize(){return [1400,900];}
    loadURL(url){return this.webContents.loadURL(url);}
    show(){} focus(){} isMinimized(){return false;} restore(){}
    minimize(){this.minimized=true;}
    maximize(){this.maximized=true;this.emit('maximize');}
    unmaximize(){this.maximized=false;this.emit('unmaximize');}
    isMaximized(){return !!this.maximized;}
    destroy(){this.destroyed=true;}
    close(){const event={preventDefault(){this.prevented=true;}};this.emit('close',event);if(!event.prevented)this.destroy();}
  }
  class View {
    constructor(options){this.options=options;this.webContents=new Contents();state.views.push(this);}
    setVisible(value){this.visible=value;}
    setBounds(value){this.bounds=value;}
  }
  const protocol=()=>({handlers:new Map(),handle(name,fn){this.handlers.set(name,fn);},isProtocolHandled(name){return this.handlers.has(name);},registerSchemesAsPrivileged(){}});
  const app=new EventEmitter();Object.assign(app,{isPackaged:false,getVersion:()=>'test',getPath:()=>root,setName(){},setPath(){},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit(){state.quit++;}});
  const handlers=new Map(),ipcMain=new EventEmitter();ipcMain.handle=(name,handler)=>handlers.set(name,handler);
  const electron={app,BrowserWindow:Window,WebContentsView:View,ipcMain,protocol:protocol(),net:{fetch:async url=>({url})},dialog:{
    showOpenDialog:async()=>state.openResults.shift()||{canceled:true,filePaths:[]},
    showSaveDialog:async()=>state.saveResults.shift()||{canceled:true},
    showErrorBox:(title,message)=>state.errors.push({title,message}),
    showMessageBox:async()=>({response:2})
  },shell:{openPath:async()=>''},safeStorage:options.safeStorage??{isEncryptionAvailable:()=>false},session:{fromPartition(name){if(!state.partitions.has(name)){const ses=new EventEmitter();Object.assign(ses,{protocol:protocol(),setPermissionRequestHandler(fn){this.permissionRequest=fn;},setPermissionCheckHandler(fn){this.permissionCheck=fn;}});state.partitions.set(name,ses);}return state.partitions.get(name);}}};
  const bridge={};
  for(const [name,op] of Object.entries({getCapabilitiesSource:'capabilities',loadGraphSource:'load',snapshotSource:'snapshot',applyParametersSource:'parameters'}))bridge[name]=(payload={})=>JSON.stringify({op,payload});
  bridge.setModeSource=(mode,expectedName)=>JSON.stringify({op:'mode',payload:{mode,expectedName}});
  const store={...Store,writeWorkspace(target,data,opts){state.writeCount++;if(state.writeHook)state.writeHook(target,data,state.writeCount);return Store.writeWorkspace(target,data,opts);}};
  const desktopDir=path.join(__dirname,'..','desktop');
  const realDb=require(path.join(desktopDir,'repositories','database.cjs'));
  const dbMock={...realDb,Database:{open:(...a)=>{const db=realDb.Database.open(...a);openedDbs.push(db);return db;}}};
  const realTasks=require(path.join(desktopDir,'services','task-service.cjs'));
  const realUpdates=require(path.join(desktopDir,'services','update-check.cjs'));
  const realApi=require(path.join(desktopDir,'services','api.cjs'));
  const realPool=require(path.join(desktopDir,'core','worker-pool.cjs'));
  const mocks={
    './repositories/database.cjs':dbMock,
    './services/task-service.cjs':{...realTasks,createTaskService(args){const service=realTasks.createTaskService({...args,WebSocketImpl:null});stopServices.push(()=>service.stop());return service;}},
    './services/update-check.cjs':{...realUpdates,createUpdateService(args){const service=realUpdates.createUpdateService(args);stopServices.push(()=>service.stopSchedule());return service;}},
    './services/api.cjs':{...realApi,createApi(args){
      // 保留真实 API/退出保护，仅隔离与本机安装和端口有关的后台探测/进程归属。
      const api=realApi.createApi({...args,comfy:{verifyOwned:async()=>false}});
      return {...api,start(){}};
    }},
    './core/worker-pool.cjs':{...realPool,
      configureShared(options){fixturePool=new realPool.WorkerPool({size:2,journalFile:options.journalFile});return new realPool.TempJournal(options.journalFile).recover();},
      sharedPool:()=>fixturePool,
      closeShared:async()=>{await fixturePool?.close();},
    },
  };
  const requireMock=name=>mocks[name]??(name==='electron'?electron:name==='./workspace-store.cjs'?store:name==='./comfy-bridge-source.cjs'?bridge:name.startsWith('./')?require(path.join(desktopDir,name)):require(name));
  vm.runInNewContext(source,{require:requireMock,__dirname:path.join(root,'desktop'),URL,Response,AbortSignal,structuredClone,fetch:async url=>state.fetchHook?state.fetchHook(url):({ok:true,json:async()=>({system:{},devices:[]})}),setTimeout(fn,ms){const id={};state.timers.set(id,{fn,ms});if(ms===500)queueMicrotask(()=>{if(state.timers.delete(id))fn();});return id;},clearTimeout:id=>state.timers.delete(id),setInterval(fn){state.intervals.push(fn);return {unref(){}};}},{filename:'desktop/main.cjs'});
  await tick();
  assert.equal(state.errors.length,0,'mock application starts successfully');
  state.window=state.windows[0];
  state.send=(method,...args)=>handlers.get('yingzuo:p0')({sender:state.window.webContents,senderFrame:state.window.webContents.mainFrame},{method,args}).then(plain);
  state.rawSend=(event,message)=>handlers.get('yingzuo:p0')(event,message).then(plain);
  state.bounds=value=>ipcMain.emit('yingzuo:p0-bounds',{sender:state.window.webContents,senderFrame:state.window.webContents.mainFrame},value);
  state.read=()=>Store.readWorkspace(file);
  state.editor=()=>state.views.find(view=>view.options.webPreferences.session===state.partitions.get('persist:yingzuo-p0-comfy'));
  state.snapshot=snapshot;state.bridgeDefault=bridgeDefault;
  return state;
}

async function connected(t,initial=workspace(tab('a'),tab('b'))) {
  const f=await fixture(t,initial);f.bounds({x:200,y:80,width:1200,height:800});
  assert.equal((await f.send('connect')).ok,true);return f;
}

test('startup restores drafts without connecting and rejects untrusted IPC senders',async t=>{
  const f=await fixture(t,workspace(tab('a','saved prompt')));
  const boot=await f.send('boot');assert.equal(boot.ok,true);assert.equal(boot.state.activeId,'a');assert.equal(boot.state.connected,false);assert.equal(f.views.length,0);
  for(const event of [{sender:{},senderFrame:f.window.webContents.mainFrame},{sender:f.window.webContents,senderFrame:{url:f.window.webContents.mainFrame.url}}])assert.equal((await f.rawSend(event,{method:'newBlank',args:[]})).ok,false);
  assert.equal((await f.send('constructor')).ok,false);assert.equal(f.read().tabs.length,1);
  const result=await f.send('connect');assert.equal(result.snapshot.graph.nodes[0].widgets_values[0],'saved prompt');assert.equal(f.read().tabs[0].documentId,'doc-yingzuo-a');
});

test('corrupt startup workspace remains byte-for-byte intact and blocks mutations',async t=>{
  const original='{"version":1,"tabs":[broken';const f=await fixture(t,null,{rawWorkspace:original});
  assert.ok((await f.send('boot')).state.startupError);
  assert.equal((await f.send('newBlank')).ok,false);assert.equal((await f.send('boot')).state.tabs.length,0);
  f.window.close();await tick();assert.equal(f.window.destroyed,true);assert.equal(fs.readFileSync(f.file,'utf8'),original);
});

test('native JSON import succeeds with BOM and Chinese name; cancel is a no-op',async t=>{
  const f=await connected(t);const file=path.join(f.root,'中文工作副本.json');fs.writeFileSync(file,'\uFEFF'+JSON.stringify(graph('导入提示词')));
  const before=fs.readFileSync(f.file,'utf8');f.openResults.push({canceled:true,filePaths:[]});assert.equal((await f.send('importWorkflow')).cancelled,true);assert.equal(fs.readFileSync(f.file,'utf8'),before);
  f.openResults.push({canceled:false,filePaths:[file]});const imported=await f.send('importWorkflow');assert.equal(imported.ok,true);assert.equal(imported.state.tabs.length,3);assert.equal(imported.state.tabs.at(-1).title,'中文工作副本');assert.equal(imported.snapshot.graph.nodes[0].widgets_values[0],'导入提示词');assert.equal(f.read().activeId,imported.state.activeId);assert.ok(fs.readFileSync(file,'utf8').startsWith('\uFEFF'));
});

test('invalid and oversized native imports preserve selection and existing drafts',async t=>{
  const f=await connected(t);const before=fs.readFileSync(f.file,'utf8');
  for(const [name,body] of [['invalid.json','{broken'],['api.json','{"prompt":{}}'],['large.json',' '.repeat(Store.MAX_GRAPH_BYTES+1)]]){
    const file=path.join(f.root,name);fs.writeFileSync(file,body);f.openResults.push({canceled:false,filePaths:[file]});const result=await f.send('importWorkflow');assert.equal(result.ok,false);assert.equal(result.state.activeId,'a');assert.equal(result.state.tabs.length,2);assert.equal(fs.readFileSync(f.file,'utf8'),before);
  }
});

test('rapid tab switches serialize and save each outgoing graph without stale parameter writes',async t=>{
  const f=await connected(t);const gate=deferred();let started=false;
  f.bridgeHook=async(op,payload,next)=>{if(op==='load'&&payload.name==='yingzuo-b'){started=true;await gate.promise;}return next(op,payload);};
  f.nativeGraph=graph('edited a');const first=f.send('activateTab','b');await tick();assert.equal(started,true);
  const second=f.send('activateTab','a');const stale=f.send('applyParameters',[{nodeId:1,widgetName:'text',value:'WRONG'}],'b');
  assert.equal(f.calls.filter(call=>call.op==='load').length,2);gate.resolve();
  const [one,two,rejected]=await Promise.all([first,second,stale]);assert.equal(one.state.activeId,'b');assert.equal(two.state.activeId,'a');assert.equal(rejected.ok,false);assert.match(rejected.error,/另一个标签/);assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'edited a');assert.equal(f.read().tabs[1].graph.nodes[0].widgets_values[0],'b');
});

test('failed tab load restores selection, hides uncertain editor and reconnects saved graph',async t=>{
  const f=await connected(t);f.nativeGraph=graph('latest a');
  f.bridgeHook=async(op,payload,next)=>{if(op==='load'&&payload.name==='yingzuo-b'){f.nativeGraph=graph('partially loaded');return {ok:false,error:{code:'LOAD_FAILED',message:'failed load'}};}return next(op,payload);};
  const failed=await f.send('activateTab','b');assert.equal(failed.ok,false);assert.equal(failed.state.activeId,'a');assert.equal(failed.state.connected,false);assert.equal(failed.snapshot,null);assert.equal(f.editor().visible,false);assert.equal(f.read().activeId,'a');assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'latest a');
  f.bridgeHook=null;const recovered=await f.send('connect');assert.equal(recovered.ok,true);assert.equal(recovered.snapshot.graph.nodes[0].widgets_values[0],'latest a');
});

test('closing active tab rolls back membership when replacement fails and preserves archive',async t=>{
  const f=await connected(t);f.nativeGraph=graph('latest a');f.bridgeHook=async(op,payload,next)=>op==='load'&&payload.name==='yingzuo-b'?{ok:false,error:{code:'LOAD_FAILED',message:'replacement failed'}}:next(op,payload);
  const result=await f.send('closeTab','a');assert.equal(result.ok,false);assert.deepEqual(result.state.tabs.map(tab=>tab.id),['a','b']);assert.equal(result.state.activeId,'a');assert.equal(result.state.connected,false);assert.equal(f.read().tabs.length,2);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'.local/data/closed-workflows/a.json'),'utf8')).nodes[0].widgets_values[0],'latest a');
  f.bridgeHook=null;assert.equal((await f.send('connect')).ok,true);const closed=await f.send('closeTab','a');assert.equal(closed.ok,true);assert.equal(closed.state.activeId,'b');assert.equal(closed.state.tabs.length,1);
});

test('failed final persistence rolls back close or create and keeps old workspace recoverable',async t=>{
  for(const method of ['closeTab','newBlank']){
    const f=await connected(t);const before=f.writeCount;
    f.writeHook=(_target,_data,count)=>{if(count===before+2)throw new Error('disk full');};
    const result=await f.send(method,...(method==='closeTab'?['a']:[]));assert.equal(result.ok,false);assert.equal(result.state.activeId,'a');assert.equal(result.state.tabs.length,2);assert.equal(result.state.connected,false);assert.equal(f.read().tabs.length,2);assert.equal(f.read().activeId,'a');
    f.writeHook=null;assert.equal((await f.send('connect')).ok,true);
  }
});

test('new tab failing native load is never left behind in memory or disk',async t=>{
  const f=await connected(t);f.bridgeHook=async(op,payload,next)=>op==='load'?{ok:false,error:{code:'LOAD_FAILED',message:'new failed'}}:next(op,payload);
  const result=await f.send('newBlank');assert.equal(result.ok,false);assert.equal(result.state.tabs.length,2);assert.equal(result.state.activeId,'a');assert.equal(f.read().tabs.length,2);
});

test('disconnected switching never exposes another tab snapshot or stale transport status',async t=>{
  const f=await connected(t);f.editor().webContents.emit('render-process-gone',{}, {reason:'crashed'});
  const switched=await f.send('activateTab','b');assert.equal(switched.ok,true);assert.equal(switched.snapshot,null);assert.equal(switched.state.connected,false);assert.equal(switched.state.transportConnected,false);assert.equal(switched.state.capabilities,null);assert.equal((await f.send('snapshot')).snapshot,null);assert.equal(f.read().activeId,'b');
});

test('crash or navigation invalidates a pending result even when bridge later resolves',async t=>{
  for(const event of ['render-process-gone','did-start-navigation']){
    const f=await connected(t);const gate=deferred();f.bridgeHook=async(op,payload,next)=>{const result=await next(op,payload);if(op==='snapshot')await gate.promise;return result;};
    f.nativeGraph=graph('late change');const pending=f.send('save');await tick();f.editor().webContents.emit(event,{},'http://127.0.0.1:8188/',false,true);gate.resolve();
    const result=await pending;assert.equal(result.ok,false);assert.equal(result.state.connected,false);assert.equal(result.snapshot,null);assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'a');
  }
});

test('bridge timeout stops renderer, rejects late mutation results and permits reconnect',async t=>{
  const f=await connected(t);const gate=deferred();f.bridgeHook=async(op,payload,next)=>op==='snapshot'?gate.promise:next(op,payload);
  const pending=f.send('save');await tick();const timer=[...f.timers.values()].find(timer=>timer.ms===30000);assert.ok(timer);timer.fn();
  const result=await pending;assert.equal(result.ok,false);assert.match(result.error,/超时/);assert.equal(result.snapshot,null);assert.equal(result.state.connected,false);
  gate.resolve(f.snapshot());f.bridgeHook=null;assert.equal((await f.send('connect')).ok,true);
});

test('A-test preview crash is isolated from editor and preview can be reopened',async t=>{
  const f=await connected(t);assert.equal((await f.send('showPreview')).ok,true);const preview=f.views.at(-1);preview.webContents.emit('render-process-gone',{}, {reason:'crashed'});
  const boot=await f.send('boot');assert.equal(boot.state.connected,true);assert.equal(boot.state.currentView,'editor');assert.equal(f.editor().visible,true);assert.equal(preview.webContents.destroyed,true);assert.equal((await f.send('showPreview')).ok,true);assert.notEqual(f.views.at(-1),preview);
});

test('preview load failure returns to editor without poisoning retries',async t=>{
  const f=await connected(t);f.loadHook=async url=>{if(url==='yingzuo://app/index.html')throw new Error('preview load failed');};
  const result=await f.send('showPreview');assert.equal(result.ok,false);assert.equal(result.state.currentView,'editor');assert.equal(result.state.connected,true);assert.equal(f.editor().visible,true);
  f.loadHook=null;assert.equal((await f.send('showPreview')).ok,true);
});

test('native workflow mismatch archives foreign graph without overwriting host draft',async t=>{
  const f=await connected(t);f.nativeName='foreign';f.nativeGraph=graph('foreign unsaved');const result=await f.send('save');assert.equal(result.ok,false);assert.equal(result.state.connected,false);assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'a');
  const files=fs.readdirSync(path.join(f.root,'.local/data/closed-workflows'));assert.equal(files.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'.local/data/closed-workflows',files[0]),'utf8')).nodes[0].widgets_values[0],'foreign unsaved');
});

test('native downloads use distinct paths, report completion only at done and handle failures',async t=>{
  const f=await connected(t);const ses=f.partitions.get('persist:yingzuo-p0-comfy');
  const item=()=>{const value=new EventEmitter();Object.assign(value,{getFilename:()=> '中文图像.png',setSavePath(target){this.target=target;},cancel(){this.cancelled=true;}});return value;};
  const first=item(),second=item();ses.emit('will-download',{},first);ses.emit('will-download',{},second);assert.notEqual(first.target,second.target);assert.equal(path.dirname(first.target),path.join(f.root,'.local/data/exports'));assert.equal(f.statuses.some(status=>status.download),false);
  fs.writeFileSync(first.target,'mock image bytes');first.emit('done',{},'completed');assert.equal(f.statuses.at(-1).download.status,'completed');assert.equal(fs.readFileSync(f.statuses.at(-1).download.path,'utf8'),'mock image bytes');
  second.emit('done',{},'interrupted');assert.match(f.statuses.at(-1).error,/interrupted/);
  const third=item();third.setSavePath=()=>{throw new Error('disk full');};assert.doesNotThrow(()=>ses.emit('will-download',{},third));assert.equal(third.cancelled,true);assert.match(f.statuses.at(-1).error,/disk full/);
});

test('window close waits for save and refuses to exit on a write failure',async t=>{
  const f=await connected(t);f.nativeGraph=graph('last edit');f.writeHook=()=>{throw new Error('read-only disk');};f.window.close();await tick();assert.equal(f.window.destroyed,undefined);assert.equal(f.quit,0);assert.match(f.errors.at(-1).message,/read-only disk/);
  f.writeHook=null;f.window.close();await tick();assert.equal(f.window.destroyed,true);assert.equal(f.quit,1);assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'last edit');assert.equal(f.editor().webContents.destroyed,true);
});

test('failed foreign archive keeps graph recoverable and blocks reconnect and exit until durable',async t=>{
  const f=await connected(t);const archive=path.join(f.root,'.local/data/closed-workflows');fs.rmSync(archive,{recursive:true,force:true});fs.writeFileSync(archive,'blocks directory creation');
  f.nativeName='foreign';f.nativeGraph=graph('foreign unsaved');const failed=await f.send('save');assert.equal(failed.ok,false);assert.equal(failed.state.recoveryPending,true);assert.equal(failed.state.connected,false);assert.equal(f.editor().visible,true);assert.equal(failed.snapshot,null);
  const loads=f.loads.length;assert.equal((await f.send('connect')).ok,false);assert.equal(f.loads.length,loads);assert.equal(f.nativeGraph.nodes[0].widgets_values[0],'foreign unsaved');
  f.window.close();await tick();assert.equal(f.window.destroyed,undefined);assert.equal(f.quit,0);assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'a');
  // Even if the native renderer later exits, the captured foreign graph survives.
  f.editor().webContents.emit('render-process-gone',{}, {reason:'crashed'});fs.unlinkSync(archive);
  const recovered=await f.send('connect');assert.equal(recovered.ok,true);assert.equal(recovered.state.recoveryPending,false);assert.equal(recovered.snapshot.graph.nodes[0].widgets_values[0],'a');
  const files=fs.readdirSync(archive);assert.equal(files.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(archive,files[0]),'utf8')).nodes[0].widgets_values[0],'foreign unsaved');
});

test('autosave retries a failed write even when the captured graph no longer changes',async t=>{
  const f=await connected(t);f.nativeGraph=graph('must retry unchanged');f.writeHook=()=>{throw new Error('temporary write failure');};
  f.intervals[0]();await tick();assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'a');assert.match(f.statuses.at(-1).error,/自动保存失败/);
  f.writeHook=null;f.intervals[0]();await tick();assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'must retry unchanged');assert.match(f.statuses.at(-1).message,/自动保存/);
  const writes=f.writeCount;f.intervals[0]();await tick();assert.equal(f.writeCount,writes,'unchanged durable workspaces do not cause unnecessary writes');
});

test('repeated close requests cannot destroy the window while its save is pending',async t=>{
  const f=await connected(t);f.nativeGraph=graph('last pending edit');const gate=deferred();f.bridgeHook=async(op,payload,next)=>{if(op==='snapshot')await gate.promise;return next(op,payload);};
  f.window.close();await tick();f.window.close();assert.equal(f.window.destroyed,undefined);assert.equal(f.quit,0);assert.equal((await f.send('newBlank')).ok,false);
  gate.resolve();await tick();assert.equal(f.window.destroyed,true);assert.equal(f.quit,1);assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'last pending edit');
});

test('modern navigation details invalidate document reloads but preserve same-document navigation',async t=>{
  const f=await connected(t);const contents=f.editor().webContents;
  contents.emit('did-start-navigation',{url:'http://127.0.0.1:8188/#canvas',isSameDocument:true,isMainFrame:true});assert.equal((await f.send('boot')).state.connected,true);
  contents.emit('did-start-navigation',{url:'http://127.0.0.1:8188/',isSameDocument:false,isMainFrame:false});assert.equal((await f.send('boot')).state.connected,true);
  contents.emit('did-start-navigation',{url:'http://127.0.0.1:8188/',isSameDocument:false,isMainFrame:true});assert.equal((await f.send('boot')).state.connected,false);
  const event={url:'https://example.com',preventDefault(){this.prevented=true;}};contents.emit('will-navigate',event);assert.equal(event.prevented,true);
});

test('foreign recovery retries also archive edits made while the disk was unavailable',async t=>{
  const f=await connected(t);const archive=path.join(f.root,'.local/data/closed-workflows');fs.rmSync(archive,{recursive:true,force:true});fs.writeFileSync(archive,'blocks recovery');
  f.nativeName='foreign';f.nativeGraph=graph('first foreign edit');assert.equal((await f.send('save')).ok,false);
  f.nativeGraph=graph('newer foreign edit');fs.unlinkSync(archive);assert.equal((await f.send('connect')).ok,true);
  const prompts=fs.readdirSync(archive).map(file=>JSON.parse(fs.readFileSync(path.join(archive,file),'utf8')).nodes[0].widgets_values[0]).sort();assert.deepEqual(prompts,['first foreign edit','newer foreign edit']);assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0],'a');
});

test('E10：原生视图快捷键映射', () => {
  const {shortcutFor} = require('../desktop/services/editor-session.cjs');
  assert.equal(shortcutFor({type: 'keyDown', control: true, key: 'Enter'}), 'run');
  assert.equal(shortcutFor({type: 'keyDown', meta: true, key: '='}), 'in');
  assert.equal(shortcutFor({type: 'keyDown', control: true, key: '-'}), 'out');
  assert.equal(shortcutFor({type: 'keyDown', control: true, key: '0'}), 'reset');
  assert.equal(shortcutFor({type: 'keyUp', control: true, key: 'Enter'}), null);
  assert.equal(shortcutFor({type: 'keyDown', key: 'Enter'}), null);
  assert.equal(shortcutFor({type: 'keyDown', control: true, alt: true, key: '0'}), null);
});

test('B03：打包自检在临时目录运行并写出结果', async () => {
  const os = require('node:os');
  const {smokeTarget, runSmoke} = require('../desktop/smoke.cjs');
  assert.equal(smokeTarget(['x', '--yz-smoke=C:\\t\\r.json']), 'C:\\t\\r.json');
  assert.equal(smokeTarget(['x']), null);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yz-sm-')), 'r.json');
  await runSmoke(out, {app: {getVersion: () => '0.0.0-test'}});
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const name of ['versions', 'sqlite', 'modules', 'workbench']) assert.equal(r.checks.find(c => c.name === name).ok, true, JSON.stringify(r.checks));
  fs.rmSync(path.dirname(out), {recursive: true, force: true});
});

/* ---------- C01：草稿、关闭归档、普通导出走统一敏感字段政策（虚构密钥） ---------- */
const FAKE_KEY='sk-test-FICTIONALKEY0123456789';
const KEY_INFO={LMStudioPromptEnhancer:{input:{required:{prompt:['STRING'],lmstudio_api_key:['STRING',{password:true}]}}}};
const fakeSafe=()=>({isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>'dpapi',encryptString:s=>Buffer.from(`enc:${s}`),decryptString:b=>b.toString().slice(4)});
const keyGraph=prompt=>({version:0.4,nodes:[{id:1,type:'CLIPTextEncode',widgets_values:[prompt]},{id:2,type:'LMStudioPromptEnhancer',inputs:[{name:'lmstudio_api_key',type:'STRING',widget:{name:'lmstudio_api_key'}}],widgets_values:['帮我润色',FAKE_KEY]}],links:[],extra:{},definitions:{subgraphs:[{id:'sg1',nodes:[{id:9,type:'Custom',widgets_values:{api_key:FAKE_KEY,steps:20}}]}]}});
test('C01：首次输入的密钥——自动保存/关闭归档只存凭据引用，内存与画布保留真实值，普通导出移除并列出需重填字段',async t=>{
  const f=await fixture(t,workspace({id:'a',title:'a',mode:'graph',templateId:null,graph:keyGraph('提示词A')},{id:'b',title:'b',mode:'graph',templateId:null,graph:keyGraph('提示词B')}),{safeStorage:fakeSafe(),objectInfo:KEY_INFO});
  const drafts=path.join(f.root,'.local','data','drafts');
  for(const n of fs.readdirSync(drafts)){const text=fs.readFileSync(path.join(drafts,n),'utf8');assert.ok(!text.includes(FAKE_KEY),`草稿 ${n} 不含明文（启动迁移）`);assert.ok(text.includes('__yz_credential__:node-secret:'));assert.ok(text.includes('提示词'),'普通提示词保留');}
  f.bounds({x:200,y:80,width:1200,height:800});
  const c=await f.send('connect');assert.equal(c.ok,true);
  assert.equal(c.snapshot.graph.nodes[1].widgets_values[1],FAKE_KEY,'载入时在内存还原');
  assert.ok(!fs.readFileSync(path.join(f.root,'.local','data','credentials.json'),'utf8').includes(FAKE_KEY),'凭据文件只存密文');
  const out=path.join(f.root,'export.json');f.saveResults.push({canceled:false,filePath:out});
  const ex=await f.send('exportWorkflow');assert.equal(ex.ok,true);
  const text=fs.readFileSync(out,'utf8');assert.ok(!text.includes(FAKE_KEY));assert.ok(!text.includes('__yz_credential__'),'不带本机凭据标识');assert.ok(text.includes('提示词A'));
  assert.ok(ex.refill.length>=2,'列出需要重新填写的字段');
  assert.equal((await f.send('closeTab','a')).ok,true);
  const archived=fs.readFileSync(path.join(f.root,'.local','data','closed-workflows','a.json'),'utf8');assert.ok(!archived.includes(FAKE_KEY));assert.ok(archived.includes('__yz_credential__:node-secret:'));
});
test('C01：系统加密存储不可用——保存返回可操作错误，不明文落盘，旧草稿不被覆盖',async t=>{
  const f=await fixture(t,workspace(tab('a','x')),{objectInfo:KEY_INFO});
  f.bounds({x:200,y:80,width:1200,height:800});assert.equal((await f.send('connect')).ok,true);
  f.nativeGraph=keyGraph('新提示词');
  const r=await f.send('save');assert.equal(r.ok,false);assert.match(r.error,/加密存储不可用/);
  const drafts=path.join(f.root,'.local','data','drafts');for(const n of fs.readdirSync(drafts))assert.ok(!fs.readFileSync(path.join(drafts,n),'utf8').includes(FAKE_KEY));
});

test('C06：独立副本保留模板与固定表单版本绑定',async t=>{
  const f=await connected(t,workspace({id:'a',title:'a',mode:'graph',templateId:'tpl_1',templateVersionId:'ver_1',graph:graph('x')}));
  const r=await f.send('duplicateTab');assert.equal(r.ok,true);
  const copy=r.state.tabs.find(x=>x.id===r.state.activeId);assert.notEqual(copy.id,'a');
  assert.equal(copy.templateId,'tpl_1');assert.equal(copy.templateVersionId,'ver_1');
});
