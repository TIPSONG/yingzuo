'use strict';
// A08 收藏板：复制到收藏目录（按内容哈希去重），保留来源；取消收藏只移走收藏副本到 trash，不碰原始文件；
// 列表时识别来源/副本失效；提供相册自动排列（等高行布局）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {AppError, CODES} = require('../core/errors.cjs');
const {sha256File} = require('../core/fs-atomic.cjs');
const {detectFormat} = require('../core/image-meta.cjs');
const {imageSize, idFor} = require('./asset-index.cjs');

class FavoritesBoard {
  constructor({db, favoritesDir, trashDir, now = () => new Date().toISOString()}) {
    this.db = db; this.dir = favoritesDir; this.trash = trashDir; this.now = now;
  }
  async add(sourcePath, {assetId = null} = {}) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new AppError(CODES.INVALID_PATH, `路径无效：${sourcePath}`);
    if (!fs.existsSync(sourcePath)) throw new AppError(CODES.NOT_FOUND, `文件不存在：${sourcePath}`);
    const head = Buffer.alloc(32); const fd = fs.openSync(sourcePath, 'r');
    try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
    const format = detectFormat(head);
    if (!['png', 'jpeg', 'webp', 'gif'].includes(format)) throw new AppError(CODES.UNSUPPORTED, `不是支持的图片：${sourcePath}`);
    const hash = await sha256File(sourcePath);
    const dup = this.db.get('SELECT * FROM favorites WHERE content_hash = ?', hash);
    if (dup) return {...this.view(dup), duplicate: true};
    const ext = {png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif'}[format];
    const month = this.now().slice(0, 7);
    const stored = path.join(this.dir, month, `${hash.slice(0, 16)}${ext}`);
    fs.mkdirSync(path.dirname(stored), {recursive: true});
    if (!fs.existsSync(stored)) fs.copyFileSync(sourcePath, stored, fs.constants.COPYFILE_EXCL);
    if ((await sha256File(stored)) !== hash) { fs.rmSync(stored, {force: true}); throw new AppError(CODES.INTEGRITY, '收藏副本校验失败。'); }
    const buf = fs.readFileSync(stored, {flag: 'r'}).subarray(0, 65536);
    const dim = imageSize(buf) ?? {};
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO favorites (id, asset_id, source_path, stored_path, content_hash, width, height, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, assetId ?? idFor(sourcePath), path.resolve(sourcePath), stored, hash, dim.width ?? null, dim.height ?? null, this.now());
    return {...this.view(this.db.get('SELECT * FROM favorites WHERE id = ?', id)), duplicate: false};
  }
  remove(id) {
    const row = this.db.get('SELECT * FROM favorites WHERE id = ?', id);
    if (!row) throw new AppError(CODES.NOT_FOUND, '收藏不存在。');
    let trashed = null;
    if (fs.existsSync(row.stored_path) && path.resolve(row.stored_path) !== path.resolve(row.source_path)) {
      trashed = path.join(this.trash, 'favorites', `${Date.now()}-${path.basename(row.stored_path)}`);
      fs.mkdirSync(path.dirname(trashed), {recursive: true});
      fs.renameSync(row.stored_path, trashed);
    }
    this.db.run('DELETE FROM favorites WHERE id = ?', id);
    return {removed: id, sourceKept: row.source_path, trashed};
  }
  view(r) {
    const storedOk = fs.existsSync(r.stored_path), sourceOk = fs.existsSync(r.source_path);
    return {id: r.id, assetId: r.asset_id, sourcePath: r.source_path, storedPath: r.stored_path, hash: r.content_hash, width: r.width, height: r.height, createdAt: r.created_at,
      sourceMissing: !sourceOk, storedMissing: !storedOk, broken: !storedOk};
  }
  list({offset = 0, limit = 100} = {}) {
    const total = this.db.get('SELECT COUNT(*) AS n FROM favorites').n;
    const items = this.db.all('SELECT * FROM favorites ORDER BY created_at DESC, id LIMIT ? OFFSET ?', Math.min(500, limit), offset).map(r => this.view(r));
    return {total, items};
  }
  isFavorite(sourcePath) { return !!this.db.get('SELECT 1 AS x FROM favorites WHERE source_path = ?', path.resolve(sourcePath)); }
}
/** 相册自动排列：等高行（justified）布局，缺尺寸按 1:1。 */
function arrangeAlbum(items, {width = 1200, rowHeight = 220, gap = 8} = {}) {
  const rows = []; let row = [], ratioSum = 0;
  const flush = last => {
    if (!row.length) return;
    const h = last ? Math.min(rowHeight, (width - gap * (row.length - 1)) / ratioSum) : (width - gap * (row.length - 1)) / ratioSum;
    let x = 0; const y = rows.length ? rows.at(-1).y + rows.at(-1).height + gap : 0;
    rows.push({y, height: Math.round(h), items: row.map(it => { const w = Math.round(it.ratio * h); const cell = {id: it.id, x: Math.round(x), y: Math.round(y), width: w, height: Math.round(h)}; x += w + gap; return cell; })});
    row = []; ratioSum = 0;
  };
  for (const it of items) {
    const ratio = it.width && it.height ? Math.min(4, Math.max(0.25, it.width / it.height)) : 1;
    row.push({id: it.id, ratio}); ratioSum += ratio;
    if (ratioSum * rowHeight + gap * (row.length - 1) >= width) flush(false);
  }
  flush(true);
  return {width, height: rows.length ? rows.at(-1).y + rows.at(-1).height : 0, cells: rows.flatMap(r => r.items)};
}
module.exports = {FavoritesBoard, arrangeAlbum};
