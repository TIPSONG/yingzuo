'use strict';
// F01：开发／运行环境登记。只记录版本、路径存在性与哈希，不读取或输出凭据。
const fs = require('node:fs');
const path = require('node:path');
const {run} = require('./process-utils.cjs');
const {sha256File} = require('../core/fs-atomic.cjs');
const TEMPLATE_FILES = ['Qwen 2.1 Q6_K - Text to Image.json', 'Qwen 2.1 Q6_K - Multi Image Edit.json', 'Qwen 2.1 Q6_K + Gemma - Text to Image.json', 'Qwen 2.1 Q6_K + Gemma - Multi Image Edit.json', 'Gemma 4 - Prompt Enhancer.json'];
const GEMMA_PLUGIN = 'comfyui-lmstudio-prompt-enhancer';

async function gitInfo(dir, runImpl = run) {
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return {present: false};
  const git = async args => { try { const r = await runImpl('git', ['-C', dir, ...args], {timeoutMs: 15000}); return r.code === 0 ? r.stdout.trim() : null; } catch { return null; } };
  const status = await git(['status', '--porcelain']);
  return {present: true, head: await git(['rev-parse', 'HEAD']), branch: await git(['rev-parse', '--abbrev-ref', 'HEAD']), remote: (await git(['remote', 'get-url', 'origin']))?.replace(/\/\/[^@/]+@/, '//') ?? null, dirtyFiles: status === null ? null : status.split('\n').filter(Boolean).length};
}
async function fileRecord(file) {
  if (!file || !fs.existsSync(file)) return {path: file || null, exists: false};
  const st = fs.statSync(file);
  return {path: file, exists: true, size: st.size, mtime: st.mtime.toISOString(), sha256: st.size < 64 * 1024 * 1024 ? await sha256File(file) : null};
}
async function collectEnvironmentRecord({root, configRepo, layout, runImpl = run}) {
  const config = configRepo.config, derived = configRepo.derived(layout);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const templates = [];
  for (const name of TEMPLATE_FILES) templates.push({name, ...(await fileRecord(derived.workflows ? path.join(derived.workflows, name) : ''))});
  const pluginDir = derived.customNodes ? path.join(derived.customNodes, GEMMA_PLUGIN) : '';
  const baselineDir = path.join(root, '.local', 'p0-baseline');
  return {
    collectedAt: new Date().toISOString(),
    app: {name: pkg.name, version: pkg.version, dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {}, git: await gitInfo(root, runImpl)},
    runtime: {node: process.versions.node, electron: process.versions.electron ?? null, chrome: process.versions.chrome ?? null, platform: process.platform, arch: process.arch},
    comfy: {root: config.comfy.root || null, rootExists: !!config.comfy.root && fs.existsSync(config.comfy.root), python: await fileRecord(config.comfy.python), git: await gitInfo(config.comfy.root, runImpl), url: config.comfy.url},
    templates,
    gemma: {plugin: {path: pluginDir || null, exists: !!pluginDir && fs.existsSync(pluginDir), git: await gitInfo(pluginDir, runImpl)}, patch: await fileRecord(config.gemma.patchFile), contextLength: config.gemma.contextLength},
    lmstudio: {url: config.lmstudio.url, cliConfigured: !!config.lmstudio.cli},
    baseline: {dir: baselineDir, exists: fs.existsSync(baselineDir), note: 'P0 原部署保护基线（12 文件）由 tools/p0_baseline.py 维护，本记录不修改它。'},
  };
}
module.exports = {collectEnvironmentRecord, gitInfo, fileRecord, TEMPLATE_FILES, GEMMA_PLUGIN};
