'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../desktop/workspace-store.cjs');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yingzuo-workspace-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  return {dir,file:path.join(dir,'workspace.json')};
}
const graph = prompt => ({version:0.4,nodes:[{id:1,type:'CLIPTextEncode',widgets_values:[prompt]}],links:[],extra:{nested:{keep:true}}});

test('missing workspace is empty; saved active draft survives a round trip', t => {
  const {file} = temporary(t);
  assert.deepEqual(Store.readWorkspace(file), {version:1,activeId:null,tabs:[]});
  const workspace = Store.emptyWorkspace();
  const tab = Store.addTab(workspace,'文生图',graph('keep this prompt'),'text');
  workspace.activeId = tab.id;
  Store.writeWorkspace(file,workspace);
  assert.deepEqual(Store.readWorkspace(file),workspace);
  assert.equal(fs.existsSync(file+'.tmp'),false);
});

test('corrupt saved draft is reported without rewriting or deleting original bytes', t => {
  const {file} = temporary(t);
  const original = Buffer.from('{"version":1,"tabs":[ incomplete existing draft');
  fs.writeFileSync(file,original);
  assert.throws(() => Store.readWorkspace(file));
  assert.deepEqual(fs.readFileSync(file),original);
  assert.equal(fs.existsSync(file+'.tmp'),false);
});

test('unsafe and duplicate tab identifiers are rejected while the file stays intact', t => {
  const {file} = temporary(t);
  for (const ids of [['../../outside'],['a','a']]) {
    const text = JSON.stringify({version:1,activeId:ids[0],tabs:ids.map(id=>({id,title:'draft',graph:graph('test'),mode:'graph'}))});
    fs.writeFileSync(file,text);
    assert.throws(() => Store.readWorkspace(file), /标识/);
    assert.equal(fs.readFileSync(file,'utf8'),text);
  }
});

test('failed temp-file write leaves the previous valid workspace unchanged', t => {
  const {file} = temporary(t);
  const first = Store.emptyWorkspace();
  Store.addTab(first,'before',graph('before'));
  Store.writeWorkspace(file,first);
  const original = fs.readFileSync(file);
  fs.mkdirSync(file+'.tmp');
  const next = Store.emptyWorkspace();
  Store.addTab(next,'after',graph('after'));
  assert.throws(() => Store.writeWorkspace(file,next));
  assert.deepEqual(fs.readFileSync(file),original);
});

test('working copies do not share graph objects with templates or sibling tabs', () => {
  const workspace = Store.emptyWorkspace();
  const template = graph('original');
  const first = Store.addTab(workspace,'first',template);
  const second = Store.addTab(workspace,'second',template);
  assert.notEqual(first.id,second.id);
  first.graph.nodes[0].widgets_values[0] = 'edited first';
  first.graph.extra.nested.keep = false;
  assert.equal(template.nodes[0].widgets_values[0],'original');
  assert.equal(second.graph.nodes[0].widgets_values[0],'original');
  assert.equal(template.extra.nested.keep,true);
  assert.equal(second.graph.extra.nested.keep,true);
});

test('invalid graphs never become partially inserted tabs', () => {
  const workspace = Store.emptyWorkspace();
  for (const bad of [{prompt:{}},{nodes:[{id:1}]},{nodes:[{id:1,type:'A'},{id:1,type:'B'}]}]) {
    assert.throws(() => Store.addTab(workspace,'bad',bad));
    assert.equal(workspace.tabs.length,0);
  }
});

test('tab limit refuses a new tab without deleting existing drafts', () => {
  const workspace = Store.emptyWorkspace();
  for (let i=0;i<Store.MAX_TABS;i++) Store.addTab(workspace,`tab-${i}`,graph(`prompt-${i}`));
  const before = JSON.stringify(workspace);
  assert.throws(() => Store.addTab(workspace,'overflow',graph('new')), /20/);
  assert.equal(JSON.stringify(workspace),before);
});

test('stale active ID and unsupported display mode recover without losing the graph', t => {
  const {file} = temporary(t);
  const workspace = Store.emptyWorkspace();
  const tab = Store.addTab(workspace,'draft',graph('must survive'));
  workspace.activeId = 'missing-id'; tab.mode = 'unknown';
  fs.writeFileSync(file,JSON.stringify(workspace));
  const loaded = Store.readWorkspace(file);
  assert.equal(loaded.activeId,tab.id);
  assert.equal(loaded.tabs[0].mode,'graph');
  assert.deepEqual(loaded.tabs[0].graph,tab.graph);
});

