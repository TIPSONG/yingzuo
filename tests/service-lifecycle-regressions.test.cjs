'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LmStudioAdapter} = require('../desktop/services/lmstudio.cjs');
const {ComfyProcessManager} = require('../desktop/services/comfy-process.cjs');
const {createApi} = require('../desktop/services/api.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {defaults} = require('../desktop/repositories/config-repo.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
function temporary(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yz-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
function lmFixture(t) {
  const calls=[],state={helpCode:0,ps:[]};
  const opts={cliPath:'/test/lms',registryFile:path.join(temporary(t),'lm.json'),session:'current',exists:()=>true,runImpl:async(_,args)=>{
    calls.push(args);return {code:args[0]==='--help'?state.helpCode:0,stdout:args[0]==='--help'?'Commands:\n  server\n  ps\n  unload\n':args[0]==='ps'?JSON.stringify(state.ps):'',stderr:''};
  }};
  return {lm:new LmStudioAdapter(opts),opts,calls,state};
}
test('LM ownership binds session, CLI and exact port without discarding the original managed endpoint',async t=>{
  const {lm,opts,calls}=lmFixture(t);await lm.detect();await lm.startServer({apiReachable:false,port:1234,waitReady:async()=>true});
  assert.equal(lm.isServerOwned({port:1234}),true);
  assert.deepEqual(await lm.startServer({apiReachable:true,port:1234}),{ownership:'owned',started:false});
  await assert.rejects(lm.stopServer({port:4321}),e=>e.code==='NOT_OWNED');
  assert.equal(lm.isServerOwned({port:1234}),true,'wrong endpoint must not erase the valid record');
  for(const change of [{session:'new-session'},{cliPath:'/another/lms'}]) {
    const other=new LmStudioAdapter({...opts,...change});
    assert.equal(other.isServerOwned({port:1234}),false);await assert.rejects(other.stopServer({port:1234}),e=>e.code==='NOT_OWNED');
  }
  assert.ok(!calls.some(a=>a.join(' ')==='server stop'));await lm.stopServer({port:1234});
  assert.equal(calls.filter(a=>a.join(' ')==='server stop').length,1);
});
test('LM CLI failures and unknown model-list schemas do not masquerade as available or empty',async t=>{
  const {lm,state}=lmFixture(t);assert.equal((await lm.detect()).available,true);
  state.helpCode=1;assert.equal((await lm.detect()).available,false);assert.equal(lm.caps,null);
  state.helpCode=0;await lm.detect();
  for(const ps of [{unexpected:[]},{models:{}},[null],[{other:'unknown'}]]) {state.ps=ps;await assert.rejects(lm.listLoaded(),e=>e.code==='UNSUPPORTED');}
  state.ps=[{identifier:'chat',contextLength:8192}];assert.equal((await lm.listLoaded())[0].identifier,'chat');
});
test('loaded model ownership from an earlier app session never authorizes unloading',async t=>{
  const {lm,calls,state}=lmFixture(t);await lm.detect();
  lm.saveRegistry({session:'old',cliPath:lm.cliPath,ownedInstances:['chat']});state.ps=[{identifier:'chat'}];
  assert.equal((await lm.listLoaded())[0].owned,false);await assert.rejects(lm.unloadOwned('chat'),e=>e.code==='NOT_OWNED');assert.ok(!calls.some(a=>a[0]==='unload'));
  await lm.startServer({apiReachable:false,port:1234,waitReady:async()=>true});
  assert.equal((await lm.listLoaded())[0].owned,false,'starting a new API does not acquire old model instances');
  await assert.rejects(lm.unloadOwned('chat'),e=>e.code==='NOT_OWNED');assert.ok(!calls.some(a=>a[0]==='unload'));
});
function apiFixture(t) {
  const dir=temporary(t),layout=ensureLayout(dir),config=defaults(),locks=createLocks(),calls=[],leases=[];
  const state={active:[],lmReady:false,lmOwned:true,comfy:{summary:'offline',port:{code:'ECONNREFUSED'}},queue:{queue_running:[],queue_pending:[]}};
  const lm={detect:async()=>({available:true}),isServerOwned:()=>state.lmOwned,registry:()=>({serverOwned:true}),startServer:async o=>{
    calls.push(['lm-start',o.apiReachable]);state.lmReady=true;return {started:!o.apiReachable,ownership:o.apiReachable?'external':'owned'};
  },stopServer:async()=>{calls.push(['lm-stop']);state.lmReady=false;return {stopped:true};}};
  const api=createApi({electron:{safeStorage:{isEncryptionAvailable:()=>false},shell:{},dialog:{}},app:{},layout,dataRoot:{root:dir},
    configRepo:{config,derived:()=>({}),snapshot:()=>({config})},logger:{info(){},warn(){},error(){},tail:()=>[]},events:{emit(){}},locks,
    editor:{connected:false},getWindow:()=>null,root:dir,comfy:{verifyOwned:async()=>true,stop:async()=>{calls.push(['comfy-stop']);},logTail:()=>[]},
    lmFactory:()=>lm,probeComfy:async()=>state.comfy,probeLmStudio:async()=>({api:{ok:state.lmReady},models:[],summary:state.lmReady?'api-ready':'offline'}),
    fetch:async()=>new Response(JSON.stringify(state.queue)),taskService:{hooks:{activeTasks:()=>state.active,waitForIdle:async()=>{},pauseSubmissions:n=>{leases.push('+'+n);return()=>leases.push('-'+n);}},tasks:{byPromptId:()=>({state:'succeeded'})}}});
  return {api,state,calls,leases,locks,config};
}
test('LM start rechecks the API instead of trusting either stale online or stale offline status',async t=>{
  for(const initial of [false,true]){
    const f=apiFixture(t);f.state.lmReady=initial;await f.api.serviceStatus();f.state.lmReady=!initial;
    const result=await f.api.methods['services.startLmServer']();assert.equal(result.started,initial);assert.deepEqual(f.calls,[['lm-start',!initial]]);
    assert.deepEqual(f.leases,['+start-lm-server','-start-lm-server']);assert.equal(f.locks.environment.locked,false);
  }
});
test('LM lifecycle honors maintenance locks, active work and disabled service management',async t=>{
  const f=apiFixture(t),release=f.locks.environment.tryAcquire('maintenance');
  for(const method of ['startLmServer','stopLmServer'])await assert.rejects(f.api.methods['services.'+method](),e=>e.code==='LOCKED');
  release();f.state.active=[{id:'polishing'}];await assert.rejects(f.api.methods['services.stopLmServer'](),e=>e.code==='INVALID_STATE');
  f.state.active=[];f.config.lmstudio.manageServer=false;await assert.rejects(f.api.methods['services.startLmServer'](),e=>e.code==='INVALID_STATE');assert.deepEqual(f.calls,[]);
});
test('LM stop and exit retain the API while Comfy queue is busy, malformed, or unconfirmed',async t=>{
  const f=apiFixture(t);
  for(const [comfy,queue] of [
    [{summary:'ready'},{queue_running:[[1,'external']],queue_pending:[]}],
    [{summary:'ready'},{status:'unknown'}],
    [{summary:'offline',port:{code:'TIMEOUT'}},{queue_running:[],queue_pending:[]}],
  ]){
    f.state.comfy=comfy;f.state.queue=queue;
    await assert.rejects(f.api.methods['services.stopLmServer'](),e=>e.code==='INVALID_STATE');
    await f.api.shutdownOwnedServices();assert.ok(!f.calls.some(c=>c[0]==='lm-stop'));
  }
  f.state.comfy={summary:'offline',port:{code:'ECONNREFUSED'}};await f.api.methods['services.stopLmServer']();
  assert.equal(f.calls.filter(c=>c[0]==='lm-stop').length,1);assert.equal(f.locks.environment.locked,false);
});
test('service UI never labels a stale registry or unreachable LM API as currently owned',async t=>{
  const f=apiFixture(t);f.state.lmReady=true;f.state.lmOwned=false;
  assert.equal((await f.api.serviceStatus()).lmstudio.serverOwnership,'external');
  f.state.lmReady=false;f.state.lmOwned=true;assert.equal((await f.api.serviceStatus()).lmstudio.serverOwnership,null);
});
test('destructive Comfy operations reject malformed queues and known IDs still present in the backend',async t=>{
  const f=apiFixture(t);
  for(const q of [{queue_running:[],queue_pending:[[1,'known-terminal']]},{},{queue_running:[{}],queue_pending:[]}]){
    f.state.queue=q;await assert.rejects(f.api.methods['services.stopComfy'](),e=>e.code==='INVALID_STATE');
  }
  assert.deepEqual(f.calls,[]);
});
test('Comfy command strips separate reserved argument values and uses the configured URL default port',t=>{
  const dir=temporary(t),py=path.join(dir,'python');fs.writeFileSync(py,'');fs.writeFileSync(path.join(dir,'main.py'),'');
  const m=new ComfyProcessManager({registryFile:path.join(dir,'services.json'),logsDir:dir}),config=defaults();
  Object.assign(config.comfy,{root:dir,python:py,url:'http://127.0.0.1/',extraArgs:['--port','9999','--listen','0.0.0.0','--lowvram','--listen=::','--port=1234']});
  assert.deepEqual(m.buildCommand(config).args.slice(1),['--listen','127.0.0.1','--port','80','--lowvram']);
});
test('Comfy ownership is bound to configured endpoint and installation before stopping',async t=>{
  const dir=temporary(t),kills=[];
  const m=new ComfyProcessManager({registryFile:path.join(dir,'services.json'),logsDir:dir,platform:'linux',aliveImpl:()=>true,identityImpl:async()=>({executable:'/a/py',startTime:'1'}),killImpl:async()=>{kills.push('kill');return true;}});
  m.writeRegistry({services:{comfy:{pid:123,executable:'/a/py',configuredExecutable:'/a/py',startTime:'1',cwd:'/a',url:'http://127.0.0.1:8188/'}}});
  assert.equal(await m.verifyOwned({url:'http://127.0.0.1:8188/',root:'/a',python:'/a/py'}),true);
  for(const expected of [{url:'http://127.0.0.1:8189/'},{root:'/b'},{python:'/b/py'}]){assert.equal(await m.verifyOwned(expected),false);await assert.rejects(m.stop(expected),e=>e.code==='NOT_OWNED');}
  assert.deepEqual(kills,[]);assert.equal(m.record.pid,123);
});
