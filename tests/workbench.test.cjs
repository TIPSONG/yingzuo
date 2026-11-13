'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual renderer script with a minimal DOM and controllable IPC.
// These tests cover coordination logic, not native Electron or ComfyUI UI acceptance.
const source = fs.readFileSync(path.join(__dirname,'../desktop/workbench.js'),'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function element(dataset={}) {
  const listeners = new Map(), classes = new Set();
  let html = '', writes = 0;
  return {
    dataset, disabled:false, inert:false, hidden:false, textContent:'',
    get innerHTML(){return html;}, set innerHTML(value){html=value;writes++;},
    get writes(){return writes;},
    classList:{toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);},contains(name){return classes.has(name);}},
    addEventListener(name,callback){listeners.set(name,callback);},
    dispatch(name,event){return listeners.get(name)?.(event);},
    getBoundingClientRect(){return {x:0,y:0,width:1000,height:700};},
  };
}
const state = (activeId='a', overrides={}) => ({
  activeId, connected:true, transportConnected:true, currentView:'editor',
  tabs:[{id:'a',title:'First',mode:'parameters'},{id:'b',title:'Second',mode:'parameters'}],
  ...overrides,
});
const snapshot = (text='original', number=12) => ({graph:{nodes:[{id:7}]},nodes:[{
  nodeId:7,graphId:'root',type:'Primitive',title:'Prompt',path:[],widgets:[
    {name:'text',value:text,type:'customtext',editable:true},
    {name:'steps',value:number,type:'number',editable:true},
  ],
}]});
const result = (text='original', options={}) => ({ok:true,state:state(),snapshot:snapshot(text),...options});
async function fixture(overrides={}) {
  const elements = new Map();
  const get = selector => {
    if(!elements.has(selector))elements.set(selector,element());
    return elements.get(selector);
  };
  const modes = ['graph','parameters','app'].map(mode => element({mode}));
  const document = {...element(),querySelector:get,querySelectorAll:selector => selector==='[data-mode]'?modes:[]};
  const calls = [];
  let notify;
  const methods = ['boot','connect','openTemplate','activateTab','closeTab','setMode','save','exportWorkflow','importWorkflow','newBlank','duplicateTab','showPreview','showEditor','snapshot','applyParameters'];
  const api = Object.fromEntries(methods.map(method => [method,(...args) => {
    calls.push({method,args:JSON.parse(JSON.stringify(args))});
    if(overrides[method])return overrides[method](...args);
    return Promise.resolve({...result(),templates:[]});
  }]));
  api.setBounds=()=>{};
  api.onStatus=callback=>{notify=callback;};
  vm.runInNewContext(source,{window:{yingzuoDesktop:api,...(overrides.yingzuo?{yingzuo:overrides.yingzuo}:{})},document,ResizeObserver:class{observe(){}}});
  await flush();
  return {
    get, calls, notify:data=>notify(data),
    callsFor:method=>calls.filter(call=>call.method===method),
    change(value,index=0){
      const input={dataset:{field:String(index)},value:String(value),checked:!!value,closest:()=>input};
      return {input,pending:get('#fields').dispatch('change',{target:input})};
    },
    click(selector,data={}){
      const target={dataset:data,closest:match => match==='[data-tab]'&&data.tab || match==='[data-close]'&&data.close || match==='[data-template]'&&data.template ? target : null};
      return get(selector).dispatch('click',{target});
    },
  };
}

