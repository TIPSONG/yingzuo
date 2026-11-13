'use strict';
// O01–O03：在线来源。统一接口 search/detail/listFiles/resolveDownload/parseLink；Provider 相互独立。
// 分页缓存（内存 TTL）、取消（AbortSignal）、429/5xx 退避。联网失败只影响在线页面，不阻塞本地创作。
// 凭据只在请求时从 CredentialStore 取出放入请求头，不写入任何任务记录。
const {AppError, CODES} = require('../../core/errors.cjs');

const ROLE_BY_NAME = [[/lora/i, 'lora'], [/vae/i, 'vae'], [/(text[_-]?encoder|clip|t5|umt5|qwen.*vl)/i, 'encoder'], [/(unet|diffusion|dit|flux|qwen-image|sdxl|sd3|wan)/i, 'diffusion']];
const guessRole = name => (ROLE_BY_NAME.find(([re]) => re.test(name)) ?? [null, null])[1];
const validRepo = r => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r) && !r.split('/').some(x => /^\.+$/.test(x));
const FILE_EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i;

class BaseProvider {
  constructor({fetchImpl = fetch, token = () => null, ttlMs = 5 * 60 * 1000, sleep = ms => new Promise(r => setTimeout(r, ms)), maxRetries = 3} = {}) { Object.assign(this, {fetchImpl, token, ttlMs, sleep, maxRetries}); this.cache = new Map(); }
  authHeaders() { const t = this.token(); return t ? {authorization: `Bearer ${t}`} : {}; }
  async getJson(url, {signal, cache = true, withLink = false} = {}) {
    const key = String(url);
    const hit = cache && this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    for (let attempt = 0; ; attempt++) {
      let res;
      try { res = await this.fetchImpl(url, {headers: {accept: 'application/json', ...this.authHeaders()}, signal: signal ?? AbortSignal.timeout(20000)}); }
      catch (e) { if (signal?.aborted) throw new AppError(CODES.CANCELLED, '已取消。'); if (attempt >= this.maxRetries) throw new AppError(CODES.SERVICE_UNAVAILABLE, `${this.label} 无法连接：${e.message}`, {retryable: true}); await this.sleep(500 * 2 ** attempt); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) { const ra = Number(res.headers.get('retry-after')); await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * 2 ** attempt); continue; }
      if (res.status === 401 || res.status === 403) throw new AppError(CODES.FORBIDDEN, `${this.label} 拒绝访问（HTTP ${res.status}）：需要有效凭据，或需先在网站上同意该模型的许可。`);
      if (res.status === 404) throw new AppError(CODES.NOT_FOUND, `${this.label} 上找不到该资源。`);
      if (!res.ok) throw new AppError(CODES.SERVICE_UNAVAILABLE, `${this.label} 请求失败：HTTP ${res.status}`, {retryable: res.status >= 500});
      let value = await res.json();
      if (withLink) value = {body: value, next: /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null};
      if (cache) this.cache.set(key, {at: Date.now(), value});
      return value;
    }
  }
}

