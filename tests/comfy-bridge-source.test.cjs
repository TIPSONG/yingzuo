'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const bridge = require('../desktop/comfy-bridge-source.cjs');

// Isolated ComfyUI API mocks throughout; this suite does not run ComfyUI,
// Electron or Windows UI acceptance paths.
function fixture() {
  const node = { id: 7, title: 'Prompt', type: 'CLIPTextEncode', widgets: [{ name: 'text', type: 'customtext', value: 'old' }] };
  const inner = { id: 7, title: 'Inner', type: 'Primitive', widgets: [{ name: 'value', type: 'number', value: 12 }] };
  const child = { id: 'child', nodes: [inner] };
  const root = {
    id: 'root', nodes: [node], extra: {}, subgraphs: new Map([['child', child]]),
    serialize() { return { version: 0.4, nodes: this.nodes.map(n => ({ id: n.id, type: n.type, widgets_values: n.widgets.map(w => w.value) })), extra: this.extra, definitions: { subgraphs: [{ id: child.id, nodes: child.nodes.map(n => ({ id: n.id, widgets_values: n.widgets.map(w => w.value) })) }] } }; }
  };
  let captures = 0;
  const active = { path: 'workflows/test.json', key: 'test.json', activeState: { id: 'fixture-document-id' }, activeMode: 'graph', changeTracker: { captureCanvasState() { captures++; } } };
  const store = { activeWorkflow: active, openWorkflows: [active], createNewTemporary: name => ({ ...active, activeState: null, initialState: null, path: `workflows/${name}`, key: name }) };
  const app = { rootGraph: root, graph: child, canvas: { setDirty() {} }, api: { socket: { readyState: 1 } }, extensionManager: { workflow: store, queueSettings: { mode: 'disabled' } } };
  app.loadGraphData = async (graph, clean, restore, target) => { target.activeState ??= { id: graph.id ?? 'fixture-document-id' }; store.activeWorkflow = target; if (!store.openWorkflows.includes(target)) store.openWorkflows.push(target); return true; };
  const context = vm.createContext({ app, __testApp: app, __importCount: 0, comfyAPI: { app: { app } } });
  async function run(source) {
    // Production source keeps the formal shim import. Tests substitute only that import.
    const value = await vm.runInContext(source.replace("import('/scripts/app.js')", '(++__importCount, Promise.resolve({ app: __testApp }))'), context);
    return JSON.parse(JSON.stringify(value));
  }
  return { app, root, child, node, inner, store, active, run, captures: () => captures, imports: () => context.__importCount, publishCanvasReady: ready => { context.app = ready ? app : undefined; }, publishReady: ready => { context.comfyAPI = ready ? { app: { app } } : undefined; } };
}

test('snapshot always serializes the full root graph while viewing a subgraph', async () => {
  const f = fixture();
  const result = await f.run(bridge.snapshotSource());
  assert.equal(result.ok, true);
  assert.equal(result.graph.nodes[0].type, 'CLIPTextEncode');
  assert.equal(result.graph.definitions.subgraphs[0].id, 'child');
  assert.deepEqual(result.nodes.map(n => [n.nodeId, n.graphId]), [[7, 'root'], [7, 'child']]);
  assert.equal(result.connected, true);
  f.app.api.socket = null;
  assert.equal((await f.run(bridge.getCapabilitiesSource())).connected, false);
  delete f.app.api;
  assert.equal((await f.run(bridge.getCapabilitiesSource())).connected, false);
});

test('loading returns explicit failure and stable names reuse only open workflow objects', async () => {
  const f = fixture();
  const argumentsSeen = [];
  const originalLoad = f.app.loadGraphData;
  f.app.loadGraphData = async (...args) => { argumentsSeen.push(args); return originalLoad(...args); };
  const name = 'yingzuo-tab-1';
  assert.equal((await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }))).ok, true);
  await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  assert.equal(argumentsSeen[0][3].key, `${name}.json`);
  assert.equal(argumentsSeen[1][3], argumentsSeen[0][3]);
  f.store.openWorkflows = [];
  await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  assert.notEqual(argumentsSeen[2][3], argumentsSeen[0][3]);
  assert.equal(argumentsSeen[2][3].key, `${name}.json`);
  f.app.loadGraphData = async () => false;
  assert.equal((await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }))).error.code, 'LOAD_FAILED');
});

