'use strict';
// T05–T07：实时诊断清单、替代建议、单字段修复与撤销。
// 清单来源：ComfyUI object_info（节点类型与所属插件模块）、/models/<目录>（模型文件）、LM Studio /v1/models。
// 每个来源单独记录采集时间；离线时使用上次缓存并标注“缓存”。替代建议沿用 compatibility.js 的保守规则。
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../core/errors.cjs');
const {writeJsonAtomic} = require('../core/fs-atomic.cjs');
const Compat = require('../../compatibility.js');

const FOLDER_ROLE = {diffusion_models: 'diffusion', unet: 'diffusion', text_encoders: 'encoder', clip: 'encoder', vae: 'vae', loras: 'lora', checkpoints: 'checkpoint'};
const ext = name => (String(name).split('.').pop() || '').toLowerCase();

async function collectCatalog({client, fetchImpl, lmUrl, cacheFile, now = () => new Date().toISOString()}) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* 没有缓存 */ }
  const sources = {};
  const out = {nodeTypes: [], plugins: [], models: []};
  // 1. object_info
  try {
    const info = await client.objectInfo();
    out.nodeTypes = Object.keys(info);
    const plugins = new Map();
    for (const [type, def] of Object.entries(info)) { const mod = String(def.python_module ?? 'nodes'); const name = mod.startsWith('custom_nodes.') ? mod.slice(13).split('.')[0] : mod.startsWith('comfy_extras') || mod === 'nodes' || mod.startsWith('comfy_api') ? '(内置)' : mod; if (!plugins.has(name)) plugins.set(name, []); plugins.get(name).push(type); }
    out.plugins = [...plugins].map(([name, types]) => ({name, nodeCount: types.length, version: null}));
    sources.objectInfo = {ok: true, collectedAt: now(), count: out.nodeTypes.length};
  } catch (e) {
    sources.objectInfo = {ok: false, error: e.message, cached: !!cache?.nodeTypes, collectedAt: cache?.sources?.objectInfo?.collectedAt ?? null};
    if (cache) { out.nodeTypes = cache.nodeTypes ?? []; out.plugins = cache.plugins ?? []; }
  }
  // 2. 模型目录
  try {
    const folders = await client.models();
    const models = [];
    for (const folder of folders.filter(f => FOLDER_ROLE[f])) {
      for (const name of await client.models(folder)) models.push({id: `${folder}/${name}`, value: name, role: FOLDER_ROLE[folder], format: ext(name), folder: `ComfyUI/models/${folder}`, evidence: 'ComfyUI /models 实时清单'});
    }
    out.models.push(...models);
    sources.models = {ok: true, collectedAt: now(), count: models.length};
  } catch (e) {
    sources.models = {ok: false, error: e.message, cached: !!cache, collectedAt: cache?.sources?.models?.collectedAt ?? null};
    if (cache) out.models.push(...(cache.models ?? []).filter(m => m.role !== 'language'));
  }
  // 3. LM Studio
  try {
    const r = await fetchImpl(new URL('models', lmUrl.endsWith('/') ? lmUrl : `${lmUrl}/`), {signal: AbortSignal.timeout(5000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = (await r.json()).data ?? [];
    const lm = list.filter(m => !/embed/i.test(m.id)).map(m => ({id: `lmstudio:${m.id}`, value: m.id, role: 'language', format: 'gguf', folder: 'LM Studio', evidence: 'LM Studio /v1/models 实时清单'}));
    out.models.push(...lm);
    sources.lmstudio = {ok: true, collectedAt: now(), count: lm.length};
  } catch (e) {
    sources.lmstudio = {ok: false, error: e.message, cached: !!cache, collectedAt: cache?.sources?.lmstudio?.collectedAt ?? null};
    if (cache) out.models.push(...(cache.models ?? []).filter(m => m.role === 'language'));
  }
  const catalog = {...out, sources, checkedAt: now(), runtimeChecked: Object.values(sources).some(s => s.ok)};
  if (catalog.runtimeChecked) {
    // 只用成功的来源更新缓存，失败的来源保留旧缓存
    const merged = {...catalog, sources: Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, s.ok ? s : (cache?.sources?.[k] ?? s)]))};
    writeJsonAtomic(cacheFile, merged);
  }
  return catalog;
}

