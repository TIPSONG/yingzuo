'use strict';
// R01：模型目录扫描。目录→用途的映射来自 Comfy 实际 folder_paths（/api/models + /api/models/<folder>）
// 或 Comfy 默认布局 + extra_model_paths.yaml；不按扩展名把 safetensors/GGUF 任意归类。
// 符号链接按 realpath 去重；hash 在后台队列中计算，可取消。
const fs = require('node:fs');
const path = require('node:path');
const {sha256File} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');

// 与 ComfyUI folder_paths.py 中的默认目录一致（folder 名 → models 下子目录）。
const DEFAULT_FOLDERS = {
  checkpoints: ['checkpoints'], loras: ['loras'], vae: ['vae'], text_encoders: ['text_encoders', 'clip'],
  diffusion_models: ['unet', 'diffusion_models'], clip_vision: ['clip_vision'], style_models: ['style_models'],
  embeddings: ['embeddings'], diffusers: ['diffusers'], vae_approx: ['vae_approx'], controlnet: ['controlnet', 't2i_adapter'],
  gligen: ['gligen'], upscale_models: ['upscale_models'], hypernetworks: ['hypernetworks'], photomaker: ['photomaker'], classifiers: ['classifiers'],
  model_patches: ['model_patches'], audio_encoders: ['audio_encoders'], LLM: ['LLM'],
};
const MODEL_EXT = new Set(['.ckpt', '.pt', '.pt2', '.bin', '.pth', '.safetensors', '.pkl', '.sft', '.gguf', '.onnx']);

/** 解析 extra_model_paths.yaml 常见两级结构（无需完整 YAML 库）。 */
function parseExtraModelPaths(text, yamlDir) {
  const out = {};
  let section = null, base = null, key = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;
    const m = /^\s*([\w.-]+):\s*(.*)$/.exec(line);
    if (indent === 0 && m) { section = m[1]; base = null; key = null; continue; }
    if (!section) continue;
    if (m && indent > 0) {
      const [, k, v] = m;
      const val = v.replace(/^["'|]|["']$/g, '').trim();
      if (k === 'base_path') { base = path.resolve(yamlDir, val); continue; }
      if (k === 'is_default') continue;
      key = k;
      if (val) for (const p of val.split(/\s*,\s*/)) add(k, p);
    } else if (key) add(key, line.trim());
  }
  function add(k, p) { if (!p) return; (out[k] ??= []).push(path.resolve(base ?? yamlDir, p)); }
  return out;
}

/** 合并 Comfy 默认布局与 extra_model_paths.yaml，得到 folder → 绝对目录列表。 */
function buildFolderMap({comfyRoot, extraModelPaths}) {
  const map = {};
  if (comfyRoot) for (const [k, dirs] of Object.entries(DEFAULT_FOLDERS)) map[k] = dirs.map(d => path.join(comfyRoot, 'models', d));
  const yaml = extraModelPaths ?? (comfyRoot && path.join(comfyRoot, 'extra_model_paths.yaml'));
  if (yaml && fs.existsSync(yaml)) {
    for (const [k, dirs] of Object.entries(parseExtraModelPaths(fs.readFileSync(yaml, 'utf8'), path.dirname(yaml)))) {
      const folder = k === 'clip' ? 'text_encoders' : k === 'unet' ? 'diffusion_models' : k;
      map[folder] = [...(map[folder] ?? []), ...dirs];
    }
  }
  return map;
}

/** 从 Comfy API 读取实际 folder 列表；Comfy 只返回文件名，目录仍以 buildFolderMap 为准，但 folder 集合以 API 为准。 */
async function folderNamesFromComfy(http) {
  const list = await http.getJson('/api/models');
  if (!Array.isArray(list)) throw new AppError(CODES.HTTP, '/api/models 返回格式异常');
  return list;
}

function walkFiles(dir, visit, rel = '', seenDirs = new Set()) {
  let real; try { real = fs.realpathSync(dir); } catch { return; }
  if (seenDirs.has(real)) return; seenDirs.add(real);
  let entries; try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    let st; try { st = fs.statSync(p); } catch { continue; } // 断链
    if (st.isDirectory()) walkFiles(p, visit, r, seenDirs);
    else if (st.isFile()) visit(p, r, st, e.isSymbolicLink());
  }
}

/**
 * 扫描。返回 {items, duplicates, folders}；item 的 name 是 Comfy 中引用用的相对名（使用 '/' 分隔）。
 * @param {{folderMap:object, apiFolders?:string[], token?}} o
 */
function scanModels({folderMap, apiFolders, token}) {
  const folders = apiFolders ? Object.keys(folderMap).filter(f => apiFolders.includes(f)) : Object.keys(folderMap);
  const byReal = new Map(), items = [], duplicates = [];
  for (const folder of folders) {
    for (const dir of folderMap[folder]) {
      if (!fs.existsSync(dir)) continue;
      walkFiles(dir, (p, rel, st, isLink) => {
        if (token?.cancelled) throw new AppError(CODES.CANCELLED, '扫描已取消');
        if (!MODEL_EXT.has(path.extname(p).toLowerCase())) return;
        const real = fs.realpathSync(p);
        const key = `${folder}\0${real}`;
        const item = {id: `${folder}:${rel}`, folder, name: rel, path: p, realPath: real, symlink: isLink || real !== path.resolve(p), size: st.size, mtime: st.mtime.toISOString(), format: path.extname(p).slice(1).toLowerCase(), sha256: null};
        const prev = byReal.get(key);
        if (prev) {
          // 优先保留真实文件作为主条目，链接记为重复
          if (prev.symlink && !item.symlink) { items[items.indexOf(prev)] = item; byReal.set(key, item); duplicates.push({folder, name: prev.name, path: prev.path, sameAs: item.path}); }
          else duplicates.push({folder, name: rel, path: p, sameAs: prev.path});
          return;
        }
        byReal.set(key, item); items.push(item);
      });
    }
  }
  return {items, duplicates, folders};
}

/** 后台 hash 队列：一次一个，可取消；按 realPath+size+mtime 缓存。 */
class HashQueue {
  constructor({cache = new Map(), hashImpl = sha256File} = {}) { this.cache = cache; this.hashImpl = hashImpl; this.cancelled = false; this.running = null; }
  cancel() { this.cancelled = true; }
  async run(items, onProgress = () => {}) {
    this.cancelled = false;
    let done = 0;
    for (const it of items) {
      if (this.cancelled) return {done, cancelled: true};
      const key = `${it.realPath}|${it.size}|${it.mtime}`;
      if (!this.cache.has(key)) this.cache.set(key, await this.hashImpl(it.realPath));
      it.sha256 = this.cache.get(key); done++;
      onProgress({done, total: items.length, item: it});
      await new Promise(r => setImmediate(r));
    }
    return {done, cancelled: false};
  }
}

module.exports = {scanModels, buildFolderMap, parseExtraModelPaths, folderNamesFromComfy, HashQueue, DEFAULT_FOLDERS, MODEL_EXT};
