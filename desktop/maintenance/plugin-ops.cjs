'use strict';
// R06/R07/U06：插件与 ComfyUI 的安装/更新/移除步骤（受限 Git 后端）。只提供 stage/apply/check 步骤，
// 必须由 MaintenanceTransaction 执行（备份 → staging → apply → check，失败自动恢复）。
// 规则：只接受 https Git 地址；版本固定到明确 revision；本地改动先保存为补丁，更新后重放，冲突进入“待处理”且保留补丁，不丢弃；
// Python 依赖用 Comfy 自己的 python -m pip 安装，并把 Python 环境目录纳入同一事务的备份范围。
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {AppError, CODES} = require('../core/errors.cjs');
const {DISABLED_DIR} = require('../resources/plugin-inventory.cjs');

function run(cmd, args, {cwd, timeoutMs = 600000, env} = {}) {
  return new Promise((resolve, reject) => execFile(cmd, args, {cwd, shell: false, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: {...process.env, GIT_TERMINAL_PROMPT: '0', ...env}}, (err, stdout, stderr) => err ? reject(Object.assign(new AppError(CODES.INTERNAL, `${path.basename(cmd)} ${args[0]} 失败：${(stderr || err.message).trim().slice(0, 2000)}`), {stdout, stderr})) : resolve({stdout: stdout.trim(), stderr: stderr.trim()})));
}
const git = (cwd, args, o = {}) => run(o.gitPath ?? 'git', ['-C', cwd, ...args], o);
function assertGitUrl(url, {allowLocal = false} = {}) {
  if (allowLocal && path.isAbsolute(url)) return url;
  let u; try { u = new URL(url); } catch { throw new AppError(CODES.INVALID_ARGUMENT, '仓库地址无效。'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new AppError(CODES.FORBIDDEN, '只接受不含账号信息的 https Git 地址。');
  return u.href.replace(/\/$/, '');
}
const pluginNameFromUrl = url => path.basename(String(url).replace(/\/$/, '').replace(/\.git$/, ''));
/** Python 环境目录（venv 或便携版 python_embeded），用于纳入备份范围。 */
function pythonEnvDir(python) {
  if (!python) return null;
  const dir = path.dirname(python);
  return /^(Scripts|bin)$/i.test(path.basename(dir)) ? path.dirname(dir) : dir;
}
async function pipInstall({python, requirements, cwd}) {
  if (!python || !fs.existsSync(python)) throw new AppError(CODES.NOT_FOUND, '未配置 ComfyUI 的 Python，无法安装依赖。');
  return run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], {cwd, timeoutMs: 1800000});
}