test('JSON parameters and malicious-looking names remain data, never executable source', async () => {
  const f = fixture();
  const text = "'); globalThis.compromised = true; // ${evil} ` \\ \u2028";
  const originalLoad = f.app.loadGraphData;
  f.app.loadGraphData = async (graph, clean, restore, target) => { assert.equal(target.key, `${text}.json`); return originalLoad(graph, clean, restore, target); };
  await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: text }] }));
  assert.equal(f.node.widgets[0].value, text);
  assert.equal((await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: text }))).ok, true);
  assert.equal(f.captures(), 1);
});

test('parameter updates distinguish same node IDs across graphs and prevalidate the whole batch', async () => {
  const f = fixture();
  const result = await f.run(bridge.applyParametersSource({ updates: [{ graphId: 'child', nodeId: 7, widgetName: 'value', value: 20 }] }));
  assert.equal(result.ok, true);
  assert.equal(f.inner.widgets[0].value, 20);
  assert.equal(f.node.widgets[0].value, 'old');
  const invalid = await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 'should not apply' }, { nodeId: 404, widgetName: 'value', value: 8 }] }));
  assert.equal(invalid.error.code, 'NODE_NOT_FOUND');
  assert.equal(f.node.widgets[0].value, 'old');
});

test('connected, action, and ambiguous widget names cannot be changed', async () => {
  const f = fixture();
  f.node.inputs = [{ name: 'text', link: 1 }];
  const source = bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 'new' }] });
  assert.equal((await f.run(source)).error.code, 'WIDGET_NOT_EDITABLE');
  f.node.inputs = [];
  f.node.widgets[0].type = 'button';
  assert.equal((await f.run(source)).error.code, 'WIDGET_NOT_EDITABLE');
  f.node.widgets[0].type = 'customtext';
  f.node.widgets.push({ ...f.node.widgets[0] });
  assert.equal((await f.run(source)).error.code, 'WIDGET_NOT_EDITABLE');
});

test('type mismatches, objects and invalid combo values are rejected', async () => {
  const f = fixture();
  for (const value of [{ code: 'alert(1)' }, null]) assert.equal((await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value }] }))).error.code, 'INVALID_VALUE');
  assert.equal((await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 1 }] }))).error.code, 'TYPE_MISMATCH');
  f.node.widgets[0] = { name: 'model', type: 'combo', value: 'qwen', options: { values: ['qwen'] } };
  assert.equal((await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'model', value: 'arbitrary' }] }))).error.code, 'INVALID_OPTION');
});

test('official App Mode state is changed only with existing configuration', async () => {
  const f = fixture();
  assert.equal((await f.run(bridge.setModeSource('app'))).error.code, 'APP_NOT_CONFIGURED');
  assert.deepEqual(f.root.extra, {});
  f.root.extra.linearData = { inputs: [['widget-id', 'text']], outputs: [7] };
  assert.equal((await f.run(bridge.setModeSource('app'))).ok, true);
  assert.equal(f.active.activeMode, 'app');
  assert.equal((await f.run(bridge.setModeSource('graph'))).workflow.mode, 'graph');
  assert.equal((await f.run(bridge.setModeSource('builder:inputs'))).error.code, 'INVALID_MODE');
});

test('descriptor limits do not truncate the saved full graph', async () => {
  const f = fixture();
  f.root.nodes = Array.from({ length: 550 }, (_, id) => ({ id, widgets: [{ name: 'value', type: 'number', value: id }] }));
  const result = await f.run(bridge.snapshotSource());
  assert.equal(result.nodes.length, 500);
  assert.equal(result.graph.nodes.length, 550);
  assert.equal(result.truncated, true);
});