test('parameter edits share the busy gate with navigation, save and repeated edits', async () => {
  const update = deferred();
  const f = await fixture({applyParameters:()=>update.promise});
  const {pending} = f.change('typed');
  assert.equal(f.get('#fields').inert,true);
  assert.equal(f.get('#tabs').inert,true);
  assert.equal(f.get('#save').disabled,true);
  assert.equal(f.get('#preview').disabled,true);
  f.click('#tabs',{tab:'b'});
  f.click('#save');
  f.change('second edit');
  assert.equal(f.callsFor('activateTab').length,0);
  assert.equal(f.callsFor('save').length,0);
  assert.equal(f.callsFor('applyParameters').length,1);
  assert.deepEqual(f.callsFor('applyParameters')[0].args.slice(0,2),[[{nodeId:7,graphId:'root',widgetName:'text',value:'typed'}],'a']);assert.equal(f.callsFor('applyParameters')[0].args.length,3,'C06：带 expectedRevision');
  update.resolve(result('server normalized'));
  await pending;
  assert.match(f.get('#fields').innerHTML,/server normalized/);
  assert.equal(f.get('#fields').inert,false);
  assert.equal(f.get('#save').disabled,false);
  assert.match(f.get('#status').textContent,/参数已同步/);
});

test('late parameter replies cannot replace a newer selected tab or its status', async () => {
  const update = deferred();
  const f = await fixture({applyParameters:()=>update.promise});
  const {pending} = f.change('old request');
  f.notify({...state('b'),snapshot:snapshot('new tab'),message:'newer navigation'});
  update.resolve(result('stale response'));
  await pending;
  assert.match(f.get('#tabs').innerHTML,/aria-selected="true" data-tab="b"/);
  assert.match(f.get('#fields').innerHTML,/new tab/);
  assert.doesNotMatch(f.get('#fields').innerHTML,/stale response/);
  assert.equal(f.get('#status').textContent,'newer navigation');
});

test('disconnect invalidates form bindings and late responses cannot reconnect the UI', async () => {
  const update = deferred();
  const f = await fixture({applyParameters:()=>update.promise});
  const {pending} = f.change('pending');
  f.notify({...state('a',{connected:false,transportConnected:false}),snapshot:null,error:'editor exited'});
  assert.doesNotMatch(f.get('#fields').innerHTML,/data-field=/);
  assert.equal(f.get('#parameters').hidden,true);
  update.resolve(result('too late'));
  await pending;
  f.change('must not submit');
  assert.equal(f.callsFor('applyParameters').length,1);
  assert.equal(f.get('#connection').textContent,'ComfyUI 未连接');
  assert.equal(f.get('#status').textContent,'editor exited');
});

test('failed edits render the authoritative snapshot including partial writes', async () => {
  for(const authoritative of ['original','partially updated']) {
    const f = await fixture({applyParameters:async()=>result(authoritative,{ok:false,error:'draft write failed'})});
    await f.change('edited field').pending;
    assert.ok(f.get('#fields').innerHTML.includes(authoritative));
    assert.doesNotMatch(f.get('#fields').innerHTML,/edited field/);
    assert.equal(f.get('#status').textContent,'draft write failed');
    assert.equal(f.get('#status').classList.contains('error'),true);
    assert.equal(f.get('#fields').inert,false);
  }
});

test('an error that invalidates its own editor still displays the actual error', async () => {
  const f = await fixture({applyParameters:async()=>({ok:false,error:'workflow changed',state:state('a',{connected:false}),snapshot:null})});
  await f.change('edited').pending;
  assert.equal(f.get('#status').textContent,'workflow changed');
  assert.doesNotMatch(f.get('#fields').innerHTML,/data-field=/);
});

test('IPC rejection restores last known field values and releases the busy gate', async () => {
  let reject=true;
  const f = await fixture({applyParameters:async()=>{if(reject)throw new Error('IPC unavailable');return result('retried');}});
  await f.change('unsaved').pending;
  assert.match(f.get('#fields').innerHTML,/original/);
  assert.equal(f.get('#status').textContent,'IPC unavailable');
  assert.equal(f.get('#fields').inert,false);
  reject=false;
  await f.change('retry').pending;
  assert.match(f.get('#fields').innerHTML,/retried/);
});

