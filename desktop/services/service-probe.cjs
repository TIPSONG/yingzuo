'use strict';
// S02：分别检测 ComfyUI 端口可达、身份正确、WebSocket；LM Studio API、模型清单、已加载实例。
const net = require('node:net');
const {AppError, CODES} = require('../core/errors.cjs');

function checkPort(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({host: host.replace(/^\[|\]$/g, ''), port});
    const done = (ok, error) => { socket.destroy(); resolve({reachable: ok, error: error || null}); };
    socket.setTimeout(timeoutMs, () => done(false, '连接超时'));
    socket.once('connect', () => done(true));
    socket.once('error', e => done(false, e.code === 'ECONNREFUSED' ? '端口未监听（服务未运行）' : e.message));
  });
}
async function getJson(fetchImpl, url, timeoutMs = 4000) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs)});
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return {status: response.status, ok: response.ok, json, text: text.slice(0, 500)};
}
function checkWebSocket(WebSocketImpl, url, timeoutMs = 4000) {
  if (!WebSocketImpl) return Promise.resolve({ok: false, error: '运行环境没有 WebSocket 实现'});
  return new Promise(resolve => {
    let ws; const timer = setTimeout(() => { try { ws?.close(); } catch { /* 忽略 */ } resolve({ok: false, error: '握手超时'}); }, timeoutMs);
    try { ws = new WebSocketImpl(url); } catch (e) { clearTimeout(timer); resolve({ok: false, error: e.message}); return; }
    ws.onopen = () => { clearTimeout(timer); try { ws.close(); } catch { /* 忽略 */ } resolve({ok: true}); };
    ws.onerror = e => { clearTimeout(timer); resolve({ok: false, error: e?.message || 'WebSocket 握手失败'}); };
  });
}
/** 是否像 ComfyUI 的 /system_stats 响应。 */
function looksLikeComfy(stats) { return !!stats && typeof stats === 'object' && stats.system && typeof stats.system === 'object' && Array.isArray(stats.devices); }

async function probeComfy(baseUrl, {fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, portCheck = checkPort, editorReady = null} = {}) {
  const url = new URL(baseUrl);
  const result = {url: url.href, checkedAt: new Date().toISOString(), port: null, identity: null, editor: editorReady, websocket: null, summary: 'offline'};
  const port = Number(url.port || 80);
  result.port = await portCheck(url.hostname, port);
  if (!result.port.reachable) { result.summary = 'offline'; return result; }
  try {
    const r = await getJson(fetchImpl, new URL('system_stats', url));
    if (r.ok && looksLikeComfy(r.json)) {
      const sys = r.json.system;
      result.identity = {ok: true, comfyuiVersion: sys.comfyui_version ?? null, pythonVersion: sys.python_version ?? null, pytorchVersion: sys.pytorch_version ?? null, embeddedPython: sys.embedded_python ?? null, argv: Array.isArray(sys.argv) ? sys.argv.slice(0, 40) : null, devices: r.json.devices.map(d => ({name: d.name, type: d.type, vramTotal: d.vram_total, vramFree: d.vram_free}))};
    } else result.identity = {ok: false, error: `端口 ${port} 已被其他程序占用（/system_stats 返回 HTTP ${r.status}，不是 ComfyUI）。`};
  } catch (e) { result.identity = {ok: false, error: `端口可连接但 HTTP 无响应：${e.message}`}; }
  if (!result.identity.ok) { result.summary = 'port-occupied'; return result; }
  const wsUrl = new URL('ws', url); wsUrl.protocol = 'ws:'; wsUrl.searchParams.set('clientId', 'yingzuo-probe');
  result.websocket = await checkWebSocket(WebSocketImpl, wsUrl.href);
  result.summary = result.websocket.ok ? 'ready' : 'degraded';
  return result;
}

/** LM Studio：API（/v1/models）、可用模型；已加载实例需 lms CLI（lms ps --json）。 */
async function probeLmStudio(baseUrl, {fetchImpl = fetch, portCheck = checkPort, cli = null} = {}) {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const result = {url: url.href, checkedAt: new Date().toISOString(), app: null, api: null, models: null, loaded: null, summary: 'offline'};
  if (cli) {
    result.app = cli.available ? {ok: true, cliPath: cli.path, version: cli.version ?? null} : {ok: false, error: cli.error ?? '未找到 lms CLI'};
  } else result.app = {ok: false, error: '未配置 lms CLI 路径，无法检测应用状态。'};
  const port = await portCheck(url.hostname, Number(url.port || 80));
  if (!port.reachable) { result.api = {ok: false, error: `API 服务未运行（${port.error}）`}; result.summary = result.app.ok ? 'app-only' : 'offline'; }
  else {
    try {
      const r = await getJson(fetchImpl, new URL('models', url));
      if (r.ok && Array.isArray(r.json?.data)) {
        result.api = {ok: true};
        result.models = r.json.data.map(m => ({id: m.id, object: m.object ?? null}));
      } else result.api = {ok: false, error: `端口被占用或不是 LM Studio API（HTTP ${r.status}）。`};
    } catch (e) { result.api = {ok: false, error: e.message}; }
  }
  if (cli?.available && cli.listLoaded) {
    try { result.loaded = await cli.listLoaded(); } catch (e) { result.loaded = {error: e.message}; }
  }
  if (result.api?.ok) result.summary = 'api-ready';
  return result;
}
/** 在给定模型清单中核对 Gemma 模型标识（动态核对，不硬编码“就绪”）。 */
function findModel(models, expectedIds) {
  if (!Array.isArray(models)) return {found: false, reason: 'API 未运行，无法核对模型。'};
  const hit = models.find(m => expectedIds.some(id => m.id === id || m.id?.toLowerCase().includes(id.toLowerCase())));
  return hit ? {found: true, id: hit.id} : {found: false, reason: `API 模型清单中没有 ${expectedIds.join(' / ')}。`};
}
module.exports = {checkPort, probeComfy, probeLmStudio, looksLikeComfy, findModel, checkWebSocket};
