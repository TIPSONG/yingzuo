'use strict';
// S04：LM Studio 适配。只用已安装的 lms CLI 的实际能力；不下载模型；
// 只能卸载本应用登记的实例；不提供“卸载全部模型”。
const fs = require('node:fs');
const path = require('node:path');
const {run} = require('./process-utils.cjs');
const {writeJsonAtomic} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');

function expandCliPath(value, env = process.env) {
  if (!value) return '';
  return value.replace(/%([A-Za-z_]+)%/g, (_, k) => env[k] ?? env[k.toUpperCase()] ?? `%${k}%`).replace(/^~(?=$|[\\/])/, env.HOME || env.USERPROFILE || '~');
}
/** 解析 `lms --help` 输出中的子命令。 */
function parseCommands(helpText) {
  const commands = new Set();
  for (const line of String(helpText).split(/\r?\n/)) {
    const m = /^\s{1,6}([a-z][a-z-]{1,20})\b/.exec(line);
    if (m && !['usage', 'options', 'commands'].includes(m[1])) commands.add(m[1]);
  }
  return [...commands];
}
class LmStudioAdapter {
  constructor({cliPath, registryFile, runImpl = run, exists = p => fs.existsSync(p)}) {
    this.cliPath = expandCliPath(cliPath); this.registryFile = registryFile; this.runImpl = runImpl; this.exists = exists; this.caps = null;
  }
  async detect() {
    if (!this.cliPath) return {available: false, error: '未配置 lms CLI 路径。'};
    if (!this.exists(this.cliPath)) return {available: false, path: this.cliPath, error: `未找到 lms CLI：${this.cliPath}。请先打开一次 LM Studio 或在设置中修改路径。`};
    try {
      const help = await this.runImpl(this.cliPath, ['--help'], {timeoutMs: 15000});
      const commands = parseCommands(help.stdout + '\n' + help.stderr);
      let version = null;
      try { const v = await this.runImpl(this.cliPath, ['version'], {timeoutMs: 10000}); version = (v.stdout || v.stderr).trim().split('\n').pop() || null; } catch { /* 部分版本没有 version 子命令 */ }
      this.caps = {available: true, path: this.cliPath, version, commands, canStartServer: commands.includes('server'), canListLoaded: commands.includes('ps'), canUnload: commands.includes('unload'), canStatus: commands.includes('status')};
      return this.caps;
    } catch (e) { return {available: false, path: this.cliPath, error: e.message}; }
  }
  async listLoaded() {
    if (!this.caps?.canListLoaded) throw new AppError(CODES.UNSUPPORTED, '该 lms 版本不支持列出已加载实例。');
    const r = await this.runImpl(this.cliPath, ['ps', '--json'], {timeoutMs: 15000});
    if (r.code !== 0) throw new AppError(CODES.SERVICE_UNAVAILABLE, `lms ps 失败：${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    let data; try { data = JSON.parse(r.stdout); } catch { throw new AppError(CODES.UNSUPPORTED, 'lms ps --json 输出无法解析；请升级 LM Studio 或在其界面中查看。'); }
    const items = Array.isArray(data) ? data : data?.models ?? [];
    const owned = new Set(this.registry().ownedInstances ?? []);
    return items.map(m => ({identifier: m.identifier ?? m.id ?? m.modelKey ?? null, modelKey: m.modelKey ?? m.path ?? null, contextLength: m.contextLength ?? null, owned: owned.has(m.identifier ?? m.id)}));
  }
  registry() { try { return JSON.parse(fs.readFileSync(this.registryFile, 'utf8')); } catch { return {version: 1, serverOwned: false, ownedInstances: []}; } }
  saveRegistry(r) { writeJsonAtomic(this.registryFile, r); }
  /** 按需启动 API 服务；若原本已在运行，ownership=external。 */
  async startServer({apiReachable}) {
    if (apiReachable) return {ownership: 'external', started: false};
    if (!this.caps?.canStartServer) throw new AppError(CODES.UNSUPPORTED, '该 lms 版本不能启动服务；请手动打开 LM Studio 并在 Developer 页面启动 Server。');
    const r = await this.runImpl(this.cliPath, ['server', 'start'], {timeoutMs: 60000});
    if (r.code !== 0) throw new AppError(CODES.SERVICE_UNAVAILABLE, `lms server start 失败：${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    const reg = this.registry(); reg.serverOwned = true; reg.serverStartedAt = new Date().toISOString(); this.saveRegistry(reg);
    return {ownership: 'owned', started: true};
  }
  async stopServer() {
    const reg = this.registry();
    if (!reg.serverOwned) throw new AppError(CODES.NOT_OWNED, 'LM Studio 服务不是本应用启动的，保持运行。');
    const r = await this.runImpl(this.cliPath, ['server', 'stop'], {timeoutMs: 30000});
    if (r.code !== 0) throw new AppError(CODES.SERVICE_UNAVAILABLE, `lms server stop 失败：${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    reg.serverOwned = false; this.saveRegistry(reg);
    return {stopped: true};
  }
  /** 只卸载本应用登记的实例。 */
  async unloadOwned(identifier) {
    const reg = this.registry();
    if (!reg.ownedInstances?.includes(identifier)) throw new AppError(CODES.NOT_OWNED, '该模型实例不是本应用加载的，不会卸载。');
    if (!this.caps?.canUnload) throw new AppError(CODES.UNSUPPORTED, '该 lms 版本不支持卸载。');
    const r = await this.runImpl(this.cliPath, ['unload', identifier], {timeoutMs: 30000});
    if (r.code !== 0) throw new AppError(CODES.SERVICE_UNAVAILABLE, `卸载失败：${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    reg.ownedInstances = reg.ownedInstances.filter(x => x !== identifier); this.saveRegistry(reg);
    return {unloaded: identifier};
  }
}
module.exports = {LmStudioAdapter, parseCommands, expandCliPath};
