'use strict';
// E01：Comfy Editor Adapter。所有对 ComfyUI 前端的读写都经过这里；
// 修改必须携带 tabId + expectedRevision + nativeIdentity，任一不符即拒绝串写。
const {AppError, CODES} = require('../core/errors.cjs');
const TESTED_FRONTEND = ['1.53.6'];

/** 根据前端能力给出具体限制，而不是笼统“不兼容”。 */
function describeCapabilities(raw) {
  const limits = [];
  if (!raw?.loadGraph) limits.push({feature: 'load', message: '前端缺少 loadGraphData，无法加载工作副本。', blocking: true});
  if (!raw?.compile) limits.push({feature: 'compile', message: '前端缺少 graphToPrompt，无法从应用运行或编译任务；仍可在原生画布中运行。', blocking: false});
  if (!raw?.appMode) limits.push({feature: 'appMode', message: '前端未提供工作流模式接口，App Mode 不可用，改用参数表单。', blocking: false});
  if (!raw?.focusNode) limits.push({feature: 'focus', message: '前端不能定位节点，错误清单只显示节点编号。', blocking: false});
  const version = raw?.frontendVersion ?? null;
  if (version && !TESTED_FRONTEND.includes(version)) limits.push({feature: 'version', message: `前端版本 ${version} 未经映作验证（已验证：${TESTED_FRONTEND.join(', ')}），功能以运行时检测为准。`, blocking: false});
  if (!version) limits.push({feature: 'version', message: '无法读取前端版本号。', blocking: false});
  return {frontendVersion: version, features: {load: !!raw?.loadGraph, snapshot: !!raw?.snapshot, parameters: !!raw?.parameters, appMode: !!raw?.appMode, compile: !!raw?.compile, focus: !!raw?.focusNode}, limits, usable: !limits.some(l => l.blocking)};
}
/** binding（scopePath+nodeId+fieldName）→ 桥接 update（graphId+nodeId+widgetName）。 */
function bindingToUpdate(binding, value) {
  if (!binding || typeof binding.nodeId !== 'string' || typeof binding.fieldName !== 'string' || !Array.isArray(binding.scopePath)) throw new AppError(CODES.INVALID_ARGUMENT, '参数绑定不完整。');
  return {nodeId: binding.nodeId, graphId: binding.scopePath.length ? binding.scopePath.at(-1) : null, widgetName: binding.fieldName, value};
}
class ComfyEditorAdapter {
  /** execute(source) 在 ComfyUI 视图执行桥接；session 提供 tab 状态。 */
  constructor({execute, bridge, getTab}) { this.execute = execute; this.bridge = bridge; this.getTab = getTab; }
  async getCapabilities() { return describeCapabilities(await this.execute(this.bridge.getCapabilitiesSource())); }
  _guard({tabId, expectedRevision, nativeIdentity}) {
    const tab = this.getTab(tabId);
    if (!tab) throw new AppError(CODES.NOT_FOUND, '标签不存在。');
    if (expectedRevision !== tab.revision) throw new AppError(CODES.REVISION_MISMATCH, '标签版本已变化，已拒绝写入。', {details: {expected: expectedRevision, actual: tab.revision}});
    const host = `yingzuo-${tab.id}`;
    if (!nativeIdentity || nativeIdentity.hostName !== host || (tab.documentId && nativeIdentity.documentId !== tab.documentId)) throw new AppError(CODES.IDENTITY_MISMATCH, '原生工作流身份不匹配，已拒绝写入。');
    return {tab, expectedName: host};
  }
  load(tab) { return this.execute(this.bridge.loadGraphSource({graph: tab.graph, name: `yingzuo-${tab.id}`, workflowPath: tab.workflowPath, documentId: tab.documentId, viewport: tab.viewport ?? undefined})); }
  snapshotRoot(tabId) { return this.execute(this.bridge.snapshotSource({expectedName: `yingzuo-${tabId}`})); }
  applyBindings(guard, entries) {
    const {expectedName} = this._guard(guard);
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new AppError(CODES.INVALID_ARGUMENT, '每次需要 1–100 个参数。');
    return this.execute(this.bridge.applyParametersSource({updates: entries.map(e => bindingToUpdate(e.binding, e.value)), expectedName}));
  }
  setMode(guard, mode) { const {expectedName} = this._guard(guard); return this.execute(this.bridge.setModeSource(mode, expectedName)); }
  focusNode(tabId, scopePath, nodeId) { return this.execute(this.bridge.focusNodeSource({expectedName: `yingzuo-${tabId}`, scopePath, nodeId: String(nodeId)})); }
  compileSnapshot(tabId) { return this.execute(this.bridge.compileSource({expectedName: `yingzuo-${tabId}`})); }
}
module.exports = {ComfyEditorAdapter, describeCapabilities, bindingToUpdate, TESTED_FRONTEND};