class HuggingFaceProvider extends BaseProvider {
  constructor(o = {}) { super(o); this.id = 'huggingface'; this.label = 'Hugging Face'; this.base = o.base ?? 'https://huggingface.co'; }
  parseLink(link) {
    let u; try { u = new URL(link); } catch { return null; }
    if (!/(^|\.)huggingface\.co$|^hf\.co$/.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'datasets' || parts[0] === 'spaces') return null;
    if (parts.length < 2) return null;
    const repo = `${parts[0]}/${parts[1]}`;
    if (['resolve', 'blob'].includes(parts[2]) && parts.length >= 5) return {provider: this.id, repo, revision: parts[3], path: parts.slice(4).join('/')};
    if (parts[2] === 'tree' && parts[3]) return {provider: this.id, repo, revision: parts[3], path: null};
    return {provider: this.id, repo, revision: 'main', path: null};
  }
  async search(query, {cursor = null, limit = 20, signal} = {}) {
    // 分页：HF 在 Link 头返回下一页完整地址（含 cursor），原样保存为 nextCursor。
    let u;
    if (cursor) { u = new URL(cursor); if (u.origin !== new URL(this.base).origin) throw new AppError(CODES.INVALID_ARGUMENT, '分页地址无效。'); }
    else { u = new URL('/api/models', this.base); u.searchParams.set('search', query); u.searchParams.set('limit', String(limit)); }
    const {body: list, next} = await this.getJson(u, {signal, withLink: true});
    return {items: list.map(m => ({provider: this.id, id: m.id ?? m.modelId, name: m.id ?? m.modelId, downloads: m.downloads ?? null, likes: m.likes ?? null, tags: m.tags ?? [], updatedAt: m.lastModified ?? null, gated: m.gated ?? false})), nextCursor: next};
  }
  async detail(repo, {revision = 'main', signal} = {}) {
    if (!validRepo(repo)) throw new AppError(CODES.INVALID_ARGUMENT, '仓库名无效。');
    const m = await this.getJson(new URL(`/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`, this.base), {signal});
    return {provider: this.id, id: m.id, revision: m.sha ?? revision, requestedRevision: revision, license: m.cardData?.license ?? (m.tags ?? []).find(t => t.startsWith('license:'))?.slice(8) ?? null, gated: m.gated ?? false, author: m.author ?? repo.split('/')[0], tags: m.tags ?? [], pipeline: m.pipeline_tag ?? null,
      files: (m.siblings ?? []).map(s => ({path: s.rfilename, size: s.size ?? s.lfs?.size ?? null, sha256: s.lfs?.sha256 ?? null, isWeight: FILE_EXT.test(s.rfilename), role: FILE_EXT.test(s.rfilename) ? guessRole(s.rfilename) : null}))};
  }
  async listFiles(repo, o) { return (await this.detail(repo, o)).files; }
  /** 下载地址按 repo+固定 revision+具体文件 构造；不把整个 repo 当成一个权重。 */
  async resolveDownload(ref) {
    if (!ref?.repo || !ref.path || !ref.revision) throw new AppError(CODES.INVALID_ARGUMENT, '需要指定仓库、版本和具体文件。');
    if (!validRepo(ref.repo) || ref.path.split('/').some(x => x === '..' || x === '.')) throw new AppError(CODES.INVALID_ARGUMENT, '仓库或文件路径无效。');
    const u = new URL(`/${ref.repo}/resolve/${encodeURIComponent(ref.revision)}/${ref.path.split('/').map(encodeURIComponent).join('/')}`, this.base);
    return {url: u.href, headers: this.authHeaders()};
  }
}

