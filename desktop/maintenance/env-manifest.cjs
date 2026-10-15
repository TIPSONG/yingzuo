'use strict';
// U01：环境清单。记录 Comfy 核心／前端、插件（含未提交改动）、Python 路径与依赖、配置、补丁、外部资源边界。
// 与 F01 的 environment-record 不同：这里是“可用于备份／恢复”的完整清单，缺项会写进 gaps 并令 complete=false，
// 不允许用旧基线冒充完整清单。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {run} = require('../services/process-utils.cjs');
const {sha256File} = require('../core/fs-atomic.cjs');

const MANIFEST_VERSION = 1;
const WEIGHT_EXTENSIONS = ['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin', '.onnx', '.sft', '.pkl'];

async function gitDetails(dir, runImpl = run) {
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return {present: false};
  const git = async args => { try { const r = await runImpl('git', ['-C', dir, ...args], {timeoutMs: 20000}); return r.code === 0 ? r.stdout : null; } catch { return null; } };
  const status = await git(['status', '--porcelain', '--untracked-files=all']);
  const diff = await git(['diff', 'HEAD', '--binary']);
  const trim = v => (v == null ? null : v.trim());
  return {
    present: true,
    head: trim(await git(['rev-parse', 'HEAD'])),
    branch: trim(await git(['rev-parse', '--abbrev-ref', 'HEAD'])),
    remote: trim(await git(['remote', 'get-url', 'origin']))?.replace(/\/\/[^@/]+@/, '//') ?? null,
    dirty: status === null ? null : status.split('\n').filter(Boolean).map(l => ({status: l.slice(0, 2).trim(), file: l.slice(3)})),
    diffSha256: diff ? crypto.createHash('sha256').update(diff).digest('hex') : null,
  };
}

async function fileEntry(file) {
  if (!file || !fs.existsSync(file)) return {path: file || null, exists: false};
  const st = fs.statSync(file);
  return {path: path.resolve(file), exists: true, size: st.size, sha256: st.isFile() ? await sha256File(file) : null};
}

function readFrontendVersion(comfyRoot) {
  const req = path.join(comfyRoot, 'requirements.txt');
  if (!fs.existsSync(req)) return null;
  const m = /comfyui[-_]frontend[-_]package\s*==\s*([\w.]+)/i.exec(fs.readFileSync(req, 'utf8'));
  return m ? m[1] : null;
}

function readPluginVersion(dir) {
  const py = path.join(dir, 'pyproject.toml');
  if (fs.existsSync(py)) { const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(fs.readFileSync(py, 'utf8')); if (m) return m[1]; }
  return null;
}

async function pythonDetails(python, runImpl) {
  if (!python) return {configured: false};
  const exists = fs.existsSync(python);
  const out = {configured: true, path: path.resolve(python), exists, version: null, packages: null, prefix: null, basePrefix: null};
  if (!exists) return out;
  try {
    const r = await runImpl(python, ['-c', 'import sys,json;print(json.dumps([sys.version.split()[0],sys.prefix,sys.base_prefix]))'], {timeoutMs: 20000});
    if (r.code === 0) [out.version, out.prefix, out.basePrefix] = JSON.parse(r.stdout.trim());
  } catch { /* 记录为未知 */ }
  try {
    const r = await runImpl(python, ['-m', 'pip', 'freeze', '--all'], {timeoutMs: 120000});
    if (r.code === 0) out.packages = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { /* 记录为未知 */ }
  // venv 不能搬家：恢复必须回到原绝对路径，并依赖外部基础 Python。
  out.isVenv = !!out.prefix && !!out.basePrefix && out.prefix !== out.basePrefix;
  return out;
}

/**
 * @param {object} o
 * @param {string} o.comfyRoot  ComfyUI 根目录
 * @param {string} [o.python]   Comfy 使用的 python 可执行文件
 * @param {string[]} [o.configFiles] 额外配置（extra_model_paths.yaml、comfy.settings.json 等）；默认自动探测
 * @param {string[]} [o.patches] 本地补丁文件
 * @param {string[]} [o.modelDirs] 外部模型目录（只登记边界，不备份）
 */
async function collectManifest({comfyRoot, python, configFiles, patches = [], modelDirs = [], runImpl = run, now = () => new Date().toISOString()}) {
  const gaps = [];
  if (!comfyRoot || !fs.existsSync(comfyRoot)) gaps.push({part: 'comfy.core', reason: 'Comfy 根目录不存在或未配置'});
  const root = comfyRoot ? path.resolve(comfyRoot) : null;
  const core = root && fs.existsSync(root) ? {root, git: await gitDetails(root, runImpl), frontendVersion: readFrontendVersion(root)} : {root, git: {present: false}, frontendVersion: null};
  if (root && !core.git.present) gaps.push({part: 'comfy.core.git', reason: '核心目录不是 Git 仓库，无法记录版本与未提交改动；备份将按完整文件复制'});
  if (root && !core.frontendVersion) gaps.push({part: 'comfy.frontend', reason: '未能从 requirements.txt 读出前端包版本'});

  const plugins = [];
  const nodesDir = root ? path.join(root, 'custom_nodes') : null;
  if (nodesDir && fs.existsSync(nodesDir)) {
    for (const d of fs.readdirSync(nodesDir, {withFileTypes: true})) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === '__pycache__') continue;
      const dir = path.join(nodesDir, d.name);
      const req = path.join(dir, 'requirements.txt');
      plugins.push({name: d.name, path: dir, enabled: !d.name.endsWith('.disabled'), version: readPluginVersion(dir), git: await gitDetails(dir, runImpl), requirements: fs.existsSync(req) ? await fileEntry(req) : null});
    }
  }

  const py = await pythonDetails(python, runImpl);
  if (!py.configured) gaps.push({part: 'python', reason: '未配置 Comfy 使用的 Python'});
  else if (!py.exists) gaps.push({part: 'python', reason: 'Python 路径不存在'});
  else if (!py.packages) gaps.push({part: 'python.packages', reason: 'pip freeze 失败，依赖未记录'});

  const autoConfigs = root ? [path.join(root, 'extra_model_paths.yaml'), path.join(root, 'user', 'default', 'comfy.settings.json')] : [];
  const configs = [];
  for (const f of configFiles ?? autoConfigs) { const e = await fileEntry(f); if (e.exists || configFiles) configs.push(e); }
  const patchEntries = [];
  for (const f of patches) { const e = await fileEntry(f); if (!e.exists) gaps.push({part: 'patch', reason: `补丁不存在：${f}`}); patchEntries.push(e); }

  return {
    manifestVersion: MANIFEST_VERSION,
    collectedAt: now(),
    platform: {os: process.platform, arch: process.arch},
    comfy: core,
    plugins,
    python: py,
    configs,
    patches: patchEntries,
    external: {
      // 边界：以下内容不进入备份，恢复时作为外部前置条件核对。
      modelDirs: modelDirs.map(d => ({path: path.resolve(d), exists: fs.existsSync(d)})),
      weightExtensions: WEIGHT_EXTENSIONS,
      basePython: py.isVenv ? py.basePrefix : null,
      notes: ['模型权重不备份', py.isVenv ? 'venv 只能恢复到原绝对路径，需要原基础 Python 仍存在' : null].filter(Boolean),
    },
    gaps,
    complete: gaps.length === 0,
  };
}

module.exports = {collectManifest, gitDetails, fileEntry, readFrontendVersion, MANIFEST_VERSION, WEIGHT_EXTENSIONS};
