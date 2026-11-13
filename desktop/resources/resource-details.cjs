'use strict';
// R02：资源详情。用途来自 folder（R01），量化／架构来自文件头元数据与文件名，触发词与建议权重来自
// safetensors __metadata__ 及常见旁路文件（.civitai.info / .metadata.json / .json）；允许手动补充（单独 JSON 存储，覆盖推断值）。
const fs = require('node:fs');
const path = require('node:path');
const {writeJsonAtomic} = require('../core/fs-atomic.cjs');

const USAGE = {
  checkpoints: '主模型（完整检查点）', diffusion_models: '主模型（扩散模型／UNet）', loras: 'LoRA', vae: 'VAE',
  text_encoders: '文本编码器', clip_vision: '视觉编码器', controlnet: 'ControlNet', upscale_models: '放大模型',
  embeddings: '文本嵌入', LLM: '语言／视觉语言模型', model_patches: '模型补丁', style_models: '风格模型',
};
const QUANT_RE = /(?:^|[-_.\s])(Q[2-8]_K(?:_[SML])?|Q[4-8]_[01]|IQ[1-4]_[A-Z]+|fp8(?:_e4m3fn|_e5m2)?(?:_scaled)?|fp16|bf16|fp32|nf4|int8|int4)(?=$|[-_.\s])/i;

function quantFromName(name) { const m = QUANT_RE.exec(path.basename(name, path.extname(name))); return m ? m[1] : null; }

/** 读 safetensors 头（8 字节小端长度 + JSON），只读头部，不加载权重。 */
function readSafetensorsHeader(file, maxHeader = 32 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const lenBuf = Buffer.alloc(8); if (fs.readSync(fd, lenBuf, 0, 8, 0) !== 8) return null;
    const len = Number(lenBuf.readBigUInt64LE(0)); if (!len || len > maxHeader) return null;
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, 8);
    const json = JSON.parse(buf.toString('utf8'));
    const dtypes = {};
    for (const [k, v] of Object.entries(json)) if (k !== '__metadata__' && v?.dtype) dtypes[v.dtype] = (dtypes[v.dtype] ?? 0) + 1;
    return {metadata: json.__metadata__ ?? {}, dtypes, tensorCount: Object.keys(json).length - (json.__metadata__ ? 1 : 0)};
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** GGUF：读 magic 与版本，只判断格式；量化取文件名。 */
function readGgufInfo(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(8); fs.readSync(fd, b, 0, 8, 0); return b.toString('ascii', 0, 4) === 'GGUF' ? {gguf: true, version: b.readUInt32LE(4)} : null; } catch { return null; } finally { fs.closeSync(fd); }
}

function topTags(tagFrequency, n = 8) {
  let freq; try { freq = typeof tagFrequency === 'string' ? JSON.parse(tagFrequency) : tagFrequency; } catch { return []; }
  const counts = {};
  for (const set of Object.values(freq ?? {})) for (const [t, c] of Object.entries(set)) counts[t.trim()] = (counts[t.trim()] ?? 0) + c;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}

function findSidecars(file) {
  const dir = path.dirname(file), stem = path.basename(file, path.extname(file));
  const pick = names => names.map(n => path.join(dir, n)).find(p => fs.existsSync(p)) ?? null;
  return {
    info: pick([`${stem}.civitai.info`, `${stem}.metadata.json`, `${stem}.json`]),
    preview: pick([`${stem}.preview.png`, `${stem}.png`, `${stem}.preview.jpg`, `${stem}.jpg`, `${stem}.webp`, `${stem}.preview.jpeg`]),
    readme: pick([`${stem}.txt`, `${stem}.md`]),
  };
}

function architectureFrom(meta) {
  return meta['modelspec.architecture'] ?? meta.ss_base_model_version ?? meta.ss_sd_model_name ?? null;
}

/** 推断详情；item 来自 R01 扫描。overrides 为手动补充。 */
function describeResource(item, overrides = {}) {
  const d = {id: item.id, folder: item.folder, name: item.name, path: item.path, size: item.size, format: item.format,
    usage: USAGE[item.folder] ?? item.folder, quantization: quantFromName(item.name), architecture: null, source: null,
    description: null, preview: null, triggerWords: [], recommendedWeight: null, inferred: {}};
  try {
    if (item.format === 'safetensors') {
      const h = readSafetensorsHeader(item.path);
      if (h) {
        const meta = h.metadata;
        d.architecture = architectureFrom(meta);
        d.description = meta['modelspec.description'] ?? null;
        if (meta['modelspec.title']) d.title = meta['modelspec.title'];
        if (meta.ss_tag_frequency) d.triggerWords = topTags(meta.ss_tag_frequency);
        if (meta['modelspec.trigger_phrase']) d.triggerWords = [meta['modelspec.trigger_phrase'], ...d.triggerWords];
        if (!d.quantization) { const main = Object.entries(h.dtypes).sort((a, b) => b[1] - a[1])[0]; if (main) d.quantization = main[0]; d.inferred.quantization = 'dtype'; }
      }
    } else if (item.format === 'gguf') {
      const g = readGgufInfo(item.path); if (g) d.inferred.gguf = g.version;
    }
  } catch { /* 文件不可读：只保留基本信息 */ }
  const sc = findSidecars(item.path);
  d.preview = sc.preview;
  if (sc.info) {
    try {
      const info = JSON.parse(fs.readFileSync(sc.info, 'utf8'));
      if (Array.isArray(info.trainedWords) && info.trainedWords.length) d.triggerWords = info.trainedWords;
      d.architecture ??= info.baseModel ?? null;
      d.description ??= info.description ?? info.model?.description ?? null;
      if (info.modelId || info.model?.name) d.source = {site: 'civitai', modelId: info.modelId ?? null, name: info.model?.name ?? null};
      const w = info.preferredWeight ?? info.recommendedWeight ?? info['preferred weight'];
      if (w !== undefined) d.recommendedWeight = Number(w);
    } catch { /* 损坏的旁路文件忽略 */ }
  }
  if (!d.description && sc.readme) d.description = fs.readFileSync(sc.readme, 'utf8').slice(0, 2000);
  return {...d, ...overrides, manual: Object.keys(overrides)};
}

/** 手动补充存储：按 id 存覆盖字段。 */
class ResourceNotes {
  constructor(file) { this.file = file; this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {version: 1, notes: {}}; }
  get(id) { return this.data.notes[id] ?? {}; }
  set(id, patch) {
    const allowed = ['usage', 'quantization', 'architecture', 'source', 'description', 'preview', 'triggerWords', 'recommendedWeight', 'title'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    this.data.notes[id] = {...this.get(id), ...clean};
    for (const [k, v] of Object.entries(this.data.notes[id])) if (v === null) delete this.data.notes[id][k];
    writeJsonAtomic(this.file, this.data);
    return this.data.notes[id];
  }
}

module.exports = {describeResource, readSafetensorsHeader, readGgufInfo, quantFromName, topTags, ResourceNotes, USAGE};
