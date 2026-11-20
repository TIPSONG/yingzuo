'use strict';
// B03：打包产物自检。`映作.exe --yz-smoke=<结果文件>` 在临时目录中验证 Electron 下的原生模块与关键模块可加载，
// 不创建、不读取用户数据目录，写出 JSON 结果后退出（0 = 通过）。供 Windows Actions 构建后实际运行。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function smokeTarget(argv) { const a = argv.find(x => x.startsWith('--yz-smoke=')); return a ? a.slice('--yz-smoke='.length) : null; }
async function smokeMcp(tmp, safeStorage) {
  const {createMcpServer} = require('./services/mcp-server.cjs');
  const {CredentialStore} = require('./core/credentials.cjs');
  const file = path.join(tmp, 'mcp-credentials.json');
  const store = () => new CredentialStore(file, safeStorage, new Set(['access']));
  const generated = require('node:crypto').randomBytes(32).toString('base64url');
  let token;
  try {
    store().set('access', generated);
    token = store().get('access');
    if (token !== generated || fs.readFileSync(file, 'utf8').includes(generated)) throw new Error();
  } catch { throw new Error('MCP 令牌加密保存或重新读取失败。'); }
  const service = createMcpServer({token, tools: {
    tools: [{name: 'smoke', description: 'Isolated package check', inputSchema: {type: 'object', properties: {}}}],
    call: async () => ({content: []}),
  }});
  try {
    const url = await service.start();
    const protocol = '2026-07-28';
    const meta = {'io.modelcontextprotocol/protocolVersion': protocol,
      'io.modelcontextprotocol/clientInfo': {name: 'packaged-smoke', version: '1'}, 'io.modelcontextprotocol/clientCapabilities': {}};
    const rpc = async (method, id) => {
      const res = await fetch(url, {method: 'POST', signal: AbortSignal.timeout(5000),
        headers: {authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
          'mcp-method': method, 'mcp-protocol-version': protocol}, body: JSON.stringify({jsonrpc: '2.0', id, method, params: {_meta: meta}})});
      if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}`);
      const reply = await res.json();
      if (reply.id !== id || !reply.result) throw new Error(`MCP ${method} response invalid`);
      return reply.result;
    };
    const info = await rpc('server/discover', 1);
    const list = await rpc('tools/list', 2);
    const server = info._meta?.['io.modelcontextprotocol/serverInfo']?.name;
    if (server !== 'yingzuo' || !info.supportedVersions?.includes(protocol) || !list.tools?.some(tool => tool.name === 'smoke')) throw new Error('MCP discovery failed');
    return {server, protocol, tools: list.tools.length, credentialRoundTrip: true};
  } finally { await service.stop(); }
}
async function runSmoke(target, {app, safeStorage}) {
  const checks = [];
  const step = async (name, fn) => { try { checks.push({name, ok: true, detail: await fn()}); } catch (e) { checks.push({name, ok: false, detail: e.message}); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-smoke-'));
  await step('versions', () => ({electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, app: app.getVersion()}));
  await step('sqlite', () => { const {Database} = require('./repositories/database.cjs'); const db = Database.open(path.join(tmp, 'app.db')); try { return {driver: db.driver.name ?? 'unknown', tables: db.all("SELECT name FROM sqlite_master WHERE type='table'").length}; } finally { db.close(); } });
  await step('sharp', async () => { const sharp = require('sharp'); const buf = await sharp({create: {width: 4, height: 4, channels: 3, background: '#808080'}}).webp().toBuffer(); return {bytes: buf.length}; });
  // S09：打包后 worker 线程能加载、在 worker 内由 sharp 生成缩略图、读取元数据、复制与哈希
  await step('worker', async () => {
    const {WorkerPool} = require('./core/worker-pool.cjs');
    const sharp = require('sharp'); const png = path.join(tmp, 'w.png');
    await sharp({create: {width: 8, height: 8, channels: 3, background: '#406080'}}).png().toFile(png);
    const pool = new WorkerPool({size: 1});
    try {
      const h = await pool.run('sha256', {file: png});
      const m = await pool.run('imageMeta', {file: png});
      const t = await pool.run('thumbnail', {src: png, tmp: path.join(tmp, 't.webp'), size: 4});
      const c = await pool.run('copyFile', {src: png, dest: path.join(tmp, 'c.png')});
      if (!m.metadata?.dimensions?.width) throw new Error('worker 未读出尺寸');
      return {sha256: h.sha256.slice(0, 12), format: m.format, thumbBytes: t.bytes, copied: c.bytes};
    } finally { await pool.close(); }
  });
  await step('modules', () => { for (const m of ['./services/api.cjs', './services/task-service.cjs', './services/maintenance-service.cjs', './services/assets-api.cjs', './services/online/online-service.cjs']) require(m); return 'ok'; });
  await step('mcp', () => smokeMcp(tmp, safeStorage));
  await step('workbench', () => { for (const f of ['workbench.html', 'workbench.js', 'preload.cjs']) if (!fs.existsSync(path.join(__dirname, f))) throw new Error(`缺少 ${f}`); return 'ok'; });
  try { fs.rmSync(tmp, {recursive: true, force: true}); } catch { /* 忽略 */ }
  const ok = checks.every(c => c.ok);
  fs.writeFileSync(target, JSON.stringify({ok, at: new Date().toISOString(), checks}, null, 2));
  return ok;
}
module.exports = {smokeTarget, runSmoke};