test('third party widget failures explicitly report uncertain partial application', async () => {
  const f = fixture();
  f.node.widgets[0].callback = () => { throw new Error('Plugin rejected update'); };
  const result = await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 'new' }] }));
  assert.equal(result.error.code, 'APPLY_FAILED');
  assert.equal(result.needsSnapshot, true);
});

test('automatic queue modes, unknown queue state and legacy enabled block before mutation', async () => {
  const f = fixture();
  const source = bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 'new' }] });
  for (const mode of ['change', 'instant-idle', 'instant-running', undefined]) {
    f.app.extensionManager.queueSettings.mode = mode;
    assert.equal((await f.run(source)).error.code, 'AUTO_QUEUE_ENABLED');
  }
  f.app.extensionManager.queueSettings.mode = 'disabled';
  f.app.ui = { autoQueueEnabled: true };
  assert.equal((await f.run(source)).error.code, 'AUTO_QUEUE_ENABLED');
  assert.equal(f.node.widgets[0].value, 'old');
  assert.equal(f.captures(), 0);
  f.app.ui.autoQueueEnabled = false;
  assert.equal((await f.run(source)).ok, true);
});

test('expected host identity rejects native tab changes for save, parameters and mode', async () => {
  const f = fixture();
  const name = 'yingzuo-identity';
  const loaded = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  assert.equal(loaded.workflow.hostName, name);
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).ok, true);
  const owned = f.store.activeWorkflow;
  f.store.activeWorkflow = { ...owned, activeState: { id: 'another-document-id' } }; // Path alone is insufficient.
  for (const source of [
    bridge.snapshotSource({ expectedName: name }),
    bridge.applyParametersSource({ expectedName: name, updates: [{ nodeId: 7, widgetName: 'text', value: 'wrong tab' }] }),
    bridge.setModeSource('graph', name)
  ]) {
    const result = await f.run(source);
    assert.equal(result.error.code, 'WORKFLOW_CHANGED');
    assert.equal(result.graph, undefined);
    assert.equal(result.workflow.hostName, null);
  }
  assert.equal(f.node.widgets[0].value, 'old');
  assert.equal(f.captures(), 0);
  f.store.activeWorkflow = owned;
  owned.key = 'renamed.json';
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).workflow.hostName, name);
});

test('unknown expected identity and native switch during load never return a graph', async () => {
  const f = fixture();
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: 'unknown' }))).error.code, 'WORKFLOW_CHANGED');
  f.app.loadGraphData = async () => true; // Simulates a different native tab active when load resolves.
  const result = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-race' }));
  assert.equal(result.error.code, 'WORKFLOW_CHANGED');
  assert.equal(result.graph, undefined);
  assert.equal((await f.run(bridge.getCapabilitiesSource())).workflow.hostName, null);
});

test('widget callback switching workflow cannot capture another tab into the host document', async () => {
  const f = fixture();
  const name = 'yingzuo-callback';
  await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  f.node.widgets[0].callback = () => { f.store.activeWorkflow = f.active; };
  const result = await f.run(bridge.applyParametersSource({ expectedName: name, updates: [{ nodeId: 7, widgetName: 'text', value: 'new' }] }));
  assert.equal(result.error.code, 'WORKFLOW_CHANGED');
  assert.equal(result.needsSnapshot, true);
  assert.equal(result.graph, undefined);
  assert.equal(f.captures(), 0);
});

test('early readiness checks do not import and poison the formal shim module', async () => {
  const f = fixture();
  f.publishReady(false);
  const result = await f.run(bridge.getCapabilitiesSource());
  assert.equal(result.error.code, 'NOT_READY');
  assert.equal(f.imports(), 0);
  f.publishReady(true);
  assert.equal((await f.run(bridge.getCapabilitiesSource())).ok, true);
  assert.equal(f.imports(), 1);
});