/** R07 安装：staging 克隆到固定 revision → apply 改名进入 custom_nodes → 可选安装依赖。 */
function installPlan({comfyRoot, url, revision = null, python = null, installDeps = false, stagingRoot, allowLocal}) {
  const src = assertGitUrl(url, {allowLocal});
  const name = pluginNameFromUrl(src);
  if (!/^[\w.-]+$/.test(name)) throw new AppError(CODES.INVALID_ARGUMENT, `插件目录名无效：${name}`);
  const nodes = path.join(comfyRoot, 'custom_nodes'), target = path.join(nodes, name);
  if (fs.existsSync(target) || fs.existsSync(path.join(nodes, DISABLED_DIR, name))) throw new AppError(CODES.CONFLICT, `已存在同名插件：${name}`);
  const staging = path.join(stagingRoot, `install-${name}-${Date.now()}`);
  const envDir = installDeps ? pythonEnvDir(python) : null;
  return {
    title: `安装插件 ${name}`, kind: 'plugin-install', target: name,
    roots: [nodes, ...(envDir ? [envDir] : [])], backupRoots: [...(envDir ? [envDir] : [])], requiredBytes: 512 * 1024 * 1024,
    async stage(ctx) {
      await run('git', ['clone', '--quiet', src, staging], {timeoutMs: 600000});
      if (revision) await git(staging, ['checkout', '--quiet', revision]);
      ctx.revision = (await git(staging, ['rev-parse', 'HEAD'])).stdout;
      ctx.log.push(`已克隆 ${src} @ ${ctx.revision}`);
    },
    async apply(ctx) {
      fs.renameSync(staging, target);
      ctx.log.push(`已放入 ${target}`);
      const req = path.join(target, 'requirements.txt');
      if (installDeps && fs.existsSync(req)) { await pipInstall({python, requirements: req, cwd: target}); ctx.log.push('已安装 Python 依赖'); }
      else if (fs.existsSync(req)) ctx.log.push('插件有 requirements.txt，未安装依赖（未勾选）。');
    },
    async check() { return fs.existsSync(path.join(target, '__init__.py')) || fs.readdirSync(target).some(f => f.endsWith('.py')); },
    cleanup() { fs.rmSync(staging, {recursive: true, force: true}); },
    result: () => ({name, path: target, needsRestart: true}),
  };
}
/** R07 移除：移到可恢复区（trash），不删除。 */
function removePlan({comfyRoot, name, trashDir}) {
  if (!/^[\w.-]+$/.test(name)) throw new AppError(CODES.INVALID_ARGUMENT, '插件名无效。');
  const nodes = path.join(comfyRoot, 'custom_nodes');
  const from = [path.join(nodes, name), path.join(nodes, DISABLED_DIR, name)].find(p => fs.existsSync(p));
  if (!from) throw new AppError(CODES.NOT_FOUND, `插件不存在：${name}`);
  const to = path.join(trashDir, 'plugins', `${name}-${Date.now()}`);
  return {title: `移除插件 ${name}`, kind: 'plugin-remove', target: name, roots: [nodes], backupRoots: [], requiredBytes: 0,
    async apply(ctx) { fs.mkdirSync(path.dirname(to), {recursive: true}); try { fs.renameSync(from, to); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(from, to, {recursive: true}); fs.rmSync(from, {recursive: true}); } ctx.log.push(`已移到可恢复区 ${to}`); },
    async check() { return !fs.existsSync(from) && fs.existsSync(to); },
    result: () => ({name, trashPath: to, needsRestart: true})};
}
/** U06/R07 更新 Git 仓库（Comfy 本体或插件）到目标 revision；本地改动保存为补丁并重放。 */
function updatePlan({repoDir, revision, python = null, patchesDir, title, kind = 'update', updateDeps = true, fetch = true}) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) throw new AppError(CODES.UNSUPPORTED, '不是 Git 仓库，无法按 revision 更新。');
  const envDir = updateDeps ? pythonEnvDir(python) : null;
  const plan = {title: title ?? `更新 ${path.basename(repoDir)}`, kind, target: repoDir, roots: [repoDir, ...(envDir ? [envDir] : [])], backupRoots: envDir ? [envDir] : [], requiredBytes: 256 * 1024 * 1024, pending: null,
    async stage(ctx) {
      if (fetch) await git(repoDir, ['fetch', '--quiet', '--tags', 'origin'], {timeoutMs: 300000});
      ctx.target = (await git(repoDir, ['rev-parse', `${revision}^{commit}`])).stdout;
      ctx.before = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout;
      const diff = (await git(repoDir, ['diff', '--binary', 'HEAD'])).stdout;
      ctx.patchFile = null;
      if (diff) { fs.mkdirSync(patchesDir, {recursive: true}); ctx.patchFile = path.join(patchesDir, `${path.basename(repoDir)}-${ctx.before.slice(0, 8)}-${Date.now()}.patch`); fs.writeFileSync(ctx.patchFile, diff + '\n'); ctx.log.push(`本地改动已保存为补丁 ${ctx.patchFile}`); }
      ctx.reqBefore = await git(repoDir, ['show', `${ctx.before}:requirements.txt`]).then(r => r.stdout, () => null);
      ctx.reqAfter = await git(repoDir, ['show', `${ctx.target}:requirements.txt`]).then(r => r.stdout, () => null);
    },
    async apply(ctx) {
      // 本地改动已在补丁文件和事务备份中，强制切换（不依赖 git 用户身份，不用 stash）
      await git(repoDir, ['checkout', '--quiet', '--force', '--detach', ctx.target]);
      if (ctx.patchFile) {
        try { await git(repoDir, ['apply', '--3way', ctx.patchFile]); ctx.log.push('本地改动已重放'); }
        catch (e) {
          // 冲突：保留补丁进入待处理，不舍弃；工作区回到干净的目标版本，由用户决定（事务不回滚更新本身）
          await git(repoDir, ['checkout', '--quiet', '--', '.']).catch(() => {});
          await git(repoDir, ['reset', '--quiet', '--hard', ctx.target]).catch(() => {});
          plan.pending = {patchFile: ctx.patchFile, reason: e.message.slice(0, 1000)};
          ctx.log.push('补丁重放冲突，已列入待处理');
        }
      }
      if (updateDeps && ctx.reqAfter !== null && ctx.reqAfter !== ctx.reqBefore) { await pipInstall({python, requirements: path.join(repoDir, 'requirements.txt'), cwd: repoDir}); ctx.log.push('requirements.txt 有变化，已安装依赖'); }
    },
    async check(ctx) { return (await git(repoDir, ['rev-parse', 'HEAD'])).stdout === ctx.target; },
    result: () => ({repo: repoDir, pending: plan.pending, needsRestart: true}),
  };
  return plan;
}
module.exports = {installPlan, removePlan, updatePlan, pythonEnvDir, assertGitUrl, pluginNameFromUrl, run, git};