function createDiagnosticsService({editor, client, fetchImpl, configRepo, layout, dialog, getWindow}) {
  const cacheFile = path.join(layout.root, 'diagnostics-cache.json');
  const undo = new Map(); // tabId → [{before, revisionAfter, change}]
  let lastCatalog = null;
  const tabGraph = tabId => editor.enqueue(() => editor.commands.tabGraph(tabId));
  async function catalog(refresh = false) {
    if (!lastCatalog || refresh) lastCatalog = await collectCatalog({client: client(), fetchImpl, lmUrl: configRepo.config.lmstudio.url, cacheFile});
    return lastCatalog;
  }
  async function analyse(tabId, refresh) {
    const [t, cat] = [await tabGraph(tabId), await catalog(refresh)];
    const result = Compat.analyse(t.graph, cat);
    return {tabId: t.tabId, revision: (editor.workspace?.tabs?.find(x => x.id === t.tabId)?.revision) ?? null, ...result, catalog: {sources: cat.sources, checkedAt: cat.checkedAt, nodeTypes: cat.nodeTypes.length, models: cat.models.length, plugins: cat.plugins}};
  }
  const methods = {
    'templates.diagnose': (tabId, {refresh = false} = {}) => analyse(tabId, refresh),
    'templates.catalog': async ({refresh = false} = {}) => { const c = await catalog(refresh); return {sources: c.sources, checkedAt: c.checkedAt, plugins: c.plugins, models: c.models}; },
    /** T07：应用单个候选（单字段），记录撤销信息并自动复查。 */
    'templates.applyFix': async (tabId, issueKey, candidateId, expectedRevision) => {
      const t = await tabGraph(tabId);
      const cat = await catalog();
      let plan, next;
      try { plan = Compat.plan(t.graph, cat, issueKey, candidateId); next = Compat.patch(t.graph, plan.path, plan.before, plan.after); }
      catch (e) { throw new AppError(CODES.CONFLICT, e.message); }
      const r = await editor.enqueue(() => editor.commands.replaceGraph(t.tabId, next, expectedRevision));
      const stack = undo.get(t.tabId) ?? []; stack.push({before: t.graph, revisionAfter: r.revision, change: plan}); undo.set(t.tabId, stack.slice(-20));
      return {applied: plan, recheck: await analyse(t.tabId, false), canUndo: true};
    },
    'templates.undoFix': async tabId => {
      const id = tabId ?? editor.workspace?.activeId;
      const stack = undo.get(id) ?? [];
      const last = stack.at(-1);
      if (!last) throw new AppError(CODES.NOT_FOUND, '没有可撤销的修复。');
      try { await editor.enqueue(() => editor.commands.replaceGraph(id, last.before, last.revisionAfter)); }
      catch (e) { throw new AppError(CODES.CONFLICT, `修复后标签又被修改过，不能直接撤销：${e.message}`); }
      stack.pop();
      return {undone: last.change, recheck: await analyse(id, false), canUndo: stack.length > 0};
    },
    'templates.exportFixed': async tabId => {
      const t = await tabGraph(tabId);
      const r = await dialog.showSaveDialog(getWindow(), {title: '导出修复副本', defaultPath: `${t.title}-修复.json`, filters: [{name: 'ComfyUI 工作流', extensions: ['json']}]});
      if (r.canceled || !r.filePath) return {cancelled: true};
      const ex = editor?.exportCopy ? editor.exportCopy(t.graph) : {graph: t.graph, refill: []};
      fs.writeFileSync(r.filePath, JSON.stringify(ex.graph, null, 2));
      return {path: r.filePath, refill: ex.refill};
    },
  };
  return {methods, collectCatalog: catalog};
}
module.exports = {createDiagnosticsService, collectCatalog};
