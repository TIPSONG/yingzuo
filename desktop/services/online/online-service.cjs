'use strict';
// O04 下载规划、O01–O06 接口组装（downloads.*）、O07 在线模板导入（templates.importOnline）。
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../../core/errors.cjs');
const {validateSegment} = require('../../core/paths.cjs');
const {createProviders} = require('./providers.cjs');
const {DownloadManager} = require('./downloader.cjs');
const ImportPipeline = require('../../../shared/import-pipeline.cjs');

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
  if (fs.existsSync(`${destination}.part`)) notes.push('存在未完成的临时文件，将尝试续传。');
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
    const res = await fetchImpl(fetchUrl, {signal: AbortSignal.timeout(30000), headers: hf ? providers.byId.huggingface.authHeaders() : {}});
    if (!res.ok) throw new AppError(CODES.SERVICE_UNAVAILABLE, `下载模板失败：HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    if (len > ImportPipeline.MAX_BYTES) throw new AppError(CODES.INVALID_ARGUMENT, '模板文件过大。');
    const text = await res.text();
    let info; try { info = ImportPipeline.analyze(text, {name: decodeURIComponent(path.basename(u.pathname))}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
    if (info.format !== 'ui') throw new AppError(CODES.INVALID_ARGUMENT, '这是 API 格式工作流，没有界面信息；请下载后在创作页导入。');
    const cache = path.join(layout.root, 'downloads', 'online-templates'); fs.mkdirSync(cache, {recursive: true});
    fs.writeFileSync(path.join(cache, `${Date.now()}-${info.name.replace(/[^\w.-]+/g, '_')}.json`), text);
    const t = templateRepo.create({name: info.name, graph: info.graph, folder: '在线导入', tags: ['在线'], source: meta.source, license: meta.license, author: meta.author, note: `在线导入${meta.revision ? ` @${String(meta.revision).slice(0, 12)}` : ''}`});
    return {template: t, nodeTypes: info.nodeTypes, notes: ['未安装任何插件或模型；请用“诊断”检查缺失项。', ...info.notes]};
  };
  return {providers, downloads, methods, start: () => { downloads.recoverOnStartup(); }};
}
module.exports = {createOnlineService, planDownload, ROLE_FOLDER};