test('invalid numeric values restore the displayed value without sending IPC', async () => {
  const f = await fixture();
  for(const invalid of ['', ' ', 'NaN', 'Infinity']) {
    const {input,pending} = f.change(invalid,1);
    await pending;
    assert.equal(input.value,'12');
    assert.equal(f.get('#status').textContent,'请输入有效数字。');
  }
  assert.equal(f.callsFor('applyParameters').length,0);
});

test('background same-tab snapshots do not replace a form while the user is typing', async () => {
  const f = await fixture();
  const before = f.get('#fields').writes;
  f.notify({...state(),snapshot:snapshot(),message:'download completed'});
  assert.equal(f.get('#fields').writes,before);
  f.notify({...state('b'),message:'switched without snapshot'});
  assert.doesNotMatch(f.get('#fields').innerHTML,/data-field=/);
  f.change('stale field');
  assert.equal(f.callsFor('applyParameters').length,0);
});

/* ---------- C06：表单面板缓存身份与写回入口 ---------- */
const tplState=(vid,rev=1)=>state('a',{tabs:[{id:'a',title:'First',mode:'parameters',templateId:'tpl1',templateVersionId:vid,revision:rev},{id:'b',title:'Second',mode:'parameters'}]});
const formData=(label,vid,rev=1)=>({ok:true,data:{tabId:'a',revision:rev,templateId:'tpl1',versionId:vid,pinned:true,fields:[{index:0,label,group:'采样',widgetType:'int',constraints:{min:1,max:30},status:'ok',target:{nodeId:7,graphId:null,widgetName:'steps'}}]}});
const snapRoot=()=>({graph:{nodes:[{id:7}]},nodes:[{nodeId:7,graphId:'root',type:'K',title:'K',path:[],widgets:[{name:'steps',value:12,type:'number',editable:true}]}]});
test('C06：同一标签保存新表单版本后面板立即失效重载；迟到的旧版本响应不覆盖新版',async()=>{
  const pending=[];const formCalls=[];
  const yingzuo={tasks:{form:tabId=>{formCalls.push(tabId);const d=deferred();pending.push(d);return d.promise;},applyFormField:async()=>({ok:true,data:{}})}};
  const f=await fixture({yingzuo,boot:()=>Promise.resolve({ok:true,state:tplState('v1'),snapshot:snapRoot(),templates:[]})});
  await flush();
  assert.equal(formCalls.length,1);
  f.notify({...tplState('v2'),snapshot:snapRoot()});await flush();
  assert.equal(formCalls.length,2,'同一标签版本变化触发重新映射');
  pending[1].resolve(formData('新标签名','v2'));await flush();
  assert.match(f.get('#fields').innerHTML,/新标签名/);
  pending[0].resolve(formData('旧标签名','v1'));await flush();
  assert.match(f.get('#fields').innerHTML,/新标签名/);assert.doesNotMatch(f.get('#fields').innerHTML,/旧标签名/);
});
test('C06：表单字段越界前端即时拒绝；合法值经主进程表单入口写回（带表单版本与标签版本）',async()=>{
  const applied=[];
  const yingzuo={tasks:{form:async()=>formData('步数','v1',5),applyFormField:async(tabId,o)=>{applied.push({tabId,...o});return {ok:true,data:{}};}}};
  const f=await fixture({yingzuo,boot:()=>Promise.resolve({ok:true,state:tplState('v1',5),snapshot:snapRoot(),templates:[]}),snapshot:()=>Promise.resolve({ok:true,state:tplState('v1',5),snapshot:snapRoot()})});
  await flush();await flush();
  assert.match(f.get('#fields').innerHTML,/步数/);
  await f.change('99').pending;
  assert.equal(applied.length,0);assert.match(f.get('#status').textContent,/超出允许范围/);
  await f.change('20').pending;await flush();
  assert.deepEqual(applied,[{tabId:'a',index:0,value:20,expectedRevision:5,versionId:'v1'}]);
  assert.equal(f.callsFor('applyParameters').length,0,'表单字段不绕过主进程约束直接写画布');
});
