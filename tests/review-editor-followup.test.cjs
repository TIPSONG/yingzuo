'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const Store = require('../desktop/workspace-store.cjs');
const Bridge = require('../desktop/comfy-bridge-source.cjs');
const {createEditorSession} = require('../desktop/services/editor-session.cjs');
const {createGraphStoragePolicy} = require('../shared/graph-storage-policy.cjs');
const graph = text => ({version: 0.4, nodes: [{id: 1, type: 'CLIPTextEncode', widgets_values: [text]}], links: []});

function editorFixture(t, {encryption = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yingzuo-editor-followup-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const paths = {root, workspace: path.join(root, 'workspace.json'), closed: path.join(root, 'closed'), exports: path.join(root, 'exports')};
  Store.writeWorkspace(paths.workspace, {version: 2, activeId: 'a', tabs: [{id: 'a', title: 'A', graph: graph('original'), revision: 0}]});
  const state = {views: [], nativeGraph: graph('native'), nativeName: null, hook: null, converted: null};
  const snapshot = () => ({ok: true, graph: structuredClone(state.nativeGraph), nodes: state.nativeGraph.nodes.map(n => ({nodeId: n.id, type: n.type})), workflow: {path: `workflows/${state.nativeName}`, documentId: `doc-${state.nativeName}`}, connected: true});
  const run = async (op, payload) => {
    if (op === 'capabilities') return {ok: true, connected: true};
    if (op === 'load') { state.nativeGraph = structuredClone(payload.graph); state.nativeName = payload.name; return snapshot(); }
    if (op === 'snapshot') return snapshot();
    if (op === 'mode') return {ok: true};
    if (op === 'convertApi') {
      state.converted = structuredClone(payload.prompt);
      state.nativeGraph = {nodes: Object.entries(payload.prompt).map(([id, node]) => ({id, type: node.class_type, widgets_values: structuredClone(node.inputs)})), links: []};
      return snapshot();
    }
    throw new Error(`Unexpected operation: ${op}`);
  };
  class Contents extends EventEmitter {
    isDestroyed() { return false; }
    getURL() { return this.url; }
    setWindowOpenHandler() {}
    async loadURL(url) { this.url = url; }
    executeJavaScript(source) { const {op, payload} = JSON.parse(source); return state.hook ? state.hook(op, payload, run) : run(op, payload); }
  }
  class View {
    constructor() { this.webContents = new Contents(); state.views.push(this); }
    setBounds() {}
    setVisible(value) { this.visible = value; }
  }
  const session = new EventEmitter(); session.setPermissionRequestHandler = session.setPermissionCheckHandler = () => {};
  const bridge = Object.fromEntries(Object.entries({getCapabilitiesSource: 'capabilities', loadGraphSource: 'load', snapshotSource: 'snapshot', convertApiSource: 'convertApi'}).map(([key, op]) => [key, (payload = {}) => JSON.stringify({op, payload})]));
  bridge.setModeSource = (mode, expectedName) => JSON.stringify({op: 'mode', payload: {mode, expectedName}});
  const editor = createEditorSession({electron: {WebContentsView: View, dialog: {}, session: {fromPartition: () => session}}, Store, Bridge: bridge, paths, log() {}, serveResource() {}, templates: () => [], comfyUrlProvider: () => new URL('http://127.0.0.1:8188/'), timers: {setTimeout, clearTimeout}, fetch: async () => ({ok: true, json: async () => ({system: {}, devices: []})}), AbortSignal});
  editor.attachWindow({isDestroyed: () => false, webContents: {send() {}}, contentView: {addChildView() {}}, getContentSize: () => [1000, 700]});
  editor.setBounds({x: 0, y: 0, width: 1000, height: 700});
  const items = {}, secrets = new Map();
  const credentials = {available: () => encryption, read: () => ({items}), get: key => secrets.get(key), set: (key, value, meta) => { secrets.set(key, value); items[key] = meta; }};
  editor.setGraphPolicy(createGraphStoragePolicy({credentials}));
  return {editor, state, paths, secrets, read: () => Store.readWorkspace(paths.workspace)};
}

test('failed replacement of the current graph disconnects the partial canvas and reconnects the saved original', async t => {
  const f = editorFixture(t); await f.editor.connect();
  f.state.hook = async (op, payload, run) => {
    const result = await run(op, payload);
    return op === 'load' ? {ok: false, error: {code: 'LOAD_FAILED', message: 'simulated partial load'}} : result;
  };
  await assert.rejects(f.editor.commands.replaceGraph('a', graph('replacement'), 0), /simulated partial load/);
  assert.equal(f.read().tabs[0].graph.nodes[0].widgets_values[0], 'original');
  assert.equal(f.editor.state().connected, false);
  assert.equal(f.state.views[0].visible, false);
  f.state.hook = null;
  await f.editor.connect();
  assert.equal(f.editor.currentSnapshot().graph.nodes[0].widgets_values[0], 'original');
});

test('API imports protect the archived prompt without replacing the value sent to the editor', async t => {
  const f = editorFixture(t); await f.editor.connect();
  const key = 'fictional-api-key-for-import-test';
  const prompt = {'1': {class_type: 'RemoteImage', inputs: {api_key: key, text: 'a cat'}}};
  const result = await f.editor.commands.importText(JSON.stringify(prompt), 'API');
  const archivedText = fs.readFileSync(result.importInfo.original, 'utf8');
  assert.equal(archivedText.includes(key), false);
  assert.ok(archivedText.includes('__yz_credential__:'));
  assert.equal(f.state.converted['1'].inputs.api_key, key);
  assert.equal(f.editor.active().graph.nodes[0].widgets_values.api_key, key);
  assert.equal(JSON.stringify(f.read()).includes(key), false);
  assert.equal(prompt['1'].inputs.api_key, key);
  const restored = await f.editor.commands.importText(archivedText, 'Recovered API');
  assert.equal(restored.importInfo.complete, true);
  assert.equal(f.state.converted['1'].inputs.api_key, key);
});

test('API import without encryption refuses the archive before changing the current draft', async t => {
  const f = editorFixture(t, {encryption: false});
  const source = JSON.stringify({'1': {class_type: 'RemoteImage', inputs: {api_key: 'fictional-unavailable-key', text: 'a cat'}}});
  const before = fs.readFileSync(f.paths.workspace, 'utf8');
  await assert.rejects(f.editor.commands.importText(source, 'Unavailable'), {code: 'CREDENTIAL_UNAVAILABLE'});
  assert.equal(fs.readFileSync(f.paths.workspace, 'utf8'), before);
  assert.equal(f.editor.active().graph.nodes[0].widgets_values[0], 'original');
  assert.equal(fs.existsSync(path.join(f.paths.root, 'imports')) ? fs.readdirSync(path.join(f.paths.root, 'imports')).length : 0, 0);
  assert.equal(source.includes('fictional-unavailable-key'), true);
});

test('focusing a root node while inside a subgraph changes the canvas before selection', async () => {
  const node = {id: 1}, inner = {id: 2}, child = {id: 'child', nodes: [inner]};
  const root = {id: 'root', nodes: [node], subgraphs: new Map([['child', child]]), serialize: () => ({nodes: []})};
  const workflow = {path: 'workflow.json', activeState: {id: 'doc'}};
  const store = {activeWorkflow: workflow, openWorkflows: [workflow], createNewTemporary: () => workflow};
  const app = {rootGraph: root, graph: child, canvas: {graph: child, setGraph(g) { this.graph = g; }, selectNode(n) { assert.equal(this.graph, root); assert.equal(n, node); }}, extensionManager: {workflow: store}, loadGraphData: async () => true};
  const context = vm.createContext({app, __testApp: app, comfyAPI: {app: {app}}});
  const run = source => vm.runInContext(source.replace("import('/scripts/app.js')", 'Promise.resolve({app: __testApp})'), context);
  const loaded = await run(Bridge.loadGraphSource({name: 'tab', graph: {nodes: []}}));
  assert.equal(loaded.ok, true, loaded.error?.message);
  const result = await run(Bridge.focusNodeSource({expectedName: 'tab', scopePath: [], nodeId: 1}));
  assert.equal(result.ok, true, result.error?.message);
});