test('published app waits for graph readiness and startup draft restoration', async () => {
  const f = fixture();
  f.app.isGraphReady = false;
  assert.equal((await f.run(bridge.getCapabilitiesSource())).error.code, 'NOT_READY');
  f.app.isGraphReady = true;
  f.app.extensionManager.spinner = true;
  assert.equal((await f.run(bridge.getCapabilitiesSource())).error.code, 'NOT_READY');
  f.app.extensionManager.spinner = false;
  f.publishCanvasReady(false);
  assert.equal((await f.run(bridge.getCapabilitiesSource())).error.code, 'NOT_READY');
  f.publishCanvasReady(true);
  assert.equal((await f.run(bridge.getCapabilitiesSource())).ok, true);
});

test('Vue Proxy wrappers retain identity only when both unique path and document ID match', async () => {
  const f = fixture();
  const targets = [];
  const load = f.app.loadGraphData;
  f.app.loadGraphData = async (graph, clean, restore, target) => {
    targets.push(target);
    await load(graph, clean, restore, target);
    const wrapped = new Proxy(target, {});
    f.store.activeWorkflow = wrapped;
    f.store.openWorkflows = [wrapped];
    return true;
  };
  const name = 'yingzuo-proxy';
  const loaded = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.workflow.hostName, name);
  assert.equal(loaded.workflow.documentId, 'fixture-document-id');
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).ok, true);
  assert.equal((await f.run(bridge.applyParametersSource({ expectedName: name, updates: [{ nodeId: 7, widgetName: 'text', value: 'proxy update' }] }))).ok, true);
  assert.equal((await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }))).ok, true);
  assert.equal(targets[1].path, targets[0].path);
  const owned = f.store.activeWorkflow;
  f.store.activeWorkflow = { ...owned, path: 'workflows/another-tab.json' }; // Same graph ID alone is insufficient.
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).error.code, 'WORKFLOW_CHANGED');
});

test('restart reuses a restored native tab only by saved path and document ID together', async () => {
  const f = fixture();
  let created = 0;
  const create = f.store.createNewTemporary;
  f.store.createNewTemporary = (...args) => { created++; return create(...args); };
  const previous = new Proxy(f.active, {});
  f.store.openWorkflows = [previous];
  const loaded = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-restored', workflowPath: previous.path, documentId: previous.activeState.id }));
  assert.equal(loaded.ok, true);
  assert.equal(created, 0);
  assert.equal(loaded.workflow.path, previous.path);
  assert.equal(loaded.workflow.hostName, 'yingzuo-restored');
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: 'yingzuo-restored' }))).ok, true);
});

test('restore ignores path-only and ID-only matches and rejects incomplete saved identity', async () => {
  for (const identity of [
    { workflowPath: 'workflows/test.json', documentId: 'different-id' },
    { workflowPath: 'workflows/different.json', documentId: 'fixture-document-id' }
  ]) {
    const f = fixture();
    const loaded = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-new', ...identity }));
    assert.equal(loaded.ok, true);
    assert.equal(loaded.workflow.path, 'workflows/yingzuo-new.json');
    assert.notEqual(f.store.activeWorkflow, f.active);
  }
  const f = fixture();
  for (const identity of [{ workflowPath: f.active.path }, { documentId: f.active.activeState.id }]) {
    const result = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-partial', ...identity }));
    assert.equal(result.error.code, 'INVALID_WORKFLOW_IDENTITY');
    assert.equal(f.store.activeWorkflow, f.active);
  }
});


test('native document replacement on the same workflow object invalidates its host binding', async () => {
  const f = fixture();
  const name = 'yingzuo-replaced-document';
  await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  const owned = f.store.activeWorkflow;
  owned.path = 'workflows/renamed.json';
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).ok, true);
  owned.activeState = { id: 'replacement-document-id' };
  for (const source of [
    bridge.snapshotSource({ expectedName: name }),
    bridge.applyParametersSource({ expectedName: name, updates: [{ nodeId: 7, widgetName: 'text', value: 'wrong document' }] }),
    bridge.setModeSource('graph', name)
  ]) assert.equal((await f.run(source)).error?.code, 'WORKFLOW_CHANGED');
  assert.equal((await f.run(bridge.getCapabilitiesSource())).workflow.hostName, null);
  assert.equal(f.node.widgets[0].value, 'old');
});

