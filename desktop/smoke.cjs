'use strict';
// B03：打包产物自检。`映作.exe --yz-smoke=<结果文件>` 在临时目录中验证 Electron 下的原生模块与关键模块可加载，
// 不创建、不读取用户数据目录，写出 JSON 结果后退出（0 = 通过）。供 Windows Actions 构建后实际运行。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function smokeTarget(argv) { const a = argv.find(x => x.startsWith('--yz-smoke=')); return a ? a.slice('--yz-smoke='.length) : null; }
async function runSmoke(target, {app}) {
  const checks = [];
  const step = async (name, fn) => { try { checks.push({name, ok: true, detail: await fn()}); } catch (e) { checks.push({name, ok: false, detail: e.message}); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-smoke-'));
  await step('versions', () => ({electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, app: app.getVersion()}));
  await step('sqlite', () => { const {Database} = require('./repositories/database.cjs'); const db = Database.open(path.join(tmp, 'app.db')); try { return {driver: db.driver.name ?? 'unknown', tables: db.all("SELECT name FROM sqlite_master WHERE type='table'").length}; } finally { db.close(); } });
  await step('sharp', async () => { const sharp = require('sharp'); const buf = await sharp({create: {width: 4, height: 4, channels: 3, background: '#808080'}}).webp().toBuffer(); return {bytes: buf.length}; });
  await step('modules', () => { for (const m of ['./services/api.cjs', './services/task-service.cjs', './services/maintenance-service.cjs', './services/assets-api.cjs', './services/online/online-service.cjs']) require(m); return 'ok'; });
  await step('workbench', () => { for (const f of ['workbench.html', 'workbench.js', 'preload.cjs']) if (!fs.existsSync(path.join(__dirname, f))) throw new Error(`缺少 ${f}`); return 'ok'; });
  try { fs.rmSync(tmp, {recursive: true, force: true}); } catch { /* 忽略 */ }
  const ok = checks.every(c => c.ok);
  fs.writeFileSync(target, JSON.stringify({ok, at: new Date().toISOString(), checks}, null, 2));
  return ok;
}
module.exports = {smokeTarget, runSmoke};
