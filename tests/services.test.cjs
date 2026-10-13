'use strict';
// 服务层测试：探测、ownership 核实、LM Studio CLI 能力、编辑器适配器串写保护、API 分发。
// 均为替身环境，不能代替 Windows 上真实 ComfyUI / LM Studio 验收。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {probeComfy, probeLmStudio, checkPort, findModel} = require('../desktop/services/service-probe.cjs');
const {ComfyProcessManager} = require('../desktop/services/comfy-process.cjs');
const {LmStudioAdapter, parseCommands, expandCliPath} = require('../desktop/services/lmstudio.cjs');
const {ComfyEditorAdapter, describeCapabilities} = require('../desktop/adapters/comfy-editor-adapter.cjs');
const {run} = require('../desktop/services/process-utils.cjs');
const {defaults} = require('../desktop/repositories/config-repo.cjs');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-s-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
function server(t, handler) {
  return new Promise(resolve => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => { t.after(() => s.close()); resolve(`http://127.0.0.1:${s.address().port}/`); }); });
}

test('ComfyUI 探测：端口未监听 / 端口被其他程序占用 / 真实身份', async t => {
  const closed = await probeComfy('http://127.0.0.1:1/', {portCheck: async () => ({reachable: false, error: '端口未监听（服务未运行）'})});
  assert.equal(closed.summary, 'offline');
  const other = await server(t, (req, res) => { res.writeHead(200, {'content-type': 'text/html'}); res.end('<html>nginx</html>'); });
  const occupied = await probeComfy(other, {WebSocketImpl: null});
  assert.equal(occupied.summary, 'port-occupied'); assert.match(occupied.identity.error, /占用/);
  const comfy = await server(t, (req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({system: {comfyui_version: '0.37.0', python_version: '3.11'}, devices: [{name: 'cuda:0', type: 'cuda', vram_total: 1, vram_free: 1}]})); });
  const ok = await probeComfy(comfy, {WebSocketImpl: class { constructor() { setTimeout(() => this.onopen(), 5); } close() {} }});
  assert.equal(ok.summary, 'ready'); assert.equal(ok.identity.comfyuiVersion, '0.37.0');
  const noWs = await probeComfy(comfy, {WebSocketImpl: class { constructor() { setTimeout(() => this.onerror({message: 'refused'}), 5); } close() {} }});
  assert.equal(noWs.summary, 'degraded');
});
test('LM Studio 探测：API 与模型清单分开，Gemma 动态核对', async t => {
  const lm = await server(t, (req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({data: [{id: 'hauhaucs/gemma-4-12b-q4_k_m'}]})); });
  const r = await probeLmStudio(lm + 'v1', {cli: {available: false, error: 'no cli'}});
  assert.equal(r.summary, 'api-ready'); assert.equal(r.app.ok, false);
  assert.equal(findModel(r.models, ['gemma-4']).found, true);
  assert.equal(findModel(null, ['gemma']).found, false);
  const off = await probeLmStudio('http://127.0.0.1:1/v1', {portCheck: async () => ({reachable: false, error: 'x'}), cli: {available: true, path: 'lms'}});
  assert.equal(off.summary, 'app-only');
});
test('checkPort 对未监听端口给出原因', async () => {
  const r = await checkPort('127.0.0.1', 1, 500); assert.equal(r.reachable, false); assert.ok(r.error);
});