test('renderer bounds cannot escape the native content area or pass NaN', () => {
  assert.deepEqual(Store.validateBounds({x:-100,y:10,width:2000,height:900},[1000,700]),{x:0,y:10,width:1000,height:690});
  assert.deepEqual(Store.validateBounds({x:1500,y:900,width:200,height:300},[1000,700]),{x:1000,y:700,width:0,height:0});
  assert.deepEqual(Store.validateBounds({x:0,y:0,width:-1,height:-2},[1000,700]),{x:0,y:0,width:0,height:0});
  for (const invalid of [undefined,{x:0,y:0,width:NaN,height:10},{x:0,y:0,width:Infinity,height:10},{x:'0',y:0,width:10,height:10}]) {
    assert.throws(() => Store.validateBounds(invalid,[1000,700]), /尺寸/);
  }
});

test('the exported file size limit enforces the same boundary as graph validation', () => {
  assert.ok(Number.isInteger(Store.MAX_GRAPH_BYTES) && Store.MAX_GRAPH_BYTES > 0, 'Main-process file imports must be able to use the actual size limit before reading.');
  const tooLarge = {nodes:[],extra:{payload:'x'.repeat(Store.MAX_GRAPH_BYTES)}};
  assert.throws(() => Store.validateGraph(tooLarge), /8 MB/);
});

test('invalid writes cannot replace an existing readable workspace', t => {
  const {file} = temporary(t);
  const workspace = Store.emptyWorkspace();
  const tab = Store.addTab(workspace,'original',graph('keep'));
  workspace.activeId = tab.id;
  Store.writeWorkspace(file,workspace);
  const original = fs.readFileSync(file);
  const invalid = [
    null, [], {version:2,tabs:[]}, {version:1,tabs:[null]},
    {...workspace,tabs:[tab,tab]},
    {...workspace,tabs:[{...tab,id:'../outside'}]},
    {...workspace,tabs:[{...tab,graph:{nodes:[{id:1}]}}]},
    {...workspace,tabs:Array(Store.MAX_TABS+1).fill(tab)},
    {...workspace,tabs:Array(1)},
    {...workspace,tabs:[{...tab,graph:{nodes:Array(1)}}]},
    {...workspace,tabs:[{...tab,graph:{nodes:[],extra:{payload:'x'.repeat(Store.MAX_GRAPH_BYTES)}}}]},
  ];
  for (const data of invalid) {
    assert.throws(() => Store.writeWorkspace(file,data));
    assert.deepEqual(fs.readFileSync(file),original);
    assert.deepEqual(Store.readWorkspace(file),workspace);
    assert.equal(fs.existsSync(file+'.tmp'),false);
  }
});

test('writes and reads normalize metadata consistently without changing the caller', t => {
  const {file} = temporary(t);
  const workspace = Store.emptyWorkspace();
  const tab = Store.addTab(workspace,'draft',graph('keep'));
  tab.title = 'CON.txt... '; tab.mode = 'future-mode'; workspace.activeId='missing';
  const before = JSON.stringify(workspace);
  Store.writeWorkspace(file,workspace);
  const saved = JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(Store.readWorkspace(file),saved);
  assert.equal(saved.activeId,tab.id);
  assert.equal(saved.tabs[0].title,'_CON.txt');
  assert.equal(saved.tabs[0].mode,'graph');
  assert.equal(JSON.stringify(workspace),before);
});

test('null and malformed workspace data get a readable validation error', t => {
  const {file} = temporary(t);
  for (const data of [null,[],{version:1,tabs:[null]}]) {
    const original = JSON.stringify(data);
    fs.writeFileSync(file,original);
    assert.throws(() => Store.readWorkspace(file), /工作区/);
    assert.equal(fs.readFileSync(file,'utf8'),original);
  }
});

test('Windows filenames reject device aliases, trailing dots, separators and control characters', () => {
  for (const name of ['CON','con.json','CON .json','CONIN$','CONOUT$','PrN','AUX.png','NUL','COM1','LPT9.txt','COM¹.json','LPT²','COM³']) {
    assert.equal(Store.safeName(name),'_'+name);
  }
  for (const name of ['COM0','COM10','LPT10','console.json','文生图.json']) assert.equal(Store.safeName(name),name);
  assert.equal(Store.safeName('  draft...  '),'draft');
  assert.equal(Store.safeName(' . .. '),'工作流');
  assert.equal(Store.safeName('a<>:"/\\|?*\x00\x1f'),'a'+'_'.repeat(11));
  assert.equal(Store.safeName('a'.repeat(79)+'.ending'),'a'.repeat(79));
  assert.equal(Store.safeName('CON.'+'x'.repeat(100)).length,80);
  assert.equal(Store.safeName('CON.'+'x'.repeat(74)+'.a'),'_CON.'+'x'.repeat(74));
});
