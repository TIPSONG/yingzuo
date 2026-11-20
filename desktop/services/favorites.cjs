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
const {TrashStore} = require('../maintenance/trash-store.cjs');

const extension = {png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif'};
function imageHeader(file) {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(65536);
  try { return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)); } finally { fs.closeSync(fd); }
}
const insertFavorite = 'INSERT INTO favorites (id, asset_id, source_path, stored_path, content_hash, width, height, created_at) VALUES (?,?,?,?,?,?,?,?)';

class FavoritesBoard {
  constructor({db, favoritesDir, trashDir, trashStore = null, pool = null, now = () => new Date().toISOString()}) {
    this.db = db; this.dir = favoritesDir; this.trashStore = trashStore ?? new TrashStore({trashDir}); this.pool = pool; this.now = now;
  }
  async add(sourcePath, {assetId = null} = {}) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new AppError(CODES.INVALID_PATH, `路径无效：${sourcePath}`);
    if (!fs.existsSync(sourcePath)) throw new AppError(CODES.NOT_FOUND, `文件不存在：${sourcePath}`);
    const head = Buffer.alloc(32); const fd = fs.openSync(sourcePath, 'r');
    try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
    const format = detectFormat(head);
    if (!['png', 'jpeg', 'webp', 'gif'].includes(format)) throw new AppError(CODES.UNSUPPORTED, `不是支持的图片：${sourcePath}`);
    const hashOf = async f => (this.pool ? (await this.pool.run('sha256', {file: f})).sha256 : sha256File(f));
    const hash = await hashOf(sourcePath);
    const dup = this.db.get('SELECT * FROM favorites WHERE content_hash = ?', hash);
    const repairing = !!dup && this.view(dup).broken;
    if (dup && !repairing) return {...this.view(dup), duplicate: true};
    const ext = extension[format];
    const month = this.now().slice(0, 7);
    const stored = path.join(this.dir, month, `${hash.slice(0, 16)}${ext}`);
    fs.mkdirSync(path.dirname(stored), {recursive: true});
    if (!fs.existsSync(stored)) {
      try {
        if (this.pool) await this.pool.run('copyFile', {src: sourcePath, dest: stored, excl: true});
        else fs.copyFileSync(sourcePath, stored, fs.constants.COPYFILE_EXCL);
      } catch (e) { if (e.code !== 'EEXIST') throw e; } // Another same-content request may have published first.
    }
    if ((await hashOf(stored)) !== hash) {
      // The path may predate this request or have been replaced during hashing. Preserve it.
      throw new AppError(CODES.INTEGRITY, '收藏副本校验失败；文件已保留供核对，未登记收藏。');
    }
    const concurrent = this.db.get('SELECT * FROM favorites WHERE content_hash = ?', hash);
    if (concurrent && !this.view(concurrent).broken) return {...this.view(concurrent), duplicate: !repairing, ...(repairing ? {repaired: true} : {})};
    const dim = imageSize(imageHeader(stored)) ?? {};
    // 副本丢失时保留收藏身份，并按当前目录配置重建；失效登记不能阻止再次收藏。
    if (concurrent) {
      this.db.run('UPDATE favorites SET asset_id = ?, source_path = ?, stored_path = ?, width = ?, height = ? WHERE id = ?',
        assetId ?? idFor(sourcePath), path.resolve(sourcePath), stored, dim.width ?? null, dim.height ?? null, concurrent.id);
      return {...this.view(this.db.get('SELECT * FROM favorites WHERE id = ?', concurrent.id)), duplicate: false, repaired: true};
    }
    const id = crypto.randomUUID();
    this.db.run(insertFavorite,
      id, assetId ?? idFor(sourcePath), path.resolve(sourcePath), stored, hash, dim.width ?? null, dim.height ?? null, this.now());
    return {...this.view(this.db.get('SELECT * FROM favorites WHERE id = ?', id)), duplicate: false};
  }
  remove(id) {
    const row = this.db.get('SELECT * FROM favorites WHERE id = ?', id);
    if (!row) throw new AppError(CODES.NOT_FOUND, '收藏不存在。');
    let trashed = null;
    this.db.transaction(() => {
      this.db.run('DELETE FROM favorites WHERE id = ?', id);
      if (fs.existsSync(row.stored_path) && path.resolve(row.stored_path) !== path.resolve(row.source_path)) {
        trashed = this.trashStore.move(row.stored_path, {kind: 'favorite', note: row.source_path,
          favorite: {id: row.id, assetId: row.asset_id, hash: row.content_hash, createdAt: row.created_at}}).stored;
      }
    });
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

async function restoreFavorite({db, trash, entry, hashFile = sha256File}) {
  const saved = entry.favorite;
  // Earlier registries stored only the source path. Their trash ID gives the rebuilt record a stable ID on retry.
  const id = saved?.id ?? entry.id.slice(3);
  if (!fs.existsSync(entry.stored)) {
    // restorable() has matched the published file's identity. Only finish the same board record.
    const active = db.get('SELECT * FROM favorites WHERE id = ?', id);
    if (!active || active.stored_path !== entry.origin || active.source_path !== entry.note || (saved && saved.hash !== active.content_hash)) {
      throw new AppError(CODES.CONFLICT, '收藏记录已变更，已保留回收登记。');
    }
    return trash.restore(entry.id);
  }
  if (!path.isAbsolute(entry.note ?? '') || !fs.lstatSync(entry.stored).isFile()) throw new AppError(CODES.INVALID_PATH, '收藏回收记录缺少有效的图片或来源。');
  const hash = await hashFile(entry.stored);
  // Hashing yields to other IPC requests. Recheck availability and conflicts before changing the board.
  entry = trash.restorable(entry.id);
  const head = imageHeader(entry.stored), ext = extension[detectFormat(head)];
  if (!ext || path.basename(entry.origin) !== hash.slice(0, 16) + ext || (saved && hash !== saved.hash)) {
    throw new AppError(CODES.INTEGRITY, '收藏副本校验失败，文件已保留在回收区。');
  }
  const dims = imageSize(head) ?? {};
  const existing = db.get('SELECT * FROM favorites WHERE content_hash = ?', hash);
  if (existing && (existing.id !== id || existing.stored_path !== entry.origin)) throw new AppError(CODES.CONFLICT, '这张图片已经重新收藏，请保留现有收藏或先取消收藏。');
  // Commit the board record first. After a process interruption a retry can finish publishing its copy.
  if (!existing) db.run(insertFavorite, id, saved?.assetId ?? idFor(entry.note), entry.note, entry.origin, hash,
    dims.width ?? null, dims.height ?? null, saved?.createdAt ?? new Date(entry.at).toISOString());
  try { return trash.restore(entry.id); }
  catch (error) {
    if (!existing && !fs.existsSync(entry.origin)) db.run('DELETE FROM favorites WHERE id = ?', id);
    throw error;
  }
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
module.exports = {FavoritesBoard, arrangeAlbum, restoreFavorite};
