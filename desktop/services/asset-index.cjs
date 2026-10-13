'use strict';
// A01 输出索引、A02 任务输出关联、A04 缩略图与查看器数据。
// 历史图片不移动；扫描分批让出事件循环；文件消失只标记 missing；外部位置无法确认时返回限制而不是猜路径。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {AppError, CODES} = require('../core/errors.cjs');
const {isInside, validateSegment} = require('../core/paths.cjs');
const {detectFormat, readGenerationInfo} = require('../core/image-meta.cjs');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm']);
const kindOf = ext => IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
const canonical = (p, platform = process.platform) => { const r = path.resolve(p); return platform === 'win32' ? r.toLowerCase() : r; };
const idFor = p => crypto.createHash('sha1').update(canonical(p)).digest('hex').slice(0, 20);
const tick = () => new Promise(r => setImmediate(r));

class AssetIndex {
  /** roots: () => [{id, path}]；sharp 可注入（测试或缺少原生模块时为 null，缩略图返回 UNSUPPORTED）。 */
  constructor({db, roots, thumbsDir, now = () => new Date().toISOString(), sharp, batch = 100, platform = process.platform}) {
    this.db = db; this.rootsFn = typeof roots === 'function' ? roots : () => roots; this.thumbsDir = thumbsDir;
    this.now = now; this.batch = batch; this.platform = platform; this.watchers = new Map(); this.scanning = null;
    if (sharp === undefined) { try { this.sharp = require('sharp'); } catch { this.sharp = null; } } else this.sharp = sharp;
  }
  roots() { return this.rootsFn().filter(r => r && r.path && path.isAbsolute(r.path)); }
  rootFor(file) { return this.roots().find(r => isInside(r.path, file, this.platform)) ?? null; }

  /** 读取单个文件并写入索引（大小与 mtime 未变时跳过）。返回记录或 null。 */
  indexFile(file, {rootId, taskId = null, source = 'scan', extra = null, force = false} = {}) {
    const ext = path.extname(file).toLowerCase(), kind = kindOf(ext);
    if (!kind) return null;
    let st;
    try { st = fs.statSync(file); } catch { this.markMissing(file); return null; }
    if (!st.isFile()) return null;
    const key = canonical(file, this.platform), id = idFor(file);
    const existing = this.db.get('SELECT * FROM assets WHERE id = ?', id);
    if (existing && !force && existing.file_size === st.size && existing.mtime === st.mtimeMs && !existing.missing && !taskId && !extra) return existing;
    let format = ext.slice(1).replace('jpg', 'jpeg'), metadata = {};
    if (kind === 'image') {
      try {
        const fd = fs.openSync(file, 'r');
        try { const buf = fs.readFileSync(fd); format = detectFormat(buf); metadata.generation = readGenerationInfo(buf); metadata.dimensions = imageSize(buf); }
        finally { fs.closeSync(fd); }
      } catch (e) { metadata.readError = e.message; }
    }
    const prev = existing ? JSON.parse(existing.metadata || '{}') : {};
    if (prev.task) metadata.task = prev.task;
    if (extra) Object.assign(metadata, extra);
    const row = {id, canonical_path: key, root_id: rootId ?? this.rootFor(file)?.id ?? null, kind, format, file_size: st.size, mtime: st.mtimeMs, source: existing && source === 'scan' ? existing.source : source, metadata: JSON.stringify(metadata), task_id: taskId ?? existing?.task_id ?? null, indexed_at: this.now()};
    this.db.run(`INSERT INTO assets (id, canonical_path, root_id, kind, format, file_size, mtime, source, metadata, missing, task_id, indexed_at, content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?,NULL) ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id, kind=excluded.kind, format=excluded.format, file_size=excluded.file_size,
      mtime=excluded.mtime, source=excluded.source, metadata=excluded.metadata, missing=0, task_id=excluded.task_id, indexed_at=excluded.indexed_at`,
      row.id, row.canonical_path, row.root_id, row.kind, row.format, row.file_size, row.mtime, row.source, row.metadata, row.task_id, row.indexed_at);
    return this.db.get('SELECT * FROM assets WHERE id = ?', id);
  }
  markMissing(file) { this.db.run('UPDATE assets SET missing = 1 WHERE id = ?', idFor(file)); }