test('failed loads invalidate the canvas binding until a successful retry reuses the native document', async () => {
  const f = fixture();
  const name = 'yingzuo-failed-retry';
  const load = f.app.loadGraphData;
  await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  const owned = f.store.activeWorkflow;
  for (const throws of [false, true]) {
    f.app.loadGraphData = async () => {
      f.node.widgets[0].value = 'partially loaded';
      if (throws) throw new Error('Extension failed during load');
      return false;
    };
    assert.equal((await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }))).ok, false);
    assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).error?.code, 'WORKFLOW_CHANGED');
    assert.equal((await f.run(bridge.getCapabilitiesSource())).workflow.hostName, null);
    assert.equal((await f.run(bridge.snapshotSource())).graph.nodes[0].widgets_values[0], 'partially loaded');
    assert.equal((await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 'unsafe' }] }))).error?.code, 'WORKFLOW_CHANGED');
    f.app.loadGraphData = load;
    const result = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
    assert.equal(result.ok, true);
    assert.equal(f.store.activeWorkflow, owned);
  }
});

test('a pending bridge load blocks overlapping loads and canvas operations', async () => {
  const f = fixture();
  let finish;
  let calls = 0;
  const load = f.app.loadGraphData;
  f.app.loadGraphData = async (...args) => {
    calls++;
    await new Promise(resolve => { finish = resolve; });
    return load(...args);
  };
  const pending = f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-pending' }));
  // Flush only microtasks; the mock's promise controls the load boundary.
  while (!finish) await Promise.resolve();
  for (const source of [
    bridge.snapshotSource(),
    bridge.setModeSource('graph'),
    bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 'unsafe' }] }),
    bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-overlap' })
  ]) assert.equal((await f.run(source)).error?.code, 'NOT_READY');
  assert.equal(calls, 1);
  assert.equal(f.node.widgets[0].value, 'old');
  finish();
  assert.equal((await pending).ok, true);
});

test('a restored native document cannot be claimed by two independent host tabs', async () => {
  const f = fixture();
  let loads = 0;
  const load = f.app.loadGraphData;
  f.app.loadGraphData = async (...args) => { loads++; return load(...args); };
  const first = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-first' }));
  loads = 0;
  const second = await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name: 'yingzuo-second', workflowPath: first.workflow.path, documentId: first.workflow.documentId }));
  assert.equal(second.error?.code, 'INVALID_WORKFLOW_IDENTITY');
  assert.equal(loads, 0);
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: 'yingzuo-first' }))).ok, true);
});

test('callbacks cannot make later batch targets writable after their mapping changes', async () => {
  for (const change of ['disabled', 'linked', 'replaced', 'widget-renamed', 'node-renamed', 'graph-renamed']) {
    const f = fixture();
    const oldWidget = f.inner.widgets[0];
    f.node.widgets[0].callback = () => {
      if (change === 'disabled') oldWidget.disabled = true;
      if (change === 'linked') f.inner.inputs = [{ name: 'value', link: 0 }];
      if (change === 'replaced') f.inner.widgets[0] = { ...oldWidget, value: 30 };
      if (change === 'widget-renamed') oldWidget.name = 'different-value';
      if (change === 'node-renamed') f.inner.id = 8;
      if (change === 'graph-renamed') f.child.id = 'different-child';
    };
    const result = await f.run(bridge.applyParametersSource({ updates: [
      { nodeId: 7, widgetName: 'text', value: 'first change' },
      { graphId: 'child', nodeId: 7, widgetName: 'value', value: 20 }
    ] }));
    assert.equal(result.ok, false, change);
    assert.equal(result.needsSnapshot, true, change);
    assert.equal(result.applied, 1, change);
    assert.equal(oldWidget.value, 12, change);
    assert.equal(f.inner.widgets[0].value, change === 'replaced' ? 30 : 12, change);
  }
});

