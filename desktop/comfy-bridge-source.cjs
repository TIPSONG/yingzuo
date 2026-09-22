'use strict';

// This source runs only in the isolated ComfyUI page. No Node or host API is exposed.
function bridgeRuntime(operation, payload, app) {
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const scalar = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  // GraphCanvas publishes window.app only after assigning canvasStore.canvas.
  if (globalThis.app !== app || app?.isGraphReady === false || app?.extensionManager?.spinner === true) return fail('NOT_READY', 'ComfyUI 正在初始化画布或恢复工作流，请稍后重试。');
  const root = app?.rootGraph;
  if (!root || typeof root.serialize !== 'function' || !app.canvas) return fail('NOT_READY', 'ComfyUI 画布尚未就绪。');
  const store = app.extensionManager?.workflow;
  const stateKey = Symbol.for('yingzuo.comfyBridge.v1');
  const state = globalThis[stateKey] ??= { workflows: new Map() };
  const connected = app.api?.socket?.readyState === 1;
  // Pinia can expose the loaded ComfyWorkflow through a Vue Proxy. Its object
  // reference need not equal createNewTemporary's raw return value.
  const documentId = workflow => workflow?.activeState?.id ?? workflow?.initialState?.id;
  const sameWorkflow = (left, right) => !!left && !!right && typeof left.path === 'string' && !!left.path && left.path === right.path && documentId(left) != null && documentId(left) === documentId(right);
  const workflowInfo = () => {
    const active = store?.activeWorkflow;
    let hostName = null;
    for (const [name, workflow] of state.workflows) if (sameWorkflow(workflow, active)) hostName = name;
    return { path: active?.path ?? null, documentId: documentId(active) ?? null, name: active?.key ?? null, hostName, mode: active?.activeMode ?? active?.initialMode ?? 'graph', connected };
  };
  const identityMatches = () => payload.expectedName === undefined || (typeof payload.expectedName === 'string' && state.workflows.has(payload.expectedName) && sameWorkflow(state.workflows.get(payload.expectedName), store?.activeWorkflow));
  const changedWorkflow = () => ({ ...fail('WORKFLOW_CHANGED', 'ComfyUI 当前工作流已改变，请先切回对应标签，再读取或修改。'), workflow: workflowInfo() });
  if (['snapshot', 'parameters', 'mode'].includes(operation) && !identityMatches()) return changedWorkflow();
  const graphs = () => {
    const result = [{ graph: root, graphId: String(root.id ?? 'root'), path: [] }];
    const seen = new Set([root]);
    for (let i = 0; i < result.length && i < 1000; i++) {
      const item = result[i];
      if (!item.graph.subgraphs?.values) continue;
      for (const graph of item.graph.subgraphs.values()) {
        if (!graph || seen.has(graph)) continue;
        seen.add(graph);
        result.push({ graph, graphId: String(graph.id), path: [...item.path, String(graph.id)] });
      }
    }
    return result;
  };
  const editable = (node, widget) => {
    if (!widget || typeof widget.name !== 'string' || !scalar(widget.value) || widget.serialize === false || widget.disabled || widget.options?.read_only) return false;
    if (!['number', 'string', 'text', 'customtext', 'toggle', 'combo'].includes(String(widget.type).toLowerCase())) return false;
    return !(node.inputs ?? []).some(input => (input.widget?.name === widget.name || input.name === widget.name) && input.link != null);
  };
  const describeWidget = (node, widget) => {
    const info = { name: widget.name, type: String(widget.type ?? ''), value: scalar(widget.value) ? widget.value : null, editable: editable(node, widget) };
    const options = {};
    for (const key of ['min', 'max', 'step', 'precision', 'multiline']) if (scalar(widget.options?.[key])) options[key] = widget.options[key];
    if (Array.isArray(widget.options?.values)) {
      options.values = widget.options.values.filter(scalar).slice(0, 500);
      options.valuesTruncated = widget.options.values.length > 500;
    }
    if (Object.keys(options).length) info.options = options;
    return info;
  };
  const snapshot = () => {
    if (!identityMatches()) return changedWorkflow();
    // app.graph can be the visible subgraph. Always serialize the root.
    const graph = JSON.parse(JSON.stringify(root.serialize()));
    const nodes = [];
    let widgetCount = 0;
    let truncated = false;
    for (const item of graphs()) {
      for (const node of item.graph.nodes ?? item.graph._nodes ?? []) {
        if (nodes.length >= 500 || widgetCount >= 2000) { truncated = true; break; }
        const allWidgets = node.widgets ?? [];
        const widgets = allWidgets.slice(0, Math.min(80, 2000 - widgetCount)).map(widget => describeWidget(node, widget));
        widgetCount += widgets.length;
        if (widgets.length !== allWidgets.length) truncated = true;
        nodes.push({ nodeId: node.id, graphId: item.graphId, path: item.path, title: String(node.title ?? node.type ?? node.id), type: String(node.type ?? ''), widgets });
      }
    }
    if (!identityMatches()) return changedWorkflow();
    return { ok: true, graph, nodes, workflow: workflowInfo(), connected, truncated };
  };
  if (operation === 'capabilities') return { ok: true, loadGraph: typeof app.loadGraphData === 'function', snapshot: true, parameters: true, appMode: !!store?.activeWorkflow, workflow: workflowInfo(), connected };
  if (operation === 'snapshot') return snapshot();
  if (operation === 'mode') {
    if (!['graph', 'app'].includes(payload.mode)) return fail('INVALID_MODE', '只支持节点画布和 App Mode。');
    if (!store?.activeWorkflow) return fail('MODE_UNAVAILABLE', '当前前端未提供工作流模式接口。');
    const data = root.extra?.linearData;
    if (payload.mode === 'app' && (!Array.isArray(data?.inputs) || !data.inputs.length || !Array.isArray(data?.outputs) || !data.outputs.length)) return fail('APP_NOT_CONFIGURED', '这个工作流尚未配置 App Mode 输入和输出，请在 ComfyUI 的 App Builder 中配置，或使用启动台参数表单。');
    store.activeWorkflow.activeMode = payload.mode;
    return { ok: true, workflow: workflowInfo() };
  }
  if (operation === 'load') {
    if (!payload.graph || !Array.isArray(payload.graph.nodes) || typeof payload.name !== 'string' || !payload.name || payload.name.length > 300) return fail('INVALID_GRAPH', '需要节点工作流 JSON 和稳定的工作流名称。');
    const hasSavedIdentity = payload.workflowPath !== undefined || payload.documentId !== undefined;
    if (hasSavedIdentity && (typeof payload.workflowPath !== 'string' || !payload.workflowPath || typeof payload.documentId !== 'string' || !payload.documentId)) return fail('INVALID_WORKFLOW_IDENTITY', '恢复标签时必须同时提供完整工作流路径和文档 ID。');
    if (typeof app.loadGraphData !== 'function' || !store || typeof store.createNewTemporary !== 'function') return fail('LOAD_UNAVAILABLE', '当前 ComfyUI 前端不支持可识别身份的工作流加载接口。');
    const existing = state.workflows.get(payload.name);
    let reusable = existing ? store.openWorkflows?.find(workflow => sameWorkflow(existing, workflow)) ?? null : null;
    if (!reusable && hasSavedIdentity) {
      const matches = (store.openWorkflows ?? []).filter(workflow => workflow.path === payload.workflowPath && documentId(workflow) === payload.documentId);
      if (matches.length > 1) return fail('INVALID_WORKFLOW_IDENTITY', '恢复的工作流身份不唯一，请重新选择标签。');
      reusable = matches[0] ?? null;
    }
    const target = reusable ?? store.createNewTemporary(`${payload.name}.json`, payload.graph);
    return app.loadGraphData(payload.graph, true, true, target).then(result => {
      if (result !== true) return fail('LOAD_FAILED', 'ComfyUI 未能加载工作流；请查看画布中的错误信息。');
      if (!sameWorkflow(store.activeWorkflow, target)) return changedWorkflow();
      state.workflows.set(payload.name, store.activeWorkflow);
      payload.expectedName = payload.name;
      return snapshot();
    });
  }
  if (operation === 'parameters') {
    if (app.extensionManager?.queueSettings?.mode !== 'disabled' || app.ui?.autoQueueEnabled === true) return fail('AUTO_QUEUE_ENABLED', '请先在 ComfyUI 运行菜单选择普通“运行”并关闭旧版自动队列；无法确认手动模式时不会回写参数。');
    if (!Array.isArray(payload.updates) || !payload.updates.length || payload.updates.length > 100) return fail('INVALID_UPDATES', '每次需要 1–100 个参数修改。');
    const availableGraphs = graphs();
    const changes = [];
    const targets = new Set();
    for (const update of payload.updates) {
      if (!update || !scalar(update.value) || typeof update.widgetName !== 'string' || (!['number', 'string'].includes(typeof update.nodeId))) return fail('INVALID_VALUE', '参数只允许文本、有限数字或布尔值。');
      const graphMatches = update.graphId == null ? [availableGraphs[0]] : availableGraphs.filter(item => item.graphId === String(update.graphId));
      if (graphMatches.length !== 1) return fail('GRAPH_NOT_FOUND', '子图标识不存在或不唯一，请重新读取参数。');
      const graph = graphMatches[0].graph;
      const nodes = (graph.nodes ?? graph._nodes ?? []).filter(node => String(node.id) === String(update.nodeId));
      if (nodes.length !== 1) return fail('NODE_NOT_FOUND', '节点不存在或不唯一，请重新读取参数。');
      const node = nodes[0];
      const widgets = (node.widgets ?? []).filter(widget => widget.name === update.widgetName);
      if (widgets.length !== 1 || !editable(node, widgets[0])) return fail('WIDGET_NOT_EDITABLE', '该参数已连线、只读或没有安全的表单映射。');
      const widget = widgets[0];
      if (typeof update.value !== typeof widget.value) return fail('TYPE_MISMATCH', '新值与当前参数类型不一致。');
      if (String(widget.type).toLowerCase() === 'combo' && Array.isArray(widget.options?.values) && !widget.options.values.includes(update.value)) return fail('INVALID_OPTION', '所选值不在当前节点的可用选项中。');
      if (targets.has(widget)) return fail('DUPLICATE_UPDATE', '同一参数不能在一次修改中重复出现。');
      targets.add(widget);
      changes.push({ node, widget, value: update.value, oldValue: widget.value });
    }
    let applied = 0;
    try {
      for (const change of changes) {
        if (typeof change.widget.setValue === 'function') change.widget.setValue(change.value, { node: change.node, canvas: app.canvas });
        else {
          change.widget.value = change.value;
          change.widget.callback?.(change.value, app.canvas, change.node, app.canvas.graph_mouse, undefined);
          change.node.onWidgetChanged?.(change.widget.name, change.value, change.oldValue, change.widget);
        }
        applied++;
        if (!identityMatches()) return { ...changedWorkflow(), applied, needsSnapshot: true };
      }
      store?.activeWorkflow?.changeTracker?.captureCanvasState?.();
      app.canvas.setDirty?.(true, true);
    } catch (error) {
      // A third-party widget callback may already have changed other state.
      return { ok: false, error: { code: 'APPLY_FAILED', message: String(error?.message ?? error) }, applied, needsSnapshot: true };
    }
    return { ...snapshot(), applied };
  }
  return fail('UNKNOWN_OPERATION', '不支持的桥接操作。');
}

function source(operation, payload = {}) {
  const encoded = JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  // Importing the shim before its global is published permanently caches a failed module.
  // Return a retryable readiness result without evaluating that module at all.
  return `(async () => { try { if (!globalThis.comfyAPI?.app?.app) return { ok: false, error: { code: 'NOT_READY', message: 'ComfyUI 前端仍在初始化，请稍后重试。' } }; const { app } = await import('/scripts/app.js'); return await (${bridgeRuntime.toString()})(${JSON.stringify(operation)}, ${encoded}, app); } catch (error) { return { ok: false, error: { code: 'BRIDGE_FAILED', message: String(error?.message ?? error) } }; } })()`;
}

module.exports = {
  getCapabilitiesSource: () => source('capabilities'),
  loadGraphSource: ({ graph, name, workflowPath, documentId }) => source('load', { graph, name, workflowPath, documentId }),
  snapshotSource: ({ expectedName } = {}) => source('snapshot', { expectedName }),
  applyParametersSource: ({ updates, expectedName }) => source('parameters', { updates, expectedName }),
  setModeSource: (mode, expectedName) => source('mode', { mode, expectedName })
};
