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
  const documentId = workflow => workflow?.activeState?.id ?? workflow?.initialState?.id;
  const stateKey = Symbol.for('yingzuo.comfyBridge.v3');
  const state = globalThis[stateKey] ??= { workflows: new Map(), loading: false, canvasBound: true, nativeLoads: 0, nativeEpoch: 0, guardedMethods: new Map() };
  // In frontend 1.53.6 loadGraphData clears the root BEFORE several awaits and
  // before ChangeTracker.isLoadingGraph becomes true. Cover the whole public
  // load call, including calls made by the native UI, not just the host bridge.
  // These guards are session-local; no installed frontend files are modified.
  for (const method of ['loadGraphData', 'loadApiJson']) {
    if (typeof app[method] !== 'function') continue;
    const installed = state.guardedMethods.get(method);
    if (app[method] === installed) continue;
    if (installed) state.canvasBound = false;
    const original = app[method];
    const guarded = function (...args) {
      const wasBound=state.canvasBound;
      const previous=store?.activeWorkflow;
      const previousPath=previous?.path, previousId=documentId(previous);
      state.nativeLoads++;const epoch=++state.nativeEpoch;state.canvasBound=false;
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { state.nativeLoads--;throw error; }
      return Promise.resolve(result).then(value => {
        // Native undo/redo reloads the same document. Restore its existing host
        // binding only after a complete, successful, non-overlapping reload.
        if (value === true && wasBound && method === 'loadGraphData' && state.nativeLoads === 1 && state.nativeEpoch === epoch && previousId != null && args[0]?.id === previousId && args[3]?.path === previousPath && documentId(args[3]) === previousId && store?.activeWorkflow?.path === previousPath && documentId(store.activeWorkflow) === previousId && app.rootGraph?.id === previousId) state.canvasBound=true;
        return value;
      }).finally(() => { state.nativeLoads--; });
    };
    app[method] = guarded;
    if (app[method] !== guarded) return fail('LOAD_GUARD_UNAVAILABLE', '无法保护原生工作流加载过程，暂不读取或修改画布。');
    state.guardedMethods.set(method, guarded);
  }
  const nativeLoading = () => state.nativeLoads > 0 || store?.activeWorkflow?.changeTracker?.constructor?.isLoadingGraph === true;
  if (nativeLoading()) return fail('NOT_READY', 'ComfyUI 正在恢复原生工作流，请稍后重试。');
  if (state.loading) return fail('NOT_READY', 'ComfyUI 正在切换工作流，请等待加载完成。');
  const connected = app.api?.socket?.readyState === 1;
  // Pinia can expose the loaded ComfyWorkflow through a Vue Proxy. Its object
  // reference need not equal createNewTemporary's raw return value.
  const sameWorkflow = (left, right) => !!left && !!right && typeof left.path === 'string' && !!left.path && left.path === right.path && documentId(left) != null && documentId(left) === documentId(right);
  // Keep the document ID by value: native reloads can replace activeState on
  // the same ComfyWorkflow object. Keep its path live to allow native renames.
  const bindWorkflow = workflow => ({ workflow, documentId: documentId(workflow) });
  const matchesBinding = (binding, workflow) => !!binding && binding.documentId != null && binding.documentId === documentId(workflow) && sameWorkflow(binding.workflow, workflow);
  const workflowInfo = () => {
    const active = store?.activeWorkflow;
    let hostName = null;
    if (state.canvasBound) for (const [name, binding] of state.workflows) if (matchesBinding(binding, active)) hostName = name;
    return { path: active?.path ?? null, documentId: documentId(active) ?? null, name: active?.key ?? null, hostName, mode: active?.activeMode ?? active?.initialMode ?? 'graph', connected };
  };
  const identityMatches = () => payload.expectedName === undefined || (state.canvasBound && typeof payload.expectedName === 'string' && matchesBinding(state.workflows.get(payload.expectedName), store?.activeWorkflow));
  const changedWorkflow = () => ({ ...fail('WORKFLOW_CHANGED', 'ComfyUI 当前工作流已改变，请先切回对应标签，再读取或修改。'), workflow: workflowInfo() });
  if (['compile', 'focus'].includes(operation) && typeof payload.expectedName !== 'string') return fail('IDENTITY_REQUIRED', '编译与定位必须指定标签身份。');
  if (['snapshot', 'parameters', 'mode', 'compile', 'focus'].includes(operation) && !identityMatches()) return changedWorkflow();
  if (['parameters', 'mode'].includes(operation) && !state.canvasBound) return changedWorkflow();
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
    if (!widget || typeof widget.name !== 'string' || !scalar(widget.value) || widget.serialize === false || widget.disabled || widget.computedDisabled || widget.options?.disabled || widget.options?.read_only) return false;
    const type = String(widget.type).toLowerCase();
    if (!['number', 'string', 'text', 'customtext', 'toggle', 'combo'].includes(type)) return false;
    // Dynamic/function-backed combos need their native UI. Presenting them as
    // free text would silently bypass the node's available-options constraint.
    if (type === 'combo' && !Array.isArray(widget.options?.values)) return false;
    if ((node.widgets ?? []).filter(other => other.name === widget.name).length !== 1) return false;
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
    if (nativeLoading()) return fail('NOT_READY', 'ComfyUI 正在恢复原生工作流，请稍后重试。');
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
    if (nativeLoading()) return fail('NOT_READY', 'ComfyUI 正在恢复原生工作流，请稍后重试。');
    if (!identityMatches()) return changedWorkflow();
    const ds = app.canvas?.ds;
    const viewport = ds && Number.isFinite(ds.scale) && ds.offset && Number.isFinite(ds.offset[0]) && Number.isFinite(ds.offset[1]) ? { scale: ds.scale, offset: [ds.offset[0], ds.offset[1]] } : null;
    return { ok: true, graph, nodes, workflow: workflowInfo(), connected, truncated, viewport };
  };
  if (operation === 'capabilities') return { ok: true, loadGraph: typeof app.loadGraphData === 'function', snapshot: true, parameters: true, appMode: !!store?.activeWorkflow, compile: typeof app.graphToPrompt === 'function', focusNode: typeof app.canvas?.centerOnNode === 'function' || typeof app.canvas?.selectNode === 'function', frontendVersion: typeof globalThis.__COMFYUI_FRONTEND_VERSION__ === 'string' ? globalThis.__COMFYUI_FRONTEND_VERSION__ : null, workflow: workflowInfo(), connected };
  if (operation === 'compile') {
    // E09：使用当前前端官方 graphToPrompt 生成 API prompt，不按 widget 序号猜连接。
    if (typeof app.graphToPrompt !== 'function') return fail('COMPILE_UNAVAILABLE', '当前 ComfyUI 前端没有 graphToPrompt，无法编译。');
    if (!identityMatches() || !state.canvasBound) return changedWorkflow();
    return Promise.resolve(app.graphToPrompt()).then(result => {
      if (!identityMatches()) return changedWorkflow();
      if (!result || typeof result.output !== 'object') return fail('COMPILE_FAILED', '前端未返回 API prompt。');
      return { ok: true, prompt: JSON.parse(JSON.stringify(result.output)), workflow: JSON.parse(JSON.stringify(result.workflow ?? root.serialize())) };
    }, error => fail('COMPILE_FAILED', String(error?.message ?? error)));
  }
  if (operation === 'convertApi') {
    // E05：在本标签已绑定的原生工作流里调用官方 loadApiJson，完成后重新绑定同一文档。
    if (typeof app.loadApiJson !== 'function') return fail('CONVERT_UNAVAILABLE', '当前 ComfyUI 前端没有 loadApiJson，无法把 API 格式转换为可视图；原文件已保留。');
    if (typeof payload.expectedName !== 'string' || !identityMatches() || !state.canvasBound) return changedWorkflow();
    const binding = state.workflows.get(payload.expectedName);
    state.loading = true;
    return Promise.resolve().then(() => app.loadApiJson(payload.prompt, payload.fileName || 'api.json')).then(() => {
      if (!matchesBinding(binding, store?.activeWorkflow)) return changedWorkflow();
      state.canvasBound = true;
      return snapshot();
    }, error => fail('CONVERT_FAILED', String(error?.message ?? error))).finally(() => { state.loading = false; });
  }
  if (operation === 'focus') {
    if (!identityMatches()) return changedWorkflow();
    const scope = Array.isArray(payload.scopePath) ? payload.scopePath.map(String) : [];
    const item = graphs().find(g => g.path.length === scope.length && g.path.every((x, i) => x === scope[i]));
    if (!item) return fail('GRAPH_NOT_FOUND', '找不到该子图。');
    const node = (item.graph.nodes ?? item.graph._nodes ?? []).find(n => String(n.id) === String(payload.nodeId));
    if (!node) return fail('NODE_NOT_FOUND', '节点不存在。');
    if (scope.length || (app.canvas.graph ?? app.graph) !== item.graph) {
      if (typeof app.canvas.setGraph === 'function') app.canvas.setGraph(item.graph);
      else return fail('SUBGRAPH_NAVIGATION_UNAVAILABLE', '当前前端不能切换到目标画布，请手动进入对应画布后查看。');
    }
    app.canvas.selectNode?.(node);
    app.canvas.centerOnNode?.(node);
    app.canvas.setDirty?.(true, true);
    return { ok: true };
  }
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
    const existingMatches = existing ? (store.openWorkflows ?? []).filter(workflow => matchesBinding(existing, workflow)) : [];
    if (existingMatches.length > 1) return fail('INVALID_WORKFLOW_IDENTITY', '工作流身份不唯一，请重新选择标签。');
    let reusable = existingMatches[0] ?? null;
    if (!reusable && hasSavedIdentity) {
      const matches = (store.openWorkflows ?? []).filter(workflow => workflow.path === payload.workflowPath && documentId(workflow) === payload.documentId);
      if (matches.length > 1) return fail('INVALID_WORKFLOW_IDENTITY', '恢复的工作流身份不唯一，请重新选择标签。');
      reusable = matches[0] ?? null;
    }
    const target = reusable ?? store.createNewTemporary(`${payload.name}.json`, payload.graph);
    for (const [name, binding] of state.workflows) {
      if (name !== payload.name && matchesBinding(binding, target)) return fail('INVALID_WORKFLOW_IDENTITY', '该原生工作流已经属于另一个桌面标签，不能作为独立副本复用。');
    }
    // createNewTemporary returns an unloaded object in frontend 1.53.6; its
    // change tracker and document ID are only assigned by loadGraphData.
    const targetBinding = documentId(target) == null ? null : bindWorkflow(target);
    // Loading clears/configures the canvas before it resolves. A failed load
    // must not leave that partial canvas authorized as the previous document.
    // Retain the document bindings only for reuse on a subsequent safe retry.
    state.loading = true;
    state.canvasBound = false;
    let expectedEpoch;
    return Promise.resolve().then(() => {
      expectedEpoch=state.nativeEpoch+1;
      return app.loadGraphData(payload.graph, true, true, target);
    }).then(result => {
      if (nativeLoading() || state.nativeEpoch !== expectedEpoch) return changedWorkflow();
      if (result !== true) return fail('LOAD_FAILED', 'ComfyUI 未能加载工作流；请查看画布中的错误信息。');
      if (targetBinding ? !matchesBinding(targetBinding, store.activeWorkflow) : !sameWorkflow(store.activeWorkflow, target)) return changedWorkflow();
      state.workflows.set(payload.name, bindWorkflow(store.activeWorkflow));
      state.canvasBound = true;
      payload.expectedName = payload.name;
      const v = payload.viewport;
      if (v && app.canvas?.ds && Number.isFinite(v.scale) && Array.isArray(v.offset)) { app.canvas.ds.scale = v.scale; app.canvas.ds.offset[0] = v.offset[0]; app.canvas.ds.offset[1] = v.offset[1]; app.canvas.setDirty?.(true, true); }
      return snapshot();
    }).finally(() => { state.loading = false; });
  }
  if (operation === 'parameters') {
    const manualQueue = () => app.extensionManager?.queueSettings?.mode === 'disabled' && app.ui?.autoQueueEnabled !== true;
    const autoQueue = () => fail('AUTO_QUEUE_ENABLED', '请先在 ComfyUI 运行菜单选择普通“运行”并关闭旧版自动队列；无法确认手动模式时不会回写参数。');
    if (!manualQueue()) return autoQueue();
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
      changes.push({ graph, graphId: graphMatches[0].graphId, node, nodeId: String(node.id), widget, widgetName: update.widgetName, value: update.value, oldValue: widget.value });
    }
    let applied = 0;
    try {
      for (const change of changes) {
        // Extension callbacks can change queue mode, remove nodes, replace
        // widgets or connect inputs. Recheck each target just before mutation.
        if (!identityMatches()) return { ...changedWorkflow(), applied, needsSnapshot: true };
        if (nativeLoading()) return { ...fail('NOT_READY', 'ComfyUI 正在恢复原生工作流，请稍后重试。'), applied, needsSnapshot: true };
        if (!manualQueue()) return { ...autoQueue(), applied, needsSnapshot: true };
        const currentGraphs = graphs().filter(item => item.graph === change.graph && item.graphId === change.graphId);
        const currentNodes = (change.graph.nodes ?? change.graph._nodes ?? []).filter(node => String(node.id) === change.nodeId);
        const currentWidgets = (change.node.widgets ?? []).filter(widget => widget.name === change.widgetName);
        if (currentGraphs.length !== 1 || currentNodes.length !== 1 || currentNodes[0] !== change.node || currentWidgets.length !== 1 || currentWidgets[0] !== change.widget || !editable(change.node, change.widget) || typeof change.value !== typeof change.widget.value) {
          return { ...fail('WIDGET_NOT_EDITABLE', '参数映射在修改期间发生变化，请重新读取参数。'), applied, needsSnapshot: true };
        }
        if (String(change.widget.type).toLowerCase() === 'combo' && Array.isArray(change.widget.options?.values) && !change.widget.options.values.includes(change.value)) return { ...fail('INVALID_OPTION', '可用选项在修改期间发生变化，请重新读取参数。'), applied, needsSnapshot: true };
        if (typeof change.widget.setValue === 'function') change.widget.setValue(change.value, { node: change.node, canvas: app.canvas });
        else {
          change.widget.value = change.value;
          change.widget.callback?.(change.value, app.canvas, change.node, app.canvas.graph_mouse, undefined);
          change.node.onWidgetChanged?.(change.widget.name, change.value, change.oldValue, change.widget);
        }
        applied++;
        if (nativeLoading()) return { ...fail('NOT_READY', 'ComfyUI 正在恢复原生工作流，请稍后重试。'), applied, needsSnapshot: true };
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
  loadGraphSource: ({ graph, name, workflowPath, documentId, viewport }) => source('load', { graph, name, workflowPath, documentId, viewport }),
  compileSource: ({ expectedName }) => source('compile', { expectedName }),
  convertApiSource: ({ expectedName, prompt, fileName }) => source('convertApi', { expectedName, prompt, fileName }),
  focusNodeSource: ({ expectedName, scopePath, nodeId }) => source('focus', { expectedName, scopePath, nodeId }),
  snapshotSource: ({ expectedName } = {}) => source('snapshot', { expectedName }),
  applyParametersSource: ({ updates, expectedName }) => source('parameters', { updates, expectedName }),
  setModeSource: (mode, expectedName) => source('mode', { mode, expectedName })
};