test('callbacks enabling automatic queue stop a batch before its next mutation', async () => {
  const f = fixture();
  f.node.widgets[0].callback = () => { f.app.extensionManager.queueSettings.mode = 'change'; };
  const result = await f.run(bridge.applyParametersSource({ updates: [
    { nodeId: 7, widgetName: 'text', value: 'first change' },
    { graphId: 'child', nodeId: 7, widgetName: 'value', value: 20 }
  ] }));
  assert.equal(result.error?.code, 'AUTO_QUEUE_ENABLED');
  assert.equal(result.applied, 1);
  assert.equal(result.needsSnapshot, true);
  assert.equal(f.inner.widgets[0].value, 12);
});

test('native change-tracker load guard prevents reading an intermediate canvas', async () => {
  const f = fixture();
  class MockChangeTracker { static isLoadingGraph = false; }
  f.active.changeTracker = new MockChangeTracker();
  const name = 'yingzuo-native-loading';
  await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  MockChangeTracker.isLoadingGraph = true;
  for (const source of [
    bridge.getCapabilitiesSource(),
    bridge.snapshotSource({ expectedName: name }),
    bridge.applyParametersSource({ expectedName: name, updates: [{ nodeId: 7, widgetName: 'text', value: 'wrong graph' }] }),
    bridge.setModeSource('graph', name),
    bridge.loadGraphSource({ graph: { nodes: [] }, name })
  ]) assert.equal((await f.run(source)).error?.code, 'NOT_READY');
  assert.equal(f.node.widgets[0].value, 'old');
  MockChangeTracker.isLoadingGraph = false;
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).ok, true);
});

test('modern subgraph widgets receive their own node and return the complete updated root', async () => {
  const f = fixture();
  let calls = 0;
  let legacyCalls = 0;
  f.inner.widgets[0].setValue = function(value, { node, canvas }) {
    assert.equal(node, f.inner);
    assert.equal(canvas, f.app.canvas);
    this.value = value;
    calls++;
  };
  f.inner.widgets[0].callback = () => { legacyCalls++; };
  const result = await f.run(bridge.applyParametersSource({ updates: [{ graphId: 'child', nodeId: 7, widgetName: 'value', value: 42 }] }));
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(legacyCalls, 0); // setValue owns the native callback chain.
  assert.equal(result.graph.nodes[0].widgets_values[0], 'old');
  assert.equal(result.graph.definitions.subgraphs[0].nodes[0].widgets_values[0], 42);
  assert.equal(f.captures(), 1);
});

test('configured App Mode fixture survives graph/app switching without rewriting its configuration', async () => {
  const f = fixture();
  const configured = require('./fixtures/p0-app-mode.json');
  f.root.extra = structuredClone(configured.extra);
  const before = JSON.stringify(f.root.extra);
  const name = 'yingzuo-configured-app';
  const first = await f.run(bridge.loadGraphSource({ graph: configured, name }));
  assert.equal(first.ok, true);
  assert.equal((await f.run(bridge.setModeSource('app', name))).workflow.mode, 'app');
  assert.equal((await f.run(bridge.snapshotSource({ expectedName: name }))).workflow.mode, 'app');
  assert.equal((await f.run(bridge.setModeSource('graph', name))).workflow.mode, 'graph');
  const again = await f.run(bridge.loadGraphSource({ graph: configured, name }));
  assert.equal(again.workflow.path, first.workflow.path);
  assert.equal(again.workflow.documentId, first.workflow.documentId);
  assert.equal((await f.run(bridge.setModeSource('app', name))).ok, true);
  assert.equal(JSON.stringify(f.root.extra), before);
});

