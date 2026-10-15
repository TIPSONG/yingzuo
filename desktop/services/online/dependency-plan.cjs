'use strict';
// T08 依赖补齐计划、O08 联合补齐（仅模型部分）、R06 Manager 探测（只读）。
// 插件安装/启用需要环境事务（U01–U04、R07，由 maint 分支实现），这里不执行任何插件操作，只给出手动处理说明。
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../../core/errors.cjs');
const Compat = require('../../../compatibility.js');

const ROLE_FOLDER = {diffusion: 'diffusion_models', encoder: 'text_encoders', vae: 'vae', lora: 'loras', checkpoint: 'checkpoints'};

/** 从诊断结果生成补齐计划：缺失节点（手动/待插件事务）与缺失模型（需选择来源）。 */
function buildPlan(analysis) {
  const models = new Map(), nodes = new Map();
  for (const i of analysis.issues) {
    if (i.code === 'unknown-node') nodes.set(i.nodeType, {nodeType: i.nodeType, count: (nodes.get(i.nodeType)?.count ?? 0) + 1, action: 'manual', reason: '需要安装对应插件。插件安装须经环境备份事务，当前版本请在 ComfyUI-Manager 中手动安装后重新诊断。'});
    if (i.code === 'not-in-catalog' && i.role !== 'language' && typeof i.value === 'string') {
      const key = `${i.role}:${path.basename(i.value)}`;
      if (!models.has(key)) models.set(key, {value: i.value, name: path.basename(i.value.replace(/\\/g, '/')), role: i.role, folder: ROLE_FOLDER[i.role] ?? null, nodes: [], localCandidates: i.candidates?.filter(c => c.canApply).map(c => c.value) ?? [], source: null});
      models.get(key).nodes.push(i.nodeId);
    }
    if (i.code === 'not-in-catalog' && i.role === 'language') nodes.set(`lm:${i.value}`, {nodeType: `LM Studio 模型 ${i.value}`, action: 'manual', reason: 'LM Studio 模型不放入 ComfyUI 目录；请在 LM Studio 中下载并加载。'});
  }
  return {models: [...models.values()], nodes: [...nodes.values()], createdAt: new Date().toISOString()};
}
/** 只接受文件名完全一致的来源（HF 仓库内同名权重文件），并给出大小/sha256/revision 供用户选择。 */
async function findSources(hf, name, {limit = 6} = {}) {
  const stem = name.replace(/\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i, '').replace(/[-_.](Q\d.*|fp16|bf16|fp8.*|int8.*)$/i, '');
  const res = await hf.search(stem, {limit});
  const out = [];
  for (const item of res.items.slice(0, limit)) {
    try {
      const d = await hf.detail(item.id);
      for (const f of d.files) if (path.basename(f.path) === name) out.push({provider: 'huggingface', repo: d.id, revision: d.revision, path: f.path, size: f.size, sha256: f.sha256, license: d.license, gated: d.gated});
    } catch { /* 单个仓库失败不影响其余 */ }
  }
  return out;
}
/** R06：只读探测已安装的 ComfyUI-Manager（目录、版本、cm-cli）。不调用其 HTTP 接口。 */
function detectManager(customNodesDir) {
  if (!customNodesDir || !fs.existsSync(customNodesDir)) return {installed: false, reason: '未配置或找不到 custom_nodes 目录。'};
  const dir = fs.readdirSync(customNodesDir).find(n => /^comfyui-manager$/i.test(n));
  if (!dir) return {installed: false, reason: '未发现 ComfyUI-Manager。不会自动安装另一个 Manager。'};
  const full = path.join(customNodesDir, dir);
  let version = null;
  try { version = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(full, 'pyproject.toml'), 'utf8'))?.[1] ?? null; } catch { /* 无 pyproject */ }
  const cli = ['cm-cli.py', path.join('cm_cli', '__main__.py')].find(f => fs.existsSync(path.join(full, f))) ?? null;
  return {installed: true, path: full, version, cli, capabilities: {cli: !!cli, http: 'unverified'}, note: 'Manager 的 HTTP/CLI 接口因版本差异未做猜测性调用；插件安装/更新/移除统一走映作的受限 Git 维护事务（R07），可备份与回滚。'};
}
function createDependencyService({editor, diagnostics, online, configRepo, layout}) {
  const methods = {
    'templates.dependencyPlan': async tabId => {
      const t = await editor.enqueue(() => editor.commands.tabGraph(tabId));
      const cat = await diagnostics.collectCatalog(true);
      return {...buildPlan(Compat.analyse(t.graph, cat)), catalogSources: cat.sources, manager: detectManager(configRepo.derived(layout).customNodes)};
    },
    'templates.findModelSources': async name => { if (typeof name !== 'string' || !name || name.length > 300) throw new AppError(CODES.INVALID_ARGUMENT, '文件名无效。'); return findSources(online.providers.byId.huggingface, path.basename(name)); },
    /** O08（模型部分）：按用户确认的来源依次加入下载；逐项返回结果，不合并成“全部成功”。 */
    'templates.applyDependencyPlan': async items => {
      if (!Array.isArray(items) || !items.length || items.length > 50) throw new AppError(CODES.INVALID_ARGUMENT, '请先为缺失模型选择来源。');
      const results = [];
      for (const it of items) {
        try {
          const d = await online.methods['downloads.add']({ref: {provider: 'huggingface', repo: it.source.repo, revision: it.source.revision}, file: {path: it.source.path, size: it.source.size, sha256: it.source.sha256}, role: it.role});
          results.push({name: it.name, ok: true, downloadId: d.id});
        } catch (e) { results.push({name: it.name, ok: false, error: e.message}); }
      }
      return {results, note: '下载完成后请重新诊断；插件缺失项需手动处理。'};
    },
    'templates.detectManager': async () => detectManager(configRepo.derived(layout).customNodes),
  };
  return {methods};
}
module.exports = {buildPlan, findSources, detectManager, createDependencyService};
