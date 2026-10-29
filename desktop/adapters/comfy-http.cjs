'use strict';
// Q02：ComfyUI HTTP / WebSocket 客户端。只调用文档化路由，并在运行时探测能力；
// 不修改全局队列来迁就本应用（不清空、不插队）。
const {AppError, CODES} = require('../core/errors.cjs');

class ComfyHttpClient {
  constructor(baseUrl, {fetchImpl = fetch, timeoutMs = 15000} = {}) { this.base = new URL(baseUrl); this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.caps = null; }
  url(route, query) { const u = new URL(route.replace(/^\//, ''), this.base); if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v)); return u; }
  async request(route, {method = 'GET', json, body, headers = {}, query, timeoutMs = this.timeoutMs, raw = false, signal} = {}) {
    let response;
    try {
      response = await this.fetch(this.url(route, query), {method, headers: json !== undefined ? {'content-type': 'application/json', ...headers} : headers, body: json !== undefined ? JSON.stringify(json) : body, signal: signal ?? AbortSignal.timeout(timeoutMs)});
    } catch (error) { throw new AppError(CODES.NETWORK, `无法连接 ComfyUI（${route}）：${error.message}`, {cause: error}); }
    if (raw) return response;
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!response.ok) throw new AppError(CODES.HTTP, `ComfyUI ${route} 返回 HTTP ${response.status}`, {details: {status: response.status, body: data ?? text.slice(0, 2000)}, retryable: response.status >= 500});
    return data;
  }
  /** 能力探测：通过实际存在的路由与 system_stats 版本判断。 */
  async capabilities() {
    const stats = await this.request('system_stats');
    const version = stats?.system?.comfyui_version ?? null;
    const has = async route => { try { const r = await this.request(route, {raw: true, timeoutMs: 5000}); return r.status !== 404; } catch { return false; } };
    const [objectInfo, queue, history, models] = await Promise.all([has('object_info/KSampler'), has('queue'), has('history?max_items=1'), has('models')]);
    // 客户端 prompt_id 与目标 interrupt：不按版本号猜。提交时总是附带 UUID 形式的 prompt_id，
    // 以返回值是否一致判断服务端是否采纳；取消前总是先核对 /queue 中正在运行的就是目标。
    this.caps = {version, objectInfo, queue, history, models};
    return this.caps;
  }
  systemStats() { return this.request('system_stats'); }
  objectInfo(nodeClass) { return this.request(nodeClass ? `object_info/${encodeURIComponent(nodeClass)}` : 'object_info', {timeoutMs: 60000}); }
  models(folder) { return this.request(folder ? `models/${encodeURIComponent(folder)}` : 'models'); }
  queue() { return this.request('queue'); }
  history(promptId) { return this.request(promptId ? `history/${encodeURIComponent(promptId)}` : 'history', {query: promptId ? undefined : {max_items: 64}}); }
  /** 提交 prompt。requestId 写入 extra_data 供断连后核对；clientPromptId 仅在支持时附带。 */
  async submit({prompt, clientId, requestId, promptId, extraData = {}}) {
    const body = {prompt, client_id: clientId, extra_data: {...extraData, yingzuo: {requestId}}};
    if (promptId) body.prompt_id = promptId;
    try { return await this.request('prompt', {method: 'POST', json: body, timeoutMs: 30000}); }
    catch (error) {
      if (error.code === 'HTTP' && error.details?.status === 400) {
        const b = error.details.body || {};
        throw new AppError(CODES.INVALID_ARGUMENT, b.error?.message || '工作流校验失败。', {details: {error: b.error, nodeErrors: b.node_errors ?? {}}});
      }
      throw error;
    }
  }
  /** 上传图片（multipart）。返回后端实际保存的 {name, subfolder, type}。 */
  async uploadImage({buffer, filename, subfolder = '', type = 'input', overwrite = false, mime = 'application/octet-stream'}) {
    const form = new FormData();
    form.append('image', new Blob([buffer], {type: mime}), filename);
    if (subfolder) form.append('subfolder', subfolder);
    form.append('type', type);
    form.append('overwrite', overwrite ? 'true' : 'false');
    const r = await this.request('upload/image', {method: 'POST', body: form, timeoutMs: 120000});
    if (!r?.name) throw new AppError(CODES.HTTP, '上传接口没有返回文件名。');
    return {name: r.name, subfolder: r.subfolder ?? '', type: r.type ?? type};
  }
  view({filename, subfolder = '', type = 'output'}) { return this.request('view', {query: {filename, subfolder, type}, raw: true, timeoutMs: 120000}); }
  deleteQueued(promptIds) { return this.request('queue', {method: 'POST', json: {delete: promptIds}}); }
  /** D10：探测按任务取消接口（/api/jobs/{id}/cancel，服务端原子判断只中断仍在运行的该任务）。结果按实例缓存。 */
  async jobCancelSupported() {
    if (this._jobCancel !== undefined) return this._jobCancel;
    try { const r = await this.request('api/jobs', {query: {limit: 1}, raw: true, timeoutMs: 5000}); this._jobCancel = r.status === 200; } catch { this._jobCancel = false; }
    return this._jobCancel;
  }
  async cancelJob(promptId) { const r = await this.request(`api/jobs/${encodeURIComponent(promptId)}/cancel`, {method: 'POST', json: {}}); return {cancelled: r?.cancelled === true}; }
  interrupt(promptId) { return this.request('interrupt', {method: 'POST', json: promptId ? {prompt_id: promptId} : {}}); }
  free(options = {unload_models: true, free_memory: true}) { return this.request('free', {method: 'POST', json: options}); }
}

/** 解析 /queue：[number, prompt_id, prompt, extra_data, outputs] */
function parseQueue(q) {
  const item = row => ({number: row[0], promptId: row[1], extraData: row[3] ?? {}, requestId: row[3]?.yingzuo?.requestId ?? null, clientId: row[3]?.client_id ?? null});
  return {running: (q?.queue_running ?? []).map(item), pending: (q?.queue_pending ?? []).map(item)};
}
/** history 条目 → 终态与输出 */
function parseHistoryEntry(entry) {
  if (!entry) return null;
  const status = entry.status ?? {};
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const errorMsg = messages.find(m => m[0] === 'execution_error');
  const interrupted = messages.find(m => m[0] === 'execution_interrupted');
  const cached = messages.find(m => m[0] === 'execution_cached')?.[1]?.nodes ?? [];
  const outputs = [];
  for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
    for (const img of out.images ?? []) outputs.push({kind: 'image', nodeId, filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output'});
    for (const key of ['text', 'string', 'STRING']) for (const t of [].concat(out[key] ?? [])) if (typeof t === 'string') outputs.push({kind: 'text', nodeId, text: t});
    for (const g of out.gifs ?? []) outputs.push({kind: 'video', nodeId, filename: g.filename, subfolder: g.subfolder ?? '', type: g.type ?? 'output'});
  }
  let state = null;
  if (status.status_str === 'success' || (status.completed === true && !errorMsg)) state = 'succeeded';
  if (status.status_str === 'error' || errorMsg) state = interrupted ? 'cancelled' : 'failed';
  if (interrupted) state = 'cancelled';
  const error = errorMsg ? {nodeId: errorMsg[1]?.node_id ?? null, nodeType: errorMsg[1]?.node_type ?? null, message: errorMsg[1]?.exception_message ?? '执行出错', exceptionType: errorMsg[1]?.exception_type ?? null, traceback: (errorMsg[1]?.traceback ?? []).slice(-12)} : null;
  return {state, completed: status.completed === true, outputs, error, cachedNodes: cached, requestId: entry.prompt?.[3]?.yingzuo?.requestId ?? null};
}
/** 把 400 node_errors 转为节点级错误清单 */
function nodeErrorList(nodeErrors = {}) {
  return Object.entries(nodeErrors).flatMap(([nodeId, e]) => (e.errors ?? [{message: e.message ?? '节点错误'}]).map(x => ({nodeId, nodeType: e.class_type ?? null, message: x.message, details: x.details ?? null, input: x.extra_info?.input_name ?? null})));
}

/** WebSocket 事件订阅，按 prompt_id 分发；断线指数退避重连。 */
class ComfySocket {
  constructor(baseUrl, clientId, {WebSocketImpl = globalThis.WebSocket, onEvent = () => {}, onState = () => {}, maxDelayMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {clientId, WebSocketImpl, onEvent, onState, maxDelayMs, setTimer, clearTimer});
    const u = new URL('ws', baseUrl); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; u.searchParams.set('clientId', clientId); this.url = u.href;
    this.attempt = 0; this.closed = false; this.ws = null; this.timer = null;
  }
  open() {
    if (this.closed || !this.WebSocketImpl) return;
    try { this.ws = new this.WebSocketImpl(this.url); } catch (e) { this.schedule(); return; }
    this.ws.onopen = () => { this.attempt = 0; this.onState({connected: true}); };
    this.ws.onmessage = msg => { if (typeof msg.data !== 'string') return; let d; try { d = JSON.parse(msg.data); } catch { return; } this.onEvent(d); };
    this.ws.onclose = () => { this.onState({connected: false}); this.schedule(); };
    this.ws.onerror = () => { /* onclose 会跟随 */ };
  }
  schedule() { if (this.closed) return; const delay = Math.min(this.maxDelayMs, 500 * 2 ** this.attempt++); this.timer = this.setTimer(() => this.open(), delay); this.onState({connected: false, retryInMs: delay}); }
  close() { this.closed = true; this.clearTimer(this.timer); try { this.ws?.close(); } catch { /* 忽略 */ } }
}
module.exports = {ComfyHttpClient, ComfySocket, parseQueue, parseHistoryEntry, nodeErrorList};