test('disabled or ambiguous widgets are absent from the editable form contract', async () => {
  for (const disable of [
    widget => { widget.computedDisabled = true; },
    widget => { widget.options = { disabled: true }; },
    widget => { widget.options = { read_only: true }; },
    (widget, node) => { node.widgets.push({ ...widget }); }
  ]) {
    const f = fixture();
    disable(f.node.widgets[0], f.node);
    const snapshot = await f.run(bridge.snapshotSource());
    assert.ok(snapshot.nodes[0].widgets.every(widget => !widget.editable));
    assert.equal((await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'text', value: 'unsafe' }] }))).error?.code, 'WIDGET_NOT_EDITABLE');
    assert.equal(f.node.widgets[0].value, 'old');
  }
});

test('function-backed combos stay native instead of accepting arbitrary text', async () => {
  const f = fixture();
  let calls = 0;
  f.node.widgets[0] = { name: 'model', type: 'combo', value: 'known', options: { values() { calls++; return ['known']; } } };
  const snapshot = await f.run(bridge.snapshotSource());
  assert.equal(snapshot.nodes[0].widgets[0].editable, false);
  assert.equal((await f.run(bridge.applyParametersSource({ updates: [{ nodeId: 7, widgetName: 'model', value: 'arbitrary' }] }))).error?.code, 'WIDGET_NOT_EDITABLE');
  assert.equal(f.node.widgets[0].value, 'known');
  assert.equal(calls, 0);
});

test('duplicate native identities reject reuse before loading or rebinding the canvas', async () => {
  const f = fixture();
  const name = 'yingzuo-duplicate-native';
  await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }));
  f.store.openWorkflows.push(new Proxy(f.store.activeWorkflow, {}));
  let loads = 0;
  f.app.loadGraphData = async () => { loads++; return true; };
  assert.equal((await f.run(bridge.loadGraphSource({ graph: { nodes: [] }, name }))).error?.code, 'INVALID_WORKFLOW_IDENTITY');
  assert.equal(loads, 0);
});

// Model the actual 1.53.6 gap: clean() empties the root while validation or
// beforeConfigureGraph awaits, with the old activeWorkflow and loading=false.
function nativeLoadFixture() {
  const f=fixture();
  class NativeTracker { static isLoadingGraph=false; captureCanvasState() {} }
  f.active.changeTracker=new NativeTracker();
  const delegate=f.app.loadGraphData;
  const waits=new Map();
  f.app.loadGraphData=async function(graph,clean,restore,target) {
    assert.equal(this,f.app);
    f.root.nodes=[];f.root.id='cleared-root';
    if(waits.has(graph.id))await waits.get(graph.id).promise;
    if(graph.fail)throw new Error('beforeConfigureGraph failed');
    f.root.id=graph.id;f.root.nodes=[f.node];
    f.node.widgets[0].value=graph.text??'loaded';
    return delegate(graph,clean,restore,target);
  };
  f.pause=id=>{let resolve;const promise=new Promise(done=>{resolve=done;});waits.set(id,{promise,resolve});return resolve;};
  f.nativeTarget=id=>({path:`workflows/${id}.json`,activeState:{id},changeTracker:new NativeTracker()});
  return f;
}

test('native load guard covers cleared-root awaits before ChangeTracker marks loading',async()=>{
  const f=nativeLoadFixture(),name='host-full-span';
  assert.equal((await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name}))).ok,true);
  const finish=f.pause('document-b');
  const loading=f.app.loadGraphData({id:'document-b',nodes:[]},true,true,f.nativeTarget('document-b'));
  assert.deepEqual(f.root.nodes,[]);
  assert.equal(f.store.activeWorkflow.changeTracker.constructor.isLoadingGraph,false);
  for(const source of [bridge.snapshotSource({expectedName:name}),bridge.snapshotSource(),bridge.setModeSource('graph',name),bridge.applyParametersSource({expectedName:name,updates:[{nodeId:7,widgetName:'text',value:'unsafe'}]})]){
    const result=await f.run(source);assert.equal(result.error?.code,'NOT_READY');assert.equal(Object.hasOwn(result,'graph'),false);
  }
  finish();await loading;
  assert.equal((await f.run(bridge.snapshotSource({expectedName:name}))).error?.code,'WORKFLOW_CHANGED');
});

