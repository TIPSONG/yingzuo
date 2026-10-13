'use strict';
const {sharedPool} = require('../core/worker-pool.cjs');
const {TrashStore} = require('../maintenance/trash-store.cjs');
// assets.* 接口（A01–A08）。独立文件，api.cjs 只需展开 createAssetsMethods(ctx) 返回的方法表。
// 渲染端只传作品 ID / 收藏 ID / 位置名，不传任意文件路径；导出目录经系统对话框选择。
const path = require('node:path');
const fs = require('node:fs');
const {AppError, CODES} = require('../core/errors.cjs');
const {AssetIndex} = require('./asset-index.cjs');
const {AssetFiles} = require('./asset-files.cjs');
const {FavoritesBoard, arrangeAlbum} = require('./favorites.cjs');
const {applyOutputPrefix} = require('./output-prefix.cjs');

function createAssetsMethods({electron, layout, configRepo, db: givenDb = null, getWindow = () => null, logger = null}) {
  let db = givenDb, ownDb = false;
  const getDb = () => {
    if (!db) { const {Database} = require('../repositories/database.cjs'); db = Database.open(layout.database); ownDb = true; }
    return db;
  };
  const derived = () => configRepo.derived(layout);
  const comfyRoot = () => configRepo.config?.comfy?.root || '';
  const outputRoots = () => { const d = derived(); return {output: d.output || null, input: d.input || null, temp: comfyRoot() ? path.join(comfyRoot(), 'temp') : null}; };
  const indexRoots = () => { const r = outputRoots(); return [r.output && {id: 'output', path: r.output}, r.input && {id: 'input', path: r.input}].filter(Boolean); };
  const locations = () => { const d = derived(); return {output: d.output, input: d.input, favorites: d.favorites, downloads: d.downloads, backups: d.backups, logs: layout.logs}; };
  let index = null, board = null;
  const idx = () => (index ??= new AssetIndex({db: getDb(), roots: indexRoots, thumbsDir: layout.thumbnails, pool: sharedPool()}));
  const fav = () => (board ??= new FavoritesBoard({db: getDb(), favoritesDir: derived().favorites || layout.favorites, trashDir: layout.trash, trashStore: new TrashStore({trashDir: layout.trash}), pool: sharedPool()})); // C08：收藏复制与校验在 worker 中
  const files = new AssetFiles({shell: electron.shell, allowedRoots: () => [...Object.values(outputRoots()), ...Object.values(locations()), layout.thumbnails].filter(Boolean)});
  const pathOf = id => { const a = idx().get(id); if (a.missing) throw new AppError(CODES.NOT_FOUND, `原图已不存在：${a.path}`, {details: {path: a.path}}); return a.path; };
  async function pickDir(title) {
    const r = await electron.dialog.showOpenDialog(getWindow(), {title, properties: ['openDirectory', 'createDirectory']});
    if (r.canceled || !r.filePaths?.[0]) throw new AppError(CODES.CANCELLED, '已取消导出。');
    return r.filePaths[0];
  }
  const methods = {
    'assets.scan': (opts = {}) => idx().scan({rootId: opts.rootId ?? null}),
    'assets.watch': () => ({watching: idx().watch()}),
    'assets.list': (q = {}) => idx().list(q),
    'assets.recent': (limit = 24) => idx().recent(limit),
    'assets.get': id => idx().get(id),
    'assets.thumbnail': async (id, opts = {}) => { const t = await idx().thumbnail(id, opts); return {...t, dataUrl: `data:image/webp;base64,${fs.readFileSync(t.path).toString('base64')}`}; },
    'assets.linkTask': async taskId => {
      const row = getDb().get('SELECT id, outputs FROM tasks WHERE id = ?', taskId);
      if (!row) throw new AppError(CODES.NOT_FOUND, '任务不存在。');
      return idx().linkTaskOutputsAsync({id: row.id, outputs: JSON.parse(row.outputs || '[]')}, {outputRoots: outputRoots()}); // C08：元数据在 worker 中读取
    },
    'assets.previewPrefix': (prompt, opts = {}) => applyOutputPrefix(prompt, opts),
    'assets.openFile': id => files.openFile(pathOf(id)),
    'assets.revealFile': id => files.revealFile(pathOf(id)),
    'assets.openLocation': async name => { const p = locations()[name]; if (!p) throw new AppError(CODES.NOT_FOUND, `位置未配置：${name}`); return files.openDirectory(p); },
    'assets.shareSupport': id => files.shareSupportFor(pathOf(id)),
    'assets.exportOriginal': async id => files.exportOriginal(pathOf(id), await pickDir('导出原图到…')),
    'assets.exportShare': async id => { const p = pathOf(id); const s = files.shareSupportFor(p); if (!s.supported) throw new AppError(CODES.UNSUPPORTED, s.reason); return files.exportShare(p, await pickDir('导出分享副本到…')); },
    'assets.favorite': id => fav().add(pathOf(id), {assetId: id}),
    'assets.unfavorite': favoriteId => fav().remove(favoriteId),
    'assets.favorites': (q = {}) => fav().list(q),
    'assets.favoriteLayout': (opts = {}) => arrangeAlbum(fav().list({limit: 500}).items.filter(i => !i.broken), opts),
  };
  Object.defineProperty(methods, 'dispose', {enumerable: false, value: () => { index?.unwatch(); if (ownDb) db?.close(); }});
  logger?.info?.('assets api ready');
  return methods;
}
module.exports = {createAssetsMethods};