function manager(t, overrides = {}) {
  const d = tmp(t);
  const ids = new Map(); const alive = new Set(); const killed = [];
  const m = new ComfyProcessManager({registryFile: path.join(d, 'services.json'), logsDir: path.join(d, 'logs'), probe: overrides.probe ?? (async () => ({summary: 'offline'})), platform: 'linux',
    identityImpl: async pid => ids.get(pid) ?? null, aliveImpl: pid => alive.has(pid), killImpl: async (pid, o) => { killed.push({pid, force: !!o.force}); alive.delete(pid); return true; },
    sleep: async () => {}, spawnImpl: overrides.spawnImpl, now: overrides.now ?? (() => Date.now())});
  return {m, d, ids, alive, killed};
}
test('停止服务：只停止重新核实的 owned 实例；PID 复用（启动时间不同）不停止', async t => {
  const {m, ids, alive, killed} = manager(t);
  m.writeRegistry({version: 1, services: {comfy: {pid: 4242, executable: '/py/python', startTime: 'ticks:100'}}});
  alive.add(4242); ids.set(4242, {pid: 4242, executable: '/py/python', startTime: 'ticks:999'});
  await assert.rejects(m.stop(), e => e.code === 'NOT_OWNED');
  assert.equal(killed.length, 0); assert.equal(m.record, null, '失效登记被移到 stale');
  m.writeRegistry({version: 1, services: {comfy: {pid: 4242, executable: '/py/python', startTime: 'ticks:999'}}});
  assert.equal(await m.verifyOwned(), true);
  const r = await m.stop(); assert.equal(r.stopped, true); assert.deepEqual(killed, [{pid: 4242, force: false}]);
  m.writeRegistry({version: 1, services: {comfy: {pid: 4243, executable: '/other/python', startTime: null}}});
  alive.add(4243); ids.set(4243, {pid: 4243, executable: '/py/python', startTime: 'x'});
  assert.equal(await m.verifyOwned(), false, '可执行路径不同不算 owned');
});
test('按需启动：已有服务视为 external；端口被占用报错；启动后等待真实就绪并登记', async t => {
  const config = defaults('linux');
  const ext = manager(t, {probe: async () => ({summary: 'ready'})});
  assert.equal((await ext.m.ensureRunning(config)).ownership, 'external');
  const occ = manager(t, {probe: async () => ({summary: 'port-occupied', identity: {error: '被占用'}})});
  await assert.rejects(occ.m.ensureRunning(config), e => e.code === 'SERVICE_IDENTITY');
  // 构造一个真实的 python 与 main.py 路径
  let probes = 0;
  const {EventEmitter} = require('node:events');
  const spawned = [];
  const st = manager(t, {probe: async () => (++probes >= 3 ? {summary: 'ready'} : {summary: 'offline'}), spawnImpl: (exe, args, opts) => { spawned.push({exe, args, opts}); const c = new EventEmitter(); c.pid = 777; return c; }});
  const root = path.join(st.d, 'Comfy'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'main.py'), ''); fs.writeFileSync(path.join(st.d, 'python'), '');
  config.comfy.root = root; config.comfy.python = path.join(st.d, 'python'); config.comfy.extraArgs = ['--lowvram', '--port=9999', '; rm -rf /'];
  st.ids.set(777, {pid: 777, executable: config.comfy.python, startTime: 'ticks:1'});
  const r = await st.m.ensureRunning(config);
  assert.equal(r.ownership, 'owned'); assert.equal(r.started, true);
  assert.equal(spawned[0].opts.shell, false, '不经过 shell');
  assert.deepEqual(spawned[0].args.slice(1), ['--listen', '127.0.0.1', '--port', '8188', '--lowvram', '; rm -rf /'], '用户参数作为数据传递，覆盖端口的参数被忽略');
  assert.equal(st.m.record.pid, 777); assert.equal(st.m.record.startTime, 'ticks:1');
});
test('启动超时与进程提前退出给出日志位置', async t => {
  const config = defaults('linux');
  const {EventEmitter} = require('node:events');
  let clock = 0;
  const st = manager(t, {now: () => (clock += 5000), spawnImpl: () => { const c = new EventEmitter(); c.pid = 5; return c; }});
  const root = path.join(st.d, 'C'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'main.py'), ''); fs.writeFileSync(path.join(st.d, 'py'), '');
  Object.assign(config.comfy, {root, python: path.join(st.d, 'py'), startTimeoutSec: 10});
  await assert.rejects(st.m.ensureRunning(config), e => e.code === 'TIMEOUT' && /日志/.test(e.message));
  const ex = manager(t, {spawnImpl: () => { const c = new EventEmitter(); c.pid = 6; setImmediate(() => c.emit('exit', 1, null)); return c; }});
  const root2 = path.join(ex.d, 'C'); fs.mkdirSync(root2); fs.writeFileSync(path.join(root2, 'main.py'), ''); fs.writeFileSync(path.join(ex.d, 'py'), '');
  Object.assign(config.comfy, {root: root2, python: path.join(ex.d, 'py')});
  ex.m.sleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 20)));
  await assert.rejects(ex.m.ensureRunning(config), e => e.code === 'SERVICE_UNAVAILABLE' && /退出/.test(e.message));
});
test('缺少 Python/目录时给出可操作的错误而不是崩溃', async t => {
  const {m} = manager(t); const config = defaults('linux');
  assert.throws(() => m.buildCommand(config), /Python/);
});
test('LM Studio CLI：解析命令、只卸载登记实例、外部服务不停止', async t => {
  const d = tmp(t);
  assert.deepEqual(parseCommands('Usage: lms <cmd>\n\nCommands:\n  status  Show\n  server  Manage\n  ps      List\n  load\n  unload\n').sort(), ['load', 'ps', 'server', 'status', 'unload']);
  assert.equal(expandCliPath('%USERPROFILE%\\.lmstudio\\bin\\lms.exe', {USERPROFILE: 'C:\\Users\\a'}), 'C:\\Users\\a\\.lmstudio\\bin\\lms.exe');
  const calls = [];
  const runImpl = async (exe, args) => { calls.push(args.join(' ')); if (args[0] === '--help') return {code: 0, stdout: 'Commands:\n  server\n  ps\n  unload\n', stderr: ''}; if (args[0] === 'ps') return {code: 0, stdout: JSON.stringify([{identifier: 'gemma-a'}, {identifier: 'chat-b'}]), stderr: ''}; return {code: 0, stdout: '', stderr: ''}; };
  const lm = new LmStudioAdapter({cliPath: '/x/lms', registryFile: path.join(d, 'lm.json'), runImpl, exists: () => true});
  const caps = await lm.detect(); assert.equal(caps.canStartServer, true);
  assert.equal((await lm.startServer({apiReachable: true})).ownership, 'external');
  await assert.rejects(lm.stopServer(), e => e.code === 'NOT_OWNED');
  await assert.rejects(lm.unloadOwned('chat-b'), e => e.code === 'NOT_OWNED');
  assert.ok(!calls.some(c => c.startsWith('unload')), '不卸载非本应用实例');
  const started = await lm.startServer({apiReachable: false}); assert.equal(started.ownership, 'owned');
  await lm.stopServer(); assert.ok(calls.includes('server stop'));
  const missing = new LmStudioAdapter({cliPath: '/none/lms', registryFile: path.join(d, 'x.json'), exists: () => false});
  assert.equal((await missing.detect()).available, false);
});
test('run() 不经过 shell，元字符按原样传递', async () => {
  const r = await run(process.execPath, ['-e', 'console.log(process.argv[1])', '$(echo hacked) && ; |'], {timeoutMs: 10000});
  assert.equal(r.stdout.trim(), '$(echo hacked) && ; |');
  await assert.rejects(run('/no/such/exe', []), e => e.code === 'NOT_FOUND');
  await assert.rejects(run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {timeoutMs: 100}), e => e.code === 'TIMEOUT');
});
test('编辑器适配器：revision 或原生身份不符即拒绝写入；能力限制具体说明', async () => {
  const sources = [];
  const tab = {id: 'a', revision: 3, documentId: 'doc', graph: {nodes: []}};
  const bridge = {applyParametersSource: p => (sources.push(p), 'src'), setModeSource: () => 'm', compileSource: p => JSON.stringify(p), focusNodeSource: p => JSON.stringify(p), getCapabilitiesSource: () => 'c', snapshotSource: () => 's', loadGraphSource: () => 'l'};
  const adapter = new ComfyEditorAdapter({execute: async () => ({ok: true}), bridge, getTab: id => (id === 'a' ? tab : null)});
  const guard = {tabId: 'a', expectedRevision: 3, nativeIdentity: {hostName: 'yingzuo-a', documentId: 'doc'}};
  const binding = {scopePath: ['sub'], nodeId: '5', nodeType: 'KSampler', fieldName: 'steps', widgetType: 'number', constraints: {}};
  await adapter.applyBindings(guard, [{binding, value: 30}]);
  assert.deepEqual(sources[0].updates, [{nodeId: '5', graphId: 'sub', widgetName: 'steps', value: 30}]);
  assert.throws(() => adapter.applyBindings({...guard, expectedRevision: 2}, [{binding, value: 1}]), e => e.code === 'REVISION_MISMATCH');
  assert.throws(() => adapter.applyBindings({...guard, nativeIdentity: {hostName: 'yingzuo-b', documentId: 'doc'}}, [{binding, value: 1}]), e => e.code === 'IDENTITY_MISMATCH');
  assert.throws(() => adapter.applyBindings({...guard, nativeIdentity: {hostName: 'yingzuo-a', documentId: 'other'}}, [{binding, value: 1}]), e => e.code === 'IDENTITY_MISMATCH');
  const caps = describeCapabilities({loadGraph: true, snapshot: true, parameters: true, appMode: false, compile: false, focusNode: true, frontendVersion: '1.60.0'});
  assert.equal(caps.usable, true);
  assert.ok(caps.limits.some(l => l.feature === 'compile')); assert.ok(caps.limits.some(l => l.feature === 'version' && /1\.60\.0/.test(l.message)));
  assert.equal(describeCapabilities({loadGraph: false}).usable, false);
});