  /** 全量／增量扫描。分批让出事件循环；未见到的同根记录标记 missing（不删除）。 */
  async scan({rootId = null, signal = null, onProgress = null} = {}) {
    if (this.scanning) return this.scanning;
    const run = async () => {
      const stats = {roots: 0, seen: 0, indexed: 0, missing: 0, errors: []};
      for (const root of this.roots().filter(r => !rootId || r.id === rootId)) {
        stats.roots++;
        const seen = new Set();
        if (!fs.existsSync(root.path)) { stats.errors.push({root: root.id, path: root.path, reason: '目录不存在'}); }
        else {
          const stack = [root.path];
          let n = 0;
          while (stack.length) {
            if (signal?.aborted) throw new AppError(CODES.CANCELLED, '扫描已取消。');
            const dir = stack.pop();
            let entries;
            try { entries = await fs.promises.readdir(dir, {withFileTypes: true}); } catch (e) { stats.errors.push({path: dir, reason: e.message}); continue; }
            for (const ent of entries) {
              const full = path.join(dir, ent.name);
              if (ent.isDirectory()) { stack.push(full); continue; }
              if (!ent.isFile() || !kindOf(path.extname(ent.name).toLowerCase())) continue;
              seen.add(idFor(full)); stats.seen++;
              const before = this.db.get('SELECT indexed_at FROM assets WHERE id = ?', idFor(full))?.indexed_at;
              const rec = this.indexFile(full, {rootId: root.id});
              if (rec && rec.indexed_at !== before) stats.indexed++;
              if (++n % this.batch === 0) { onProgress?.({...stats}); await tick(); }
            }
          }
        }
        const rows = this.db.all('SELECT id FROM assets WHERE root_id = ? AND missing = 0', root.id);
        for (const r of rows) if (!seen.has(r.id)) { this.db.run('UPDATE assets SET missing = 1 WHERE id = ?', r.id); stats.missing++; }
      }
      return stats;
    };
    this.scanning = run().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  /** 监视根目录：变化合并后按文件增量更新。Windows/macOS 支持 recursive；其他平台退化为顶层监视 + 手动重扫。 */
  watch({debounceMs = 400, onChange = null} = {}) {
    this.unwatch();
    for (const root of this.roots()) {
      if (!fs.existsSync(root.path)) continue;
      const pending = new Set();
      let timer = null;
      const flush = () => { timer = null; const files = [...pending]; pending.clear(); for (const f of files) { try { fs.existsSync(f) ? this.indexFile(f, {rootId: root.id}) : this.markMissing(f); } catch { /* 下次扫描再处理 */ } } onChange?.({root: root.id, files}); };
      try {
        const w = fs.watch(root.path, {recursive: true}, (_event, name) => { if (!name) return; pending.add(path.join(root.path, String(name))); timer ??= setTimeout(flush, debounceMs); });
        w.on('error', () => {});
        this.watchers.set(root.id, w);
      } catch { /* 不支持监视：依靠手动/定时重扫 */ }
    }
    return [...this.watchers.keys()];
  }
  unwatch() { for (const w of this.watchers.values()) try { w.close(); } catch { /* 已关闭 */ } this.watchers.clear(); }

  /** 分页查询：搜索路径与生成信息；可按格式、根、任务、是否包含缺失筛选。 */
  list({offset = 0, limit = 50, query = '', format = null, rootId = null, taskId = null, kind = null, includeMissing = false, favoritesOnly = false} = {}) {
    limit = Math.max(1, Math.min(200, Number(limit) || 50)); offset = Math.max(0, Number(offset) || 0);
    const where = [], params = [];
    if (!includeMissing) where.push('missing = 0');
    if (format) { where.push('format = ?'); params.push(format); }
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (rootId) { where.push('root_id = ?'); params.push(rootId); }
    if (taskId) { where.push('task_id = ?'); params.push(taskId); }
    if (favoritesOnly) where.push('id IN (SELECT asset_id FROM favorites WHERE asset_id IS NOT NULL)');
    for (const term of String(query).trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("(canonical_path LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')");
      const like = `%${term.replace(/[\\%_]/g, m => '\\' + m)}%`; params.push(like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get(`SELECT COUNT(*) AS n FROM assets ${clause}`, ...params).n;
    const items = this.db.all(`SELECT * FROM assets ${clause} ORDER BY mtime DESC, id LIMIT ? OFFSET ?`, ...params, limit, offset).map(r => this.summary(r));
    return {total, offset, limit, items, nextOffset: offset + items.length < total ? offset + items.length : null};
  }
  recent(limit = 24) { return this.list({limit}).items; }
  summary(r) {
    const m = JSON.parse(r.metadata || '{}');
    return {id: r.id, path: r.canonical_path, name: path.basename(r.canonical_path), rootId: r.root_id, kind: r.kind, format: r.format, size: r.file_size, mtime: r.mtime, missing: !!r.missing, taskId: r.task_id, source: r.source, width: m.dimensions?.width ?? null, height: m.dimensions?.height ?? null, seed: m.generation?.seed ?? null};
  }
  /** 查看器详情：任务、提示词、seed、参数、工作流；缺失项在 missing 中标注。 */
  get(id) {
    const r = this.db.get('SELECT * FROM assets WHERE id = ?', id);
    if (!r) throw new AppError(CODES.NOT_FOUND, '作品不在索引中。');
    const m = JSON.parse(r.metadata || '{}'), g = m.generation ?? {missing: ['prompts', 'seed', 'parameters', 'workflow']};
    let task = null;
    if (r.task_id) { const t = this.db.get('SELECT id, kind, state, workflow_id, created_at, finished_at FROM tasks WHERE id = ?', r.task_id); task = t ?? {id: r.task_id, missingRecord: true}; }
    const missing = [...(g.missing ?? [])]; if (!task) missing.push('task');
    if (r.missing) missing.push('file');
    return {...this.summary(r), task, taskOutput: m.task ?? null, generation: {source: g.source ?? null, prompts: g.prompts ?? [], seed: g.seed ?? null, samplers: g.samplers ?? [], parameters: g.parameters ?? null, checkpoints: g.checkpoints ?? [], hasWorkflow: !!g.hasWorkflow}, missingFields: missing, readError: m.readError ?? null};
  }
  /** 缩略图缓存：键 = 路径 + mtime + 大小 + 尺寸；源文件变化后自动失效。 */
  async thumbnail(id, {size = 256} = {}) {
    size = [128, 256, 512, 1024].includes(size) ? size : 256;
    const r = this.db.get('SELECT * FROM assets WHERE id = ?', id);
    if (!r) throw new AppError(CODES.NOT_FOUND, '作品不在索引中。');
    if (r.kind !== 'image') throw new AppError(CODES.UNSUPPORTED, '该类型没有缩略图。');
    if (!this.sharp) throw new AppError(CODES.UNSUPPORTED, '缩略图组件不可用（sharp 未加载）。');
    const key = crypto.createHash('sha1').update(`${r.canonical_path}|${r.mtime}|${r.file_size}|${size}`).digest('hex');
    const target = path.join(this.thumbsDir, key.slice(0, 2), `${key}.webp`);
    if (fs.existsSync(target)) return {path: target, cached: true};
    if (!fs.existsSync(r.canonical_path)) { this.db.run('UPDATE assets SET missing = 1 WHERE id = ?', id); throw new AppError(CODES.NOT_FOUND, `原图已不存在：${r.canonical_path}`); }
    fs.mkdirSync(path.dirname(target), {recursive: true});
    const tmp = `${target}.${process.pid}.tmp`;
    await this.sharp(r.canonical_path, {limitInputPixels: 268402689, animated: false}).rotate().resize(size, size, {fit: 'inside', withoutEnlargement: true}).webp({quality: 80}).toFile(tmp);
    fs.renameSync(tmp, target);
    return {path: target, cached: false};
  }

  /** A02：把任务 history 输出解析为真实文件并关联。不能确认合法根目录时返回 unresolved 及原因。 */
  linkTaskOutputs(task, {outputRoots}) {
    const results = [];
    for (const out of task.outputs ?? []) {
      if (out.kind !== 'image' && out.kind !== 'video') continue;
      const r = resolveComfyOutput(out, outputRoots, this.platform);
      if (r.status !== 'resolved') { results.push({...r, output: out}); continue; }
      if (!fs.existsSync(r.path)) { results.push({status: 'missing', reason: '文件已不在记录的位置（可能被移动或删除）', path: r.path, output: out}); continue; }
      const rec = this.indexFile(r.path, {taskId: task.id, source: 'task', extra: {task: {taskId: task.id, nodeId: out.nodeId, type: out.type, subfolder: out.subfolder, filename: out.filename}}});
      results.push({status: 'linked', path: r.path, assetId: rec?.id ?? null, output: out});
    }
    return results;
  }
}

/** ComfyUI {filename, subfolder, type} → 根目录内的真实路径。不做任何猜测。 */
function resolveComfyOutput(out, outputRoots = {}, platform = process.platform) {
  const type = out.type ?? 'output';
  const root = outputRoots[type];
  if (!root) return {status: 'unresolved', reason: `未配置 ComfyUI 的 ${type} 目录（外部 ComfyUI 时位置无法确认），未猜测路径。`};
  const name = String(out.filename ?? '');
  if (!name || /[\\/]/.test(name) || validateSegment(name)) return {status: 'rejected', reason: `文件名不合法：${name}`};
  const segs = String(out.subfolder ?? '').split(/[\\/]+/).filter(Boolean);
  for (const s of segs) if (validateSegment(s)) return {status: 'rejected', reason: `子目录不合法：${out.subfolder}`};
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const full = lib.join(lib.resolve(root), ...segs, name);
  if (!isInside(root, full, platform)) return {status: 'rejected', reason: '路径超出 ComfyUI 输出目录。'};
  return {status: 'resolved', path: full};
}

/** 只读取头部获取尺寸（PNG/JPEG/WebP/GIF）。 */
function imageSize(buf) {
  const f = detectFormat(buf);
  try {
    if (f === 'png') return {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20)};
    if (f === 'gif') return {width: buf.readUInt16LE(6), height: buf.readUInt16LE(8)};
    if (f === 'webp') {
      const t = buf.toString('latin1', 12, 16);
      if (t === 'VP8X') return {width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3)};
      if (t === 'VP8L') { const b = buf.readUInt32LE(21); return {width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff)}; }
      if (t === 'VP8 ') return {width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff};
    }
    if (f === 'jpeg') {
      let off = 2;
      while (off < buf.length) {
        if (buf[off] !== 0xff) return null;
        const m = buf[off + 1], len = buf.readUInt16BE(off + 2);
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return {width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5)};
        off += 2 + len;
      }
    }
  } catch { /* 头部损坏 */ }
  return null;
}
module.exports = {AssetIndex, resolveComfyOutput, imageSize, idFor, canonical, IMAGE_EXT};
