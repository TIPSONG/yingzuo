'use strict';
// A04/A07：图片容器级解析。读取 ComfyUI/A1111 生成信息；分享副本按容器过滤元数据，
// 不重编码像素（PNG chunk 过滤、JPEG 段过滤、WebP RIFF chunk 过滤）。无法可靠处理时抛出 UNSUPPORTED。
const zlib = require('node:zlib');
const {AppError, CODES} = require('./errors.cjs');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function detectFormat(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return 'isobmff';
  return 'unknown';
}
const SHARE_FORMATS = ['png', 'jpeg', 'webp'];
const shareSupport = format => SHARE_FORMATS.includes(format)
  ? {supported: true}
  : {supported: false, reason: `暂不能可靠清除 ${format} 格式的元数据，已禁用分享副本导出（可用原图导出）。`};
const bad = msg => new AppError(CODES.UNSUPPORTED, `文件结构无法可靠解析：${msg}，未生成分享副本。`);

// ---------- PNG ----------
function pngChunks(buf) {
  if (detectFormat(buf) !== 'png') throw bad('不是 PNG');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    if (off + 12 > buf.length) throw bad('PNG chunk 被截断');
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || off + 12 + len > buf.length) throw bad('PNG chunk 无效');
    chunks.push({type, start: off, end: off + 12 + len, data: buf.subarray(off + 8, off + 8 + len)});
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks.at(-1)?.type !== 'IEND') throw bad('PNG 缺少 IHDR/IEND');
  return chunks;
}
function pngText(buf) {
  const out = {};
  for (const c of pngChunks(buf)) {
    try {
      if (c.type === 'tEXt') { const i = c.data.indexOf(0); out[c.data.toString('latin1', 0, i)] = c.data.toString('latin1', i + 1); }
      else if (c.type === 'zTXt') { const i = c.data.indexOf(0); out[c.data.toString('latin1', 0, i)] = zlib.inflateSync(c.data.subarray(i + 2)).toString('latin1'); }
      else if (c.type === 'iTXt') {
        const i = c.data.indexOf(0), key = c.data.toString('latin1', 0, i), compressed = c.data[i + 1];
        let p = i + 3; p = c.data.indexOf(0, p) + 1; p = c.data.indexOf(0, p) + 1;
        const body = c.data.subarray(p);
        out[key] = (compressed ? zlib.inflateSync(body) : body).toString('utf8');
      }
    } catch { /* 单个损坏文本块忽略 */ }
  }
  return out;
}
// 保留：关键块 + 影响显示的辅助块（透明度、色彩、ICC、物理尺寸、APNG 动画）。其余（文本、eXIf、tIME、未知私有块）全部移除。
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT']);
function stripPng(buf) {
  const chunks = pngChunks(buf), removed = [];
  const kept = [PNG_SIG];
  for (const c of chunks) {
    if (PNG_KEEP.has(c.type)) kept.push(buf.subarray(c.start, c.end));
    else if (/^[A-Z]/.test(c.type)) throw bad(`未知关键块 ${c.type}`);
    else removed.push(c.type);
  }
  return {buffer: Buffer.concat(kept), removed};
}

