'use strict';
// R05：插件清单。目录、Git 来源、版本、启用状态、本地修改、requirements、是否已被 Comfy 加载。
// 禁用＝把目录移动到 custom_nodes/.disabled/ 并写标记（可恢复），需要重启 Comfy 生效；不删除任何文件。
// 修改目录须在 U04 维护事务内进行（调用方负责持有环境锁）。
const fs = require('node:fs');
const path = require('node:path');
const {gitDetails} = require('../maintenance/env-manifest.cjs');
const {writeJsonAtomic} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');
const {run} = require('../services/process-utils.cjs');

const DISABLED_DIR = '.disabled';

function readVersion(dir) {
  const py = path.join(dir, 'pyproject.toml');
  if (fs.existsSync(py)) { const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(fs.readFileSync(py, 'utf8')); if (m) return {version: m[1], from: 'pyproject.toml'}; }
  return {version: null, from: null};
}
function readRequirements(dir) {
  const f = path.join(dir, 'requirements.txt');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.replace(/#.*/, '').trim()).filter(Boolean);
}

/** 从 /object_info 得到已加载插件：python_module 形如 "custom_nodes.<dir>"。 */
function loadedModules(objectInfo) {
  const loaded = new Map();
  for (const [node, info] of Object.entries(objectInfo ?? {})) {
    const m = /^custom_nodes\.([^.]+)/.exec(info?.python_module ?? '');
    if (m) { if (!loaded.has(m[1])) loaded.set(m[1], []); loaded.get(m[1]).push(node); }
  }
  return loaded;
}

async function listPlugins({comfyRoot, objectInfo, runImpl = run}) {
  const nodesDir = path.join(comfyRoot, 'custom_nodes');
  if (!fs.existsSync(nodesDir)) throw new AppError(CODES.NOT_FOUND, `custom_nodes 不存在：${nodesDir}`);
  const loaded = objectInfo ? loadedModules(objectInfo) : null;
  const out = [];
  const add = async (dir, name, enabled, disabledVia) => {
    const git = await gitDetails(dir, runImpl);
    const v = readVersion(dir);
    const marker = path.join(dir, '.yingzuo-disabled.json');
    out.push({name, path: dir, enabled, disabledVia, version: v.version, versionFrom: v.from,
      git: git.present ? {remote: git.remote, head: git.head, branch: git.branch} : null,
      localChanges: git.present ? git.dirty : null,
      requirements: readRequirements(dir),
      loaded: loaded ? (loaded.has(name) ? 'loaded' : 'not-loaded') : 'unknown',
      nodeTypes: loaded?.get(name) ?? [],
      disabledInfo: fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null});
  };
  for (const d of fs.readdirSync(nodesDir, {withFileTypes: true})) {
    if (!d.isDirectory() || d.name === '__pycache__' || d.name === DISABLED_DIR) continue;
    if (d.name.startsWith('.')) continue;
    // ComfyUI-Manager 约定：目录名以 .disabled 结尾表示禁用
    if (d.name.endsWith('.disabled')) await add(path.join(nodesDir, d.name), d.name.slice(0, -9), false, 'suffix');
    else await add(path.join(nodesDir, d.name), d.name, true, null);
  }
  const disDir = path.join(nodesDir, DISABLED_DIR);
  if (fs.existsSync(disDir)) for (const d of fs.readdirSync(disDir, {withFileTypes: true})) if (d.isDirectory()) await add(path.join(disDir, d.name), d.name, false, 'folder');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function assertName(name) { if (!name || /[\\/]|^\.\.?$/.test(name)) throw new AppError(CODES.INVALID_ARGUMENT, `插件名无效：${name}`); }

function disablePlugin({comfyRoot, name, reason = '', now = () => new Date().toISOString()}) {
  assertName(name);
  const nodesDir = path.join(comfyRoot, 'custom_nodes');
  const from = path.join(nodesDir, name), to = path.join(nodesDir, DISABLED_DIR, name);
  if (!fs.existsSync(from)) throw new AppError(CODES.NOT_FOUND, `插件不存在或已禁用：${name}`);
  if (fs.existsSync(to)) throw new AppError(CODES.CONFLICT, `${DISABLED_DIR} 中已有同名插件：${name}`);
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.renameSync(from, to);
  writeJsonAtomic(path.join(to, '.yingzuo-disabled.json'), {disabledAt: now(), reason, originalPath: from});
  return {name, enabled: false, path: to, needsRestart: true, message: '已禁用，重启 ComfyUI 后生效。'};
}

function enablePlugin({comfyRoot, name}) {
  assertName(name);
  const nodesDir = path.join(comfyRoot, 'custom_nodes');
  const from = path.join(nodesDir, DISABLED_DIR, name), to = path.join(nodesDir, name);
  if (!fs.existsSync(from)) throw new AppError(CODES.NOT_FOUND, `未找到已禁用的插件：${name}`);
  if (fs.existsSync(to)) throw new AppError(CODES.CONFLICT, `已有同名启用插件：${name}`);
  fs.renameSync(from, to);
  fs.rmSync(path.join(to, '.yingzuo-disabled.json'), {force: true});
  return {name, enabled: true, path: to, needsRestart: true, message: '已启用，重启 ComfyUI 后生效。'};
}

module.exports = {listPlugins, disablePlugin, enablePlugin, loadedModules, DISABLED_DIR};
