'use strict';
// 子进程工具：一律 spawn(exe, args, {shell:false})；参数作为数据传递，不拼接 shell 字符串。
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const {AppError, CODES} = require('../core/errors.cjs');

/** 运行命令并收集输出（限长），超时终止。 */
function run(executable, args = [], {cwd, env, timeoutMs = 30000, maxOutput = 1024 * 1024, spawnImpl = spawn, token} = {}) {
  if (typeof executable !== 'string' || !executable) return Promise.reject(new AppError(CODES.INVALID_ARGUMENT, '可执行文件为空。'));
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) return Promise.reject(new AppError(CODES.INVALID_ARGUMENT, '参数必须是字符串数组。'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(executable, args, {cwd, env, shell: false, windowsHide: true}); }
    catch (error) { reject(new AppError(CODES.SERVICE_UNAVAILABLE, `无法启动 ${executable}：${error.message}`)); return; }
    let stdout = '', stderr = '', done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); off?.(); fn(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } finish(reject, new AppError(CODES.TIMEOUT, `${executable} 执行超时。`, {details: {stdout, stderr}})); }, timeoutMs);
    const off = token?.onCancel(() => { try { child.kill(); } catch { /* 忽略 */ } finish(reject, new AppError(CODES.CANCELLED, '已取消。')); });
    child.stdout?.on('data', c => { if (stdout.length < maxOutput) stdout += c; });
    child.stderr?.on('data', c => { if (stderr.length < maxOutput) stderr += c; });
    child.on('error', error => finish(reject, new AppError(error.code === 'ENOENT' ? CODES.NOT_FOUND : CODES.SERVICE_UNAVAILABLE, `无法运行 ${executable}：${error.message}`)));
    child.on('close', code => finish(resolve, {code, stdout, stderr}));
  });
}

/**
 * 查询进程身份（可执行路径 + 启动时间），用于在停止前重新核实 ownership。
 * Windows：PowerShell Get-CimInstance；Linux：/proc。查询失败返回 null（视为无法核实）。
 */
async function processIdentity(pid, {platform = process.platform, runImpl = run} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{exe=$p.ExecutablePath; start=$p.CreationDate.ToUniversalTime().ToString('o'); cmd=$p.CommandLine} | ConvertTo-Json -Compress }`;
    try {
      const {code, stdout} = await runImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {timeoutMs: 15000});
      if (code !== 0 || !stdout.trim()) return null;
      const data = JSON.parse(stdout.trim());
      return {pid, executable: data.exe || null, startTime: data.start || null, commandLine: data.cmd || null};
    } catch { return null; }
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    let executable = null; try { executable = fs.readlinkSync(`/proc/${pid}/exe`); } catch { /* 无权限 */ }
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return {pid, executable, startTime: `ticks:${fields[19]}`, commandLine: cmd};
  } catch { return null; }
}
async function killTree(pid, {platform = process.platform, force = false, runImpl = run} = {}) {
  if (platform === 'win32') {
    const args = ['/PID', String(pid), '/T']; if (force) args.push('/F');
    const result = await runImpl('taskkill.exe', args, {timeoutMs: 20000});
    return result.code === 0;
  }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); return true; } catch { return false; }
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
module.exports = {run, processIdentity, killTree, isAlive};
