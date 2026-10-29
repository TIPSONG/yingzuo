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
  const fav = () => {
    const favoritesDir = derived().favorites || layout.favorites;
    if (!board || board.dir !== favoritesDir) board = new FavoritesBoard({db: getDb(), favoritesDir, trashDir: layout.trash, trashStore: new TrashStore({trashDir: layout.trash}), pool: sharedPool()});
    return board;
  }; // C08：收藏复制与校验在 worker 中；新配置只影响新收藏，历史记录保留绝对位置。
  const files = new AssetFiles({shell: electron.shell, allowedRoots: () => [...Object.values(outputRoots()), ...Object.values(locations()), layout.thumbnails].filter(Boolean)});
  const pathOf = id => { const a = idx().get(id); if (a.missing) throw new AppError(CODES.NOT_FOUND, `原图已不存在：${a.path}`, {details: {path: a.path}}); return a.path; };
  // 收藏板使用单独的 ID 引用副本；不能通过原图 ID 回退，也不开放旧收藏目录的任意路径访问。
  const favoriteOf = id => {
    if (typeof id !== 'string' || !id.startsWith('favorite:')) return null;
    const row = getDb().get('SELECT * FROM favorites WHERE id = ?', id.slice(9));
    if (!row) throw new AppError(CODES.NOT_FOUND, '收藏不存在。');
    if (!path.isAbsolute(row.stored_path) || !fs.existsSync(row.stored_path) || !fs.statSync(row.stored_path).isFile()) throw new AppError(CODES.NOT_FOUND, '收藏副本已不存在。');
    return row;
  };
  const fileOf = id => {
    const f = favoriteOf(id);
    return f ? {path: f.stored_path, files: new AssetFiles({shell: electron.shell, allowedRoots: () => [f.stored_path]})} : {path: pathOf(id), files};
  };
  async function favoriteDetail(row) {
    const file = row.stored_path, st = fs.statSync(file);
    const parsed = await sharedPool().run('imageMeta', {file});
    const g = parsed.metadata.generation ?? {missing: ['prompts', 'seed', 'parameters', 'workflow']};
    let original = null; try { original = idx().get(row.asset_id); } catch { /* 原图或索引可以不存在 */ }
    return {id: `favorite:${row.id}`, favoriteId: row.id, path: file, name: path.basename(row.source_path), kind: 'image', format: parsed.format,
      size: st.size, width: parsed.metadata.dimensions?.width ?? row.width, height: parsed.metadata.dimensions?.height ?? row.height,
      sourcePath: row.source_path, sourceMissing: !fs.existsSync(row.source_path), task: original?.task ?? null,
      generation: {source: g.source ?? null, prompts: g.prompts ?? [], seed: g.seed ?? null, samplers: g.samplers ?? [], parameters: g.parameters ?? null, checkpoints: g.checkpoints ?? [], hasWorkflow: !!g.hasWorkflow},
      missingFields: [...(g.missing ?? []), ...(original?.task ? [] : ['task'])], readError: parsed.metadata.readError ?? null};
  }
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
    'assets.get': id => { const f = favoriteOf(id); return f ? favoriteDetail(f) : idx().get(id); },
    'assets.thumbnail': async (id, opts = {}) => { const f = favoriteOf(id); const t = f ? await idx().thumbnailFile(f.stored_path, opts) : await idx().thumbnail(id, opts); return {...t, dataUrl: `data:image/webp;base64,${fs.readFileSync(t.path).toString('base64')}`}; },
    'assets.linkTask': async taskId => {
      const row = getDb().get('SELECT id, outputs FROM tasks WHERE id = ?', taskId);
      if (!row) throw new AppError(CODES.NOT_FOUND, '任务不存在。');
      return idx().linkTaskOutputsAsync({id: row.id, outputs: JSON.parse(row.outputs || '[]')}, {outputRoots: outputRoots()}); // C08：元数据在 worker 中读取
    },
    'assets.previewPrefix': (prompt, opts = {}) => applyOutputPrefix(prompt, opts),
    'assets.openFile': id => { const f = fileOf(id); return f.files.openFile(f.path); },
    'assets.revealFile': id => { const f = fileOf(id); return f.files.revealFile(f.path); },
    'assets.openLocation': async name => { const p = locations()[name]; if (!p) throw new AppError(CODES.NOT_FOUND, `位置未配置：${name}`); return files.openDirectory(p); },
    'assets.shareSupport': id => { const f = fileOf(id); return f.files.shareSupportFor(f.path); },
    'assets.exportOriginal': async id => { const f = fileOf(id); return f.files.exportOriginal(f.path, await pickDir('导出原图到…')); },
    'assets.exportShare': async id => { const f = fileOf(id); const s = f.files.shareSupportFor(f.path); if (!s.supported) throw new AppError(CODES.UNSUPPORTED, s.reason); return f.files.exportShare(f.path, await pickDir('导出分享副本到…')); },
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