test('throwing native loads cannot reauthorize a partial old-document canvas',async()=>{
  const f=nativeLoadFixture(),name='host-failed-native';
  await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name}));
  const owned=f.store.activeWorkflow;
  await assert.rejects(f.app.loadGraphData({id:'document-a',nodes:[],fail:true},true,true,owned),/beforeConfigureGraph/);
  assert.equal(f.store.activeWorkflow,owned);
  assert.equal((await f.run(bridge.snapshotSource({expectedName:name}))).error?.code,'WORKFLOW_CHANGED');
  assert.equal((await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name}))).ok,true);
});

test('successful native same-document undo and redo retain the host binding',async()=>{
  const f=nativeLoadFixture(),name='host-native-undo';
  await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name}));
  const owned=f.store.activeWorkflow,count=f.store.openWorkflows.length;
  for(const text of ['undo prompt','redo prompt']){
    await f.app.loadGraphData({id:'document-a',nodes:[],text},false,false,owned);
    const result=await f.run(bridge.snapshotSource({expectedName:name}));
    assert.equal(result.ok,true);assert.equal(result.workflow.hostName,name);assert.equal(result.graph.nodes[0].widgets_values[0],text);
    assert.equal(f.store.openWorkflows.length,count);
  }
});

test('a final widget callback starting a native load never returns a partial snapshot',async()=>{
  const f=nativeLoadFixture();
  await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name:'host-callback-load'}));
  const finish=f.pause('document-b');let loading;
  f.node.widgets[0].callback=()=>{loading=f.app.loadGraphData({id:'document-b',nodes:[]},true,true,f.nativeTarget('document-b'));};
  const result=await f.run(bridge.applyParametersSource({updates:[{nodeId:7,widgetName:'text',value:'start native load'}]}));
  assert.equal(result.error?.code,'NOT_READY');assert.equal(result.needsSnapshot,true);assert.equal(Object.hasOwn(result,'graph'),false);
  finish();await loading;
});

test('overlapping native loads invalidate a host load even if its document finishes last',async()=>{
  const f=nativeLoadFixture();
  await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name:'host-a'}));
  const finishHost=f.pause('document-b'),finishNative=f.pause('document-c');
  const host=f.run(bridge.loadGraphSource({graph:{id:'document-b',nodes:[]},name:'host-b'}));
  while(f.root.id!=='cleared-root')await Promise.resolve();
  const native=f.app.loadGraphData({id:'document-c',nodes:[]},true,true,f.nativeTarget('document-c'));
  finishNative();await native;finishHost();
  assert.equal((await host).error?.code,'WORKFLOW_CHANGED');
  assert.equal((await f.run(bridge.snapshotSource({expectedName:'host-a'}))).error?.code,'WORKFLOW_CHANGED');
});

test('native API import has the same full-span snapshot protection',async()=>{
  const f=nativeLoadFixture();let finish;
  f.app.loadApiJson=async function(){assert.equal(this,f.app);f.root.nodes=[];await new Promise(resolve=>{finish=resolve;});};
  await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name:'host-api-import'}));
  const loading=f.app.loadApiJson({});
  assert.equal((await f.run(bridge.snapshotSource())).error?.code,'NOT_READY');
  finish();await loading;
  assert.equal((await f.run(bridge.snapshotSource({expectedName:'host-api-import'}))).error?.code,'WORKFLOW_CHANGED');
});

test('replacing an installed native load method invalidates prior canvas authorization',async()=>{
  const f=nativeLoadFixture(),name='host-replaced-loader';
  await f.run(bridge.loadGraphSource({graph:{id:'document-a',nodes:[]},name}));
  f.app.loadGraphData=async()=>true;
  assert.equal((await f.run(bridge.snapshotSource({expectedName:name}))).error?.code,'WORKFLOW_CHANGED');
});