class CivitaiProvider extends BaseProvider {
  constructor(o = {}) { super(o); this.id = 'civitai'; this.label = 'Civitai'; this.base = o.base ?? 'https://civitai.com'; }
  parseLink(link) {
    let u; try { u = new URL(link); } catch { return null; }
    if (!/(^|\.)civitai\.(com|green)$/.test(u.hostname)) return null;
    const m = /\/models\/(\d+)/.exec(u.pathname);
    const v = u.searchParams.get('modelVersionId') ?? /\/api\/download\/models\/(\d+)/.exec(u.pathname)?.[1];
    if (!m && !v) return null;
    return {provider: this.id, modelId: m ? Number(m[1]) : null, versionId: v ? Number(v) : null};
  }
  async search(query, {cursor = null, limit = 20, types, signal} = {}) {
    const u = new URL('/api/v1/models', this.base); u.searchParams.set('query', query); u.searchParams.set('limit', String(limit)); if (cursor) u.searchParams.set('cursor', cursor); if (types) u.searchParams.set('types', types);
    const r = await this.getJson(u, {signal});
    return {items: (r.items ?? []).map(m => ({provider: this.id, id: m.id, name: m.name, type: m.type, nsfw: !!m.nsfw, creator: m.creator?.username ?? null, versions: (m.modelVersions ?? []).map(v => ({id: v.id, name: v.name, baseModel: v.baseModel})), preview: m.modelVersions?.[0]?.images?.[0]?.url ?? null})), nextCursor: r.metadata?.nextCursor ?? null};
  }
  async detail(modelId, {signal} = {}) {
    const m = await this.getJson(new URL(`/api/v1/models/${Number(modelId)}`, this.base), {signal});
    return {provider: this.id, id: m.id, name: m.name, type: m.type, license: {allowCommercialUse: m.allowCommercialUse ?? null, allowDerivatives: m.allowDerivatives ?? null}, author: m.creator?.username ?? null, versions: (m.modelVersions ?? []).map(v => this._version(v, m))};
  }
  _version(v, m = {}) {
    return {id: v.id, name: v.name, baseModel: v.baseModel ?? null, trainedWords: v.trainedWords ?? [], type: m.type ?? v.model?.type ?? null, preview: v.images?.[0]?.url ?? null,
      files: (v.files ?? []).map(f => ({id: f.id, path: f.name, size: f.sizeKB ? Math.round(f.sizeKB * 1024) : null, sizeApprox: true, sha256: f.hashes?.SHA256?.toLowerCase() ?? null, format: f.metadata?.format ?? null, fp: f.metadata?.fp ?? null, primary: !!f.primary, versionId: v.id, role: (m.type ?? v.model?.type) === 'LORA' ? 'lora' : (m.type ?? v.model?.type) === 'Checkpoint' ? 'checkpoint' : (m.type ?? v.model?.type) === 'VAE' ? 'vae' : guessRole(f.name)}))};
  }
  async version(versionId, {signal} = {}) { return this._version(await this.getJson(new URL(`/api/v1/model-versions/${Number(versionId)}`, this.base), {signal})); }
  async listFiles(modelId, o) { return (await this.detail(modelId, o)).versions.flatMap(v => v.files); }
  async resolveDownload(ref) {
    if (!ref?.versionId) throw new AppError(CODES.INVALID_ARGUMENT, '需要指定模型版本。');
    if (ref.fileId != null) {
      // Resolve the exact chosen file afresh. The version-level endpoint otherwise selects
      // the primary file, silently ignoring fp/format choices made in the file picker.
      const version = await this.getJson(new URL(`/api/v1/model-versions/${Number(ref.versionId)}`, this.base), {cache: false});
      const file = (version.files ?? []).find(f => String(f.id) === String(ref.fileId));
      if (!file?.downloadUrl) throw new AppError(CODES.NOT_FOUND, '所选版本中已找不到这个文件或其下载地址，请刷新文件列表后重新选择。');
      let selected;
      try { selected = new URL(file.downloadUrl); } catch { throw new AppError(CODES.INVALID_ARGUMENT, '来源返回了无效的文件下载地址。'); }
      if (selected.protocol !== 'https:' || selected.username || selected.password) throw new AppError(CODES.FORBIDDEN, '来源文件下载地址必须使用 https 且不能包含账号信息。');
      return {url: selected.href, headers: selected.origin === new URL(this.base).origin ? this.authHeaders() : {}};
    }
    const u = new URL(`/api/download/models/${Number(ref.versionId)}`, this.base);
    if (ref.fileType) u.searchParams.set('type', ref.fileType);
    if (ref.format) u.searchParams.set('format', ref.format);
    return {url: u.href, headers: this.authHeaders()};
  }
}

function createProviders({fetchImpl, credentials}) {
  const tok = name => () => { try { return credentials?.get(name) ?? null; } catch { return null; } };
  const list = [new HuggingFaceProvider({fetchImpl, token: tok('huggingface')}), new CivitaiProvider({fetchImpl, token: tok('civitai')})];
  const byId = Object.fromEntries(list.map(p => [p.id, p]));
  return {list, byId, parseLink: link => { for (const p of list) { const r = p.parseLink(link); if (r) return r; } return null; },
    resolve: async ref => { if (ref.provider === 'url') { const u = new URL(ref.url); if (u.protocol !== 'https:') throw new AppError(CODES.FORBIDDEN, '只接受 https 下载链接。'); return {url: u.href, headers: {}}; } const p = byId[ref.provider]; if (!p) throw new AppError(CODES.INVALID_ARGUMENT, `未知来源 ${ref.provider}`); return p.resolveDownload(ref); }};
}
module.exports = {HuggingFaceProvider, CivitaiProvider, createProviders, guessRole};
