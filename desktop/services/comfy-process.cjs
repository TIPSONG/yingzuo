'use strict';
// S03/S05：按需启动 ComfyUI、记录 ownership、只停止经重新核实的本应用启动实例。
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {writeJsonAtomic} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');
const {processIdentity, killTree, isAlive} = require('./process-utils.cjs');

const samePath = (a, b, platform) => !!a && !!b && (platform === 'win32' ? path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase() : path.resolve(a) === path.resolve(b));

class ComfyProcessManager {
  /**
   * @param {object} o registryFile：ownership 记录；logsDir：stdout/stderr；probe(url)：S02 探测；
   *   spawnImpl/identityImpl/killImpl 可注入以便测试。
   */
  constructor({registryFile, logsDir, probe, platform = process.platform, spawnImpl = spawn, identityImpl = processIdentity, killImpl = killTree, aliveImpl = isAlive, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now()}) {
    Object.assign(this, {registryFile, logsDir, probe, platform, spawnImpl, identityImpl, killImpl, aliveImpl, sleep, now});
    this.child = null; this.starting = null;
  }
  readRegistry() { try { return JSON.parse(fs.readFileSync(this.registryFile, 'utf8')); } catch { return {version: 1, services: {}}; } }
  writeRegistry(reg) { writeJsonAtomic(this.registryFile, reg); }
  get record() { return this.readRegistry().services.comfy ?? null; }
  /** 构造启动参数：main.py --listen <host> --port <port> + 用户参数（逐项数据，不经 shell）。 */
  buildCommand(config) {
    const c = config.comfy, url = new URL(c.url);
    if (!c.python) throw new AppError(CODES.INVALID_ARGUMENT, '未配置 ComfyUI 的 Python 路径，无法按需启动。请在设置中填写，或手动启动后点击“连接”。');
    if (!c.root) throw new AppError(CODES.INVALID_ARGUMENT, '未配置 ComfyUI 目录。');
    const main = path.join(c.root, 'main.py');
    if (!fs.existsSync(c.python)) throw new AppError(CODES.NOT_FOUND, `Python 不存在：${c.python}`);
    if (!fs.existsSync(main)) throw new AppError(CODES.NOT_FOUND, `ComfyUI 目录中没有 main.py：${c.root}`);
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
    const userArgs = c.extraArgs.filter(a => !/^--(listen|port)(=|$)/.test(a));
    return {executable: c.python, args: [main, '--listen', host, '--port', String(url.port || 8188), ...userArgs], cwd: c.root};
  }
  /** 已有正确服务就连接（external）；否则启动并等待真实就绪。 */
  async ensureRunning(config, {token, onProgress = () => {}} = {}) {
    const first = await this.probe(config.comfy.url);
    if (first.summary === 'ready' || first.summary === 'degraded') {
      const owned = await this.verifyOwned();
      return {ownership: owned ? 'owned' : 'external', probe: first, started: false};
    }
    if (first.summary === 'port-occupied') throw new AppError(CODES.SERVICE_IDENTITY, first.identity?.error || '端口被其他程序占用。', {details: first});
    if (this.starting) return this.starting;
    this.starting = this._start(config, {token, onProgress}).finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start(config, {token, onProgress}) {
    const cmd = this.buildCommand(config);
    fs.mkdirSync(this.logsDir, {recursive: true});
    const stdoutFile = path.join(this.logsDir, 'comfyui.stdout.log'), stderrFile = path.join(this.logsDir, 'comfyui.stderr.log');
    const out = fs.openSync(stdoutFile, 'a'), err = fs.openSync(stderrFile, 'a');
    let child;
    try { child = this.spawnImpl(cmd.executable, cmd.args, {cwd: cmd.cwd, shell: false, windowsHide: true, stdio: ['ignore', out, err], env: {...process.env, PYTHONUNBUFFERED: '1'}}); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    let exited = null;
    child.once?.('exit', (code, signal) => { exited = {code, signal}; });
    child.once?.('error', error => { exited = {error: error.message}; });
    this.child = child;
    await this.sleep(300);
    if (exited) throw new AppError(CODES.SERVICE_UNAVAILABLE, `ComfyUI 进程立即退出：${JSON.stringify(exited)}。请查看日志 ${stderrFile}`, {details: {stdoutFile, stderrFile}});
    const identity = await this.identityImpl(child.pid, {platform: this.platform});
    const record = {pid: child.pid, executable: identity?.executable ?? cmd.executable, configuredExecutable: cmd.executable, startTime: identity?.startTime ?? null, args: cmd.args, cwd: cmd.cwd, url: config.comfy.url, launchedAt: new Date(this.now()).toISOString(), stdoutFile, stderrFile};
    const reg = this.readRegistry(); reg.services.comfy = record; this.writeRegistry(reg);
    const deadline = this.now() + config.comfy.startTimeoutSec * 1000;
    let last;
    while (this.now() < deadline) {
      token?.throwIfCancelled();
      if (exited) throw new AppError(CODES.SERVICE_UNAVAILABLE, `ComfyUI 启动过程中退出：${JSON.stringify(exited)}。请查看日志 ${stderrFile}`, {details: {stdoutFile, stderrFile}});
      last = await this.probe(config.comfy.url);
      onProgress(last);
      if (last.summary === 'ready' || last.summary === 'degraded') return {ownership: 'owned', probe: last, started: true, pid: child.pid};
      if (last.summary === 'port-occupied') throw new AppError(CODES.SERVICE_IDENTITY, '启动期间端口被其他程序占用。', {details: last});
      await this.sleep(1000);
    }
    throw new AppError(CODES.TIMEOUT, `等待 ComfyUI 就绪超时（${config.comfy.startTimeoutSec} 秒）。进程仍保留，可查看日志：${stderrFile}`, {details: {stdoutFile, stderrFile, last}});
  }
  /** 重新核实：进程存活、启动时间与可执行路径与登记一致。不只凭 PID 或进程名。 */
  async verifyOwned() {
    const rec = this.record;
    if (!rec?.pid) return false;
    if (!this.aliveImpl(rec.pid)) return false;
    const now = await this.identityImpl(rec.pid, {platform: this.platform});
    if (!now) return false;
    if (rec.startTime && now.startTime !== rec.startTime) return false;
    if (!samePath(now.executable, rec.executable, this.platform)) return false;
    return true;
  }
  /** 停止：只停核实过的 owned 实例；外部服务返回 NOT_OWNED。 */
  async stop({graceMs = 10000} = {}) {
    if (!(await this.verifyOwned())) {
      const rec = this.record;
      if (rec) { const reg = this.readRegistry(); delete reg.services.comfy; reg.stale = [...(reg.stale ?? []), {...rec, droppedAt: new Date(this.now()).toISOString()}].slice(-20); this.writeRegistry(reg); }
      throw new AppError(CODES.NOT_OWNED, '当前 ComfyUI 不是本应用启动的实例（或无法核实），为安全起见不停止。');
    }
    const {pid} = this.record;
    await this.killImpl(pid, {platform: this.platform});
    const until = this.now() + graceMs;
    while (this.now() < until && this.aliveImpl(pid)) await this.sleep(250);
    if (this.aliveImpl(pid)) await this.killImpl(pid, {platform: this.platform, force: true});
    const reg = this.readRegistry(); delete reg.services.comfy; this.writeRegistry(reg);
    this.child = null;
    return {stopped: true, pid};
  }
  /** 释放显存：调用 /free（若存在），不停止服务。 */
  async freeMemory(baseUrl, fetchImpl = fetch) {
    const response = await fetchImpl(new URL('free', baseUrl), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({unload_models: true, free_memory: true}), signal: AbortSignal.timeout(10000)});
    if (response.status === 404 || response.status === 405) throw new AppError(CODES.UNSUPPORTED, '当前 ComfyUI 版本没有 /free 接口。');
    if (!response.ok) throw new AppError(CODES.HTTP, `释放显存失败：HTTP ${response.status}`);
    return {freed: true};
  }
  logTail(lines = 120) {
    const rec = this.record, files = rec ? [rec.stderrFile, rec.stdoutFile] : [path.join(this.logsDir, 'comfyui.stderr.log'), path.join(this.logsDir, 'comfyui.stdout.log')];
    return files.map(f => ({file: f, lines: (() => { try { return fs.readFileSync(f, 'utf8').trimEnd().split('\n').slice(-lines); } catch { return []; } })()}));
  }
}
module.exports = {ComfyProcessManager, samePath};