// ---------- JPEG ----------
function jpegSegments(buf) {
  if (detectFormat(buf) !== 'jpeg') throw bad('不是 JPEG');
  const segs = [{marker: 0xd8, start: 0, end: 2}];
  let off = 2;
  for (;;) {
    if (off >= buf.length) throw bad('JPEG 在扫描数据前结束');
    if (buf[off] !== 0xff) throw bad('JPEG 段标记错位');
    let m = off + 1;
    while (buf[m] === 0xff) m++; // 填充字节
    const marker = buf[m];
    if (marker === 0xd9) { segs.push({marker, start: off, end: m + 1}); return {segs, tail: m + 1}; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { segs.push({marker, start: off, end: m + 1}); off = m + 1; continue; }
    if (m + 3 > buf.length) throw bad('JPEG 段被截断');
    const len = buf.readUInt16BE(m + 1);
    if (len < 2 || m + 1 + len > buf.length) throw bad('JPEG 段长度无效');
    segs.push({marker, start: off, end: m + 1 + len, data: buf.subarray(m + 3, m + 1 + len)});
    off = m + 1 + len;
    if (marker === 0xda) return {segs, tail: off}; // SOS 之后是熵编码数据，原样保留
  }
}
function jpegDropReason(s) {
  const id = s.data ? s.data.toString('latin1', 0, Math.min(s.data.length, 32)) : '';
  if (s.marker === 0xfe) return 'COM';
  if (s.marker === 0xe0) return /^JFIF\0/.test(id) ? null : 'APP0-' + (id.split('\0')[0] || 'other'); // JFXX 缩略图等移除
  if (s.marker === 0xe2) return id.startsWith('ICC_PROFILE\0') ? null : 'APP2-' + (id.split('\0')[0] || 'other');
  if (s.marker === 0xee) return id.startsWith('Adobe') ? null : 'APP14-other'; // Adobe 段决定颜色变换，必须保留
  if (s.marker >= 0xe1 && s.marker <= 0xef) return `APP${s.marker - 0xe0}` + (id.startsWith('Exif') ? '-Exif' : id.startsWith('http://ns.adobe.com') ? '-XMP' : id.startsWith('Photoshop') ? '-IPTC' : '');
  return null;
}
function stripJpeg(buf) {
  const {segs, tail} = jpegSegments(buf), parts = [], removed = [];
  for (const s of segs) { const r = jpegDropReason(s); if (r) removed.push(r); else parts.push(buf.subarray(s.start, s.end)); }
  parts.push(buf.subarray(tail));
  return {buffer: Buffer.concat(parts), removed};
}
function jpegComments(buf) {
  try { return jpegSegments(buf).segs.filter(s => s.marker === 0xfe || (s.marker === 0xe1 && s.data?.toString('latin1', 0, 4) === 'Exif')).map(s => s.data.toString('utf8').replace(/\0/g, ' ')); } catch { return []; }
}

// ---------- WebP ----------
function webpChunks(buf) {
  if (detectFormat(buf) !== 'webp') throw bad('不是 WebP');
  const size = buf.readUInt32LE(4);
  if (size + 8 > buf.length || size < 4) throw bad('RIFF 长度无效');
  const end = 8 + size, chunks = [];
  let off = 12;
  while (off < end) {
    if (off + 8 > end) throw bad('WebP chunk 被截断');
    const type = buf.toString('latin1', off, off + 4), len = buf.readUInt32LE(off + 4), padded = len + (len & 1);
    if (off + 8 + len > end) throw bad('WebP chunk 长度无效');
    chunks.push({type, start: off, end: Math.min(off + 8 + padded, end), data: buf.subarray(off + 8, off + 8 + len)});
    off += 8 + padded;
  }
  return chunks;
}
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
function stripWebp(buf) {
  const chunks = webpChunks(buf), parts = [], removed = [];
  if (!chunks.some(c => ['VP8 ', 'VP8L', 'ANMF'].includes(c.type))) throw bad('WebP 缺少图像数据');
  for (const c of chunks) {
    if (!WEBP_KEEP.has(c.type)) { removed.push(c.type.trim()); continue; }
    let piece = Buffer.from(buf.subarray(c.start, c.end));
    if (c.type === 'VP8X') piece[8] &= ~(0x08 | 0x04); // 清除 EXIF、XMP 标志位
    parts.push(piece);
  }
  const body = Buffer.concat(parts), header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return {buffer: Buffer.concat([header, body]), removed};
}
function webpMeta(buf) {
  try { return webpChunks(buf).filter(c => c.type === 'EXIF' || c.type === 'XMP ').map(c => c.data.toString('utf8').replace(/\0/g, ' ')); } catch { return []; }
}

/** 生成分享副本：返回 {buffer, format, removed}。 */
function stripForShare(buf) {
  const format = detectFormat(buf);
  const support = shareSupport(format);
  if (!support.supported) throw new AppError(CODES.UNSUPPORTED, support.reason);
  const r = format === 'png' ? stripPng(buf) : format === 'jpeg' ? stripJpeg(buf) : stripWebp(buf);
  return {...r, format};
}

// ---------- 生成信息解析 ----------
const SAMPLER_KEYS = ['seed', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'];
function summarizeComfyPrompt(prompt) {
  const out = {prompts: [], samplers: [], checkpoints: []};
  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    const inputs = node?.inputs ?? {}, type = String(node?.class_type ?? '');
    if (/CLIPTextEncode|TextEncode|PromptText/i.test(type)) for (const k of ['text', 'text_g', 'text_l', 'prompt']) if (typeof inputs[k] === 'string' && inputs[k].trim()) out.prompts.push({nodeId, classType: type, text: inputs[k]});
    if (/Sampler/i.test(type) || inputs.seed !== undefined || inputs.noise_seed !== undefined) {
      const s = {nodeId, classType: type};
      for (const k of SAMPLER_KEYS) if (inputs[k] !== undefined && !Array.isArray(inputs[k])) s[k] = inputs[k];
      if (Object.keys(s).length > 2) out.samplers.push(s);
    }
    if (typeof inputs.ckpt_name === 'string') out.checkpoints.push(inputs.ckpt_name);
    if (typeof inputs.unet_name === 'string') out.checkpoints.push(inputs.unet_name);
  }
  return out;
}
/** 从文件字节读取生成信息；缺失项在 missing 中列出，不猜测。 */
function readGenerationInfo(buf) {
  const format = detectFormat(buf);
  const info = {format, source: null, prompts: [], seed: null, parameters: null, samplers: [], checkpoints: [], hasWorkflow: false, raw: {}};
  try {
    if (format === 'png') {
      const text = pngText(buf);
      if (text.prompt) {
        try { Object.assign(info, summarizeComfyPrompt(JSON.parse(text.prompt))); info.source = 'comfyui'; } catch { info.raw.prompt = text.prompt.slice(0, 2000); }
      }
      if (text.workflow) { info.hasWorkflow = true; info.source ??= 'comfyui'; }
      if (text.parameters) { info.parameters = text.parameters; info.source ??= 'a1111'; }
      for (const k of Object.keys(text)) if (!['prompt', 'workflow', 'parameters'].includes(k)) info.raw[k] = text[k].slice(0, 2000);
    } else if (format === 'jpeg' || format === 'webp') {
      const texts = format === 'jpeg' ? jpegComments(buf) : webpMeta(buf);
      const joined = texts.join('\n');
      const wf = /workflow\s*:\s*(\{[\s\S]*\})/i.exec(joined);
      if (/"class_type"/.test(joined)) {
        const m = /(?:prompt\s*:\s*)?(\{[\s\S]*"class_type"[\s\S]*\})/.exec(joined);
        try { Object.assign(info, summarizeComfyPrompt(JSON.parse(m[1]))); info.source = 'comfyui'; } catch { /* 无法解析，保留缺失 */ }
      }
      if (wf) info.hasWorkflow = true;
      if (!info.source && /Steps:\s*\d+/.test(joined)) { info.parameters = joined.trim(); info.source = 'a1111'; }
    }
  } catch { /* 结构异常：全部视为缺失 */ }
  const primary = info.samplers.find(s => s.seed !== undefined || s.noise_seed !== undefined);
  info.seed = primary ? (primary.seed ?? primary.noise_seed) : (/Seed:\s*(\d+)/.exec(info.parameters ?? '')?.[1] ?? null);
  if (info.seed !== null) info.seed = String(info.seed);
  info.missing = ['prompts', 'seed', 'parameters', 'workflow'].filter(k => k === 'prompts' ? !info.prompts.length && !info.parameters : k === 'seed' ? info.seed === null : k === 'parameters' ? !info.samplers.length && !info.parameters : !info.hasWorkflow);
  return info;
}
module.exports = {detectFormat, shareSupport, SHARE_FORMATS, pngChunks, pngText, stripPng, stripJpeg, stripWebp, stripForShare, readGenerationInfo, summarizeComfyPrompt};
