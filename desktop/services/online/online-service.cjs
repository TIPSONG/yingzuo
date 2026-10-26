'use strict';
// O04 下载规划、O01–O06 接口组装（downloads.*）、O07 在线模板导入（templates.importOnline）。
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../../core/errors.cjs');
const {validateSegment} = require('../../core/paths.cjs');
const {createProviders} = require('./providers.cjs');
const {DownloadManager} = require('./downloader.cjs');
const ImportPipeline = require('../../../shared/import-pipeline.cjs');

// O07：官方 ComfyUI 模板库（github.com/Comfy-Org/workflow_templates）。索引 templates/index.json：
// [{moduleName, category, title, type, templates: [{name, title, description, mediaSubtype, tags, models, minComfyUIVersion, openSource, username, tutorialUrl}]}]；
// 工作流 templates/<name>.json，缩略图 templates/<name>-1.<mediaSubtype>。其他源须提供同格式索引（https）。
const OFFICIAL_BASE = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/';
const BUILTIN_SOURCES = [{id: 'comfy-official', name: 'ComfyUI 官方模板库', homepage: 'https://github.com/Comfy-Org/workflow_templates', indexUrl: `${OFFICIAL_BASE}index.json`, base: OFFICIAL_BASE, author: 'ComfyUI'}];
const INDEX_TTL = 6 * 3600 * 1000;
const validSource = s => s && /^[\w-]{1,40}$/.test(s.id ?? '') && typeof s.name === 'string' && /^https:\/\//.test(s.indexUrl ?? '') && /^https:\/\/.+\/$/.test(s.base ?? '');
const NAME_RE = /^[\w.-]{1,120}$/;
function parseIndex(raw, src) {
  if (!Array.isArray(raw)) throw new AppError(CODES.INVALID_ARGUMENT, '模板源索引格式不正确。');
  const out = [];
  for (const cat of raw) for (const t of Array.isArray(cat?.templates) ? cat.templates : []) {
    if (!NAME_RE.test(String(t?.name ?? ''))) continue; // 名称决定下载路径：不合规的跳过，防止路径注入
    const sub = /^(webp|png|jpe?g)$/.test(t.mediaSubtype ?? '') ? t.mediaSubtype : 'webp';
    out.push({name: t.name, title: String(t.title ?? t.name).slice(0, 200), description: String(t.description ?? '').slice(0, 1000), category: String(cat.title ?? cat.category ?? '其他').slice(0, 80), group: String(cat.category ?? '').slice(0, 80), tags: (Array.isArray(t.tags) ? t.tags : []).map(String).slice(0, 12), models: (Array.isArray(t.models) ? t.models : []).map(String).slice(0, 12), minComfyUIVersion: t.minComfyUIVersion ?? null, openSource: t.openSource !== false, username: t.username ?? null, tutorialUrl: /^https:\/\//.test(t.tutorialUrl ?? '') ? t.tutorialUrl : null, date: t.date ?? null, workflowUrl: `${src.base}${t.name}.json`, thumbnailUrl: `${src.base}${t.name}-1.${sub}`});
  }
  return out;
}
const ROLE_FOLDER = {diffusion: 'diffusion_models', encoder: 'text_encoders', vae: 'vae', lora: 'loras', checkpoint: 'checkpoints', upscale: 'upscale_models', controlnet: 'controlnet'};

/** O04：规划一个文件下载。返回目标、空间、冲突说明；不写任何文件。 */
function planDownload({file, role, models, customDir = null, freeBytes}) {
  const name = path.basename(String(file.path ?? '').replace(/\\/g, '/'));
  const problem = validateSegment(name);
  if (problem) throw new AppError(CODES.INVALID_PATH, `文件名不可用：${problem}`);
  const folder = customDir ?? (ROLE_FOLDER[role] && models ? path.join(models, ROLE_FOLDER[role]) : null);
  if (!folder) throw new AppError(CODES.INVALID_ARGUMENT, role ? '未配置 ComfyUI 目录，请先在设置中设置，或手动选择下载目录。' : '无法判断文件用途，请选择用途或手动选择目录。');
  const destination = path.join(folder, name);
  const notes = [];
  let conflict = null;
  if (fs.existsSync(destination)) {
    const size = fs.statSync(destination).size;
    conflict = file.size && size === file.size ? 'same-size' : 'different';
    notes.push(conflict === 'same-size' ? '目标位置已有同名同大小文件，可能已下载过（不会覆盖）。' : '目标位置已有同名但大小不同的文件，不会覆盖；请改名或换目录。');
  }
  if (fs.existsSync(`${destination}.part`)) notes.push('存在旧下载临时文件，请从下载列表恢复原任务；新任务使用独立临时文件。');
  const need = file.size ?? null;
  const enough = need == null || freeBytes == null ? null : freeBytes - need > 1024 ** 3; // 预留 1 GB
  if (need == null) notes.push('来源没有提供文件大小，无法预先检查磁盘空间。');
  else if (file.sizeApprox) notes.push('来源提供的是近似大小。');
  if (enough === false) notes.push('磁盘剩余空间不足（需保留 1 GB 余量）。');
  if (!file.sha256) notes.push('来源没有提供 sha256，下载后只能校验大小。');
  return {destination, folder, name, sizeBytes: need, freeBytes, enoughSpace: enough, conflict, canDownload: !conflict && enough !== false, notes};
}

function createOnlineService({db, configRepo, layout, credentials, fetchImpl, events, logger, templateRepo, dialog, getWindow}) {
  const providers = createProviders({fetchImpl, credentials});
  const downloads = new DownloadManager({db, resolve: providers.resolve, events, logger, fetchImpl, concurrency: configRepo.config.downloads?.concurrency ?? 2, maxRetries: configRepo.config.downloads?.retries ?? 3});
  const provider = id => { const p = providers.byId[id]; if (!p) throw new AppError(CODES.INVALID_ARGUMENT, '未知来源。'); return p; };
  const free = dir => { for (let d = dir; d; d = path.dirname(d) === d ? null : path.dirname(d)) { try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { /* 向上找已存在的目录 */ } } return null; };
  const methods = {
    'downloads.search': (providerId, query, opts = {}) => provider(providerId).search(String(query ?? '').slice(0, 200), opts),
    'downloads.detail': (providerId, id, opts = {}) => provider(providerId).detail(id, opts),
    'downloads.version': versionId => providers.byId.civitai.version(versionId),
    'downloads.parseLink': async link => { const r = providers.parseLink(String(link)); if (!r) throw new AppError(CODES.INVALID_ARGUMENT, '无法识别的链接：目前支持 Hugging Face 与 Civitai 的模型链接。'); return r; },
    /** O04：ref = {provider, repo, revision, path} | {provider:'civitai', versionId, fileId}；file 来自 detail。 */
    'downloads.plan': async ({file, role, customDir}) => {
      const models = configRepo.derived(layout).models || null;
      const dir = customDir ?? (role && models ? path.join(models, ROLE_FOLDER[role] ?? '') : null);
      return planDownload({file, role, models, customDir, freeBytes: dir ? free(dir) : null});
    },
    'downloads.pickDir': async () => { const r = await dialog.showOpenDialog(getWindow(), {title: '选择下载目录', properties: ['openDirectory', 'createDirectory']}); return r.canceled ? {cancelled: true} : {dir: r.filePaths[0]}; },
    'downloads.add': async ({ref, file, role, customDir}) => {
      const models = configRepo.derived(layout).models || null;
      const dir = customDir ?? (role && models ? path.join(models, ROLE_FOLDER[role] ?? '') : null);
      const plan = planDownload({file, role, models, customDir, freeBytes: dir ? free(dir) : null});
      if (!plan.canDownload) throw new AppError(CODES.CONFLICT, plan.notes.join(' '), {details: plan});
      const urlRef = ref.provider === 'huggingface' ? {provider: 'huggingface', repo: ref.repo, revision: ref.revision, path: file.path} : ref.provider === 'civitai' ? {provider: 'civitai', versionId: ref.versionId, fileId: file.id ?? null} : {provider: 'url', url: ref.url};
      return downloads.add({source: ref.provider, fileId: file.path, urlRef, destination: plan.destination, expectedHash: file.sha256 ?? null, totalBytes: file.sizeApprox ? null : file.size ?? null});
    },
    'downloads.list': async () => downloads.list(),
    'downloads.pause': async id => downloads.pause(id),
    'downloads.resume': async id => downloads.resume(id),
    'downloads.cancel': async id => downloads.cancel(id),
  };
  /** O07：从明确的链接导入在线模板（只下载 JSON，不安装、不执行），保留作者/许可证/revision。 */
  methods['templates.importOnline'] = async link => {
    let u; try { u = new URL(String(link)); } catch { throw new AppError(CODES.INVALID_ARGUMENT, '链接无效。'); }
    if (u.protocol !== 'https:') throw new AppError(CODES.FORBIDDEN, '只接受 https 链接。');
    const hf = providers.byId.huggingface.parseLink(u.href);
    let fetchUrl = u.href, meta = {source: `url:${u.href}`, license: null, author: null, revision: null};
    if (hf?.path) {
      const d = await providers.byId.huggingface.detail(hf.repo, {revision: hf.revision});
      fetchUrl = (await providers.byId.huggingface.resolveDownload({...hf, revision: d.revision})).url;
      meta = {source: `huggingface:${hf.repo}@${d.revision}/${hf.path}`, license: d.license, author: d.author, revision: d.revision};
    } else if (/^github\.com$/.test(u.hostname) && u.pathname.includes('/blob/')) {
      fetchUrl = `https://raw.githubusercontent.com${u.pathname.replace('/blob/', '/')}`;
      const [owner, , , rev] = u.pathname.split('/').filter(Boolean);
      meta = {source: `github:${u.pathname}`, license: null, author: owner, revision: rev};
    }
    return importFromUrl(fetchUrl, meta, {name: decodeURIComponent(path.basename(u.pathname)), headers: hf ? providers.byId.huggingface.authHeaders() : {}});
  };
  async function importFromUrl(fetchUrl, meta, {name, headers = {}, folder = '在线导入', tags = ['在线']} = {}) {
    const res = await fetchImpl(fetchUrl, {signal: AbortSignal.timeout(30000), headers});
    if (!res.ok) throw new AppError(CODES.SERVICE_UNAVAILABLE, `下载模板失败：HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    if (len > ImportPipeline.MAX_BYTES) throw new AppError(CODES.INVALID_ARGUMENT, '模板文件过大。');
    const text = await res.text();
    let info; try { info = ImportPipeline.analyze(text, {name}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
    if (info.format !== 'ui') throw new AppError(CODES.INVALID_ARGUMENT, '这是 API 格式工作流，没有界面信息；请下载后在创作页导入。');
    const cache = path.join(layout.root, 'downloads', 'online-templates'); fs.mkdirSync(cache, {recursive: true});
    fs.writeFileSync(path.join(cache, `${Date.now()}-${info.name.replace(/[^\w.-]+/g, '_')}.json`), text);
    const t = templateRepo.create({name: meta.title ?? info.name, graph: info.graph, folder, tags, source: meta.source, license: meta.license, author: meta.author, note: `在线导入${meta.revision ? ` @${String(meta.revision).slice(0, 12)}` : ''}`});
    return {template: t, nodeTypes: info.nodeTypes, notes: ['未安装任何插件或模型；请用“诊断”检查缺失项。', ...info.notes]};
  }

  /* ---------- O07/S10：在线模板浏览（源索引 → 分页/搜索/缓存 → 详情 → 同一导入与诊断入口） ---------- */
  const sources = () => [...BUILTIN_SOURCES, ...(configRepo.config.onlineTemplates?.sources ?? []).filter(validSource)];
  const sourceOf = id => { const s = sources().find(x => x.id === id); if (!s) throw new AppError(CODES.INVALID_ARGUMENT, '未知模板源。'); return s; };
  const cacheDir = () => { const d = path.join(layout.root, 'downloads', 'online-templates'); fs.mkdirSync(d, {recursive: true}); return d; };
  const indexMem = new Map();
  async function loadIndex(src, {refresh = false} = {}) {
    const file = path.join(cacheDir(), `index-${src.id}.json`);
    const mem = indexMem.get(src.id);
    if (!refresh && mem && Date.now() - mem.at < INDEX_TTL) return mem;
    if (!refresh && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < INDEX_TTL) { try { const v = {at: fs.statSync(file).mtimeMs, items: parseIndex(JSON.parse(fs.readFileSync(file, 'utf8')), src), cached: true}; indexMem.set(src.id, v); return v; } catch { /* 缓存损坏则重新下载 */ } }
    let raw;
    try {
      const res = await fetchImpl(src.indexUrl, {signal: AbortSignal.timeout(30000)});
      if (!res.ok) throw new AppError(CODES.SERVICE_UNAVAILABLE, `读取模板源失败：HTTP ${res.status}`);
      const text = await res.text(); if (text.length > 20 << 20) throw new AppError(CODES.INVALID_ARGUMENT, '模板索引过大。');
      raw = JSON.parse(text); fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      if (fs.existsSync(file)) { const v = {at: fs.statSync(file).mtimeMs, items: parseIndex(JSON.parse(fs.readFileSync(file, 'utf8')), src), cached: true, stale: true, error: e.message}; indexMem.set(src.id, v); return v; }
      throw e instanceof AppError ? e : new AppError(CODES.NETWORK, `读取模板源失败：${e.message}`);
    }
    const v = {at: Date.now(), items: parseIndex(raw, src), cached: false}; indexMem.set(src.id, v); return v;
  }
  methods['templates.onlineSources'] = async () => sources().map(({id, name, homepage}) => ({id, name, homepage}));
  methods['templates.browseOnline'] = async (sourceId, {query = '', category = null, offset = 0, limit = 24, refresh = false} = {}) => {
    const src = sourceOf(sourceId); const idx = await loadIndex(src, {refresh});
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const hit = it => terms.every(t => [it.title, it.name, it.description, ...(it.tags ?? []), ...(it.models ?? [])].join(' ').toLowerCase().includes(t));
    const list = idx.items.filter(it => (!category || it.category === category) && hit(it));
    limit = Math.max(1, Math.min(60, Number(limit) || 24)); offset = Math.max(0, Number(offset) || 0);
    return {source: {id: src.id, name: src.name}, total: list.length, offset, limit, items: list.slice(offset, offset + limit), nextOffset: offset + limit < list.length ? offset + limit : null, categories: [...new Set(idx.items.map(i => i.category))], cachedAt: new Date(idx.at).toISOString(), stale: !!idx.stale, error: idx.error ?? null};
  };
  methods['templates.onlineThumbnail'] = async (sourceId, name) => {
    const src = sourceOf(sourceId); const it = (await loadIndex(src)).items.find(i => i.name === name);
    if (!it?.thumbnailUrl) return {dataUrl: null};
    const ext = it.thumbnailUrl.split('.').pop().toLowerCase(); const mime = {webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg'}[ext]; if (!mime) return {dataUrl: null};
    const file = path.join(cacheDir(), 'thumbs', `${src.id}-${name}.${ext}`);
    if (!fs.existsSync(file)) {
      const res = await fetchImpl(it.thumbnailUrl, {signal: AbortSignal.timeout(20000)}); if (!res.ok) return {dataUrl: null};
      const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 3 << 20) return {dataUrl: null};
      fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(`${file}.tmp`, buf); fs.renameSync(`${file}.tmp`, file);
    }
    return {dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`};
  };
  methods['templates.importFromSource'] = async (sourceId, name) => {
    const src = sourceOf(sourceId); const it = (await loadIndex(src)).items.find(i => i.name === name);
    if (!it) throw new AppError(CODES.NOT_FOUND, '模板源中没有该模板。');
    const r = await importFromUrl(it.workflowUrl, {source: `${src.id}:${it.name}`, license: src.license ?? null, author: it.username ?? src.author ?? null, revision: src.revision ?? null, title: it.title}, {name: `${it.name}.json`, folder: `在线/${src.name}`, tags: ['在线', ...(it.tags ?? []).slice(0, 5)]});
    return {...r, notes: [...r.notes, ...(it.minComfyUIVersion ? [`该模板要求 ComfyUI ≥ ${it.minComfyUIVersion}。`] : []), ...(it.openSource === false ? ['该模板使用付费/闭源 API 节点。'] : [])]};
  };
  return {providers, downloads, methods, start: () => { downloads.recoverOnStartup(); }};
}
module.exports = {createOnlineService, planDownload, ROLE_FOLDER, parseIndex, BUILTIN_SOURCES};