test('D11/PR11-R04：Comfy 停止——kill 失败或进程仍存活时报错并保留登记；强停前再核对身份；缺启动时间不算 owned', async t => {
  const {m, ids, alive} = manager(t);
  m.killImpl = async () => false;
  m.writeRegistry({version: 1, services: {comfy: {pid: 5000, executable: '/py/python', startTime: 's'}}});
  alive.add(5000); ids.set(5000, {pid: 5000, executable: '/py/python', startTime: 's'});
  await assert.rejects(m.stop(), e => e.details?.stopFailed);
  assert.equal(m.record.pid, 5000, '失败保留登记');
  const forced = [];
  m.killImpl = async (pid, o) => { forced.push(!!o.force); ids.set(5000, {pid: 5000, executable: '/py/python', startTime: 'reused'}); return true; };
  await assert.rejects(m.stop({graceMs: 20}), e => e.code === 'NOT_OWNED');
  assert.deepEqual(forced, [false], '身份变化后不强停');
  m.writeRegistry({version: 1, services: {comfy: {pid: 5001, executable: '/py/python', startTime: null}}});
  alive.add(5001); ids.set(5001, {pid: 5001, executable: '/py/python', startTime: 'x'});
  assert.equal(await m.verifyOwned(), false);
});
test('D11/PR11-R04：LM Studio 归属只在本会话、绑定端口、API 就绪后才登记', async t => {
  const d = tmp(t); const calls = [];
  const runImpl = async (exe, args) => { calls.push(args.join(' ')); return {code: 0, stdout: args[0] === '--help' ? 'Commands:\n  server\n' : '', stderr: ''}; };
  const reg = path.join(d, 'lm.json');
  const a = new LmStudioAdapter({cliPath: '/x/lms', registryFile: reg, runImpl, exists: () => true, session: 's1'}); await a.detect();
  await assert.rejects(a.startServer({apiReachable: false, port: 4321, waitReady: async () => false}), /未就绪/);
  assert.equal(a.registry().serverOwned, false);
  assert.ok(calls.includes('server start --port 4321'));
  await a.startServer({apiReachable: false, port: 4321, waitReady: async () => true});
  await assert.rejects(a.stopServer({port: 1234}), e => e.code === 'NOT_OWNED');
  await a.startServer({apiReachable: false, port: 4321, waitReady: async () => true});
  const b = new LmStudioAdapter({cliPath: '/x/lms', registryFile: reg, runImpl, exists: () => true, session: 's2'}); await b.detect();
  await assert.rejects(b.stopServer({port: 4321}), e => e.code === 'NOT_OWNED', '应用重启后旧标记不授权停止');
  assert.ok(!calls.includes('server stop'));
});
