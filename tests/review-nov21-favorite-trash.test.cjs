'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {TrashStore} = require('../desktop/maintenance/trash-store.cjs');
const {FavoritesBoard} = require('../desktop/services/favorites.cjs');
const {createMaintenanceService} = require('../desktop/services/maintenance-service.cjs');
const {sha256File} = require('../desktop/core/fs-atomic.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-favorite-trash-'));
  const trashDir = path.join(root, 'trash'), db = Database.open(path.join(root, 'test.db'));
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const pool = {run: async (type, {file}) => { assert.equal(type, 'sha256'); return {sha256: await sha256File(file)}; }};
  const methods = createMaintenanceService({db, layout: {root, trash: trashDir}, pool}).methods;
  const trash = new TrashStore({trashDir});
  const board = new FavoritesBoard({db, favoritesDir: path.join(root, 'board'), trashDir, trashStore: trash});
  const source = path.join(root, 'source.gif');
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  fs.writeFileSync(source, bytes);
  return {root, source, bytes, db, methods, trash, board};
}

test('恢复已取消的收藏到旧目录和收藏板，保留身份、顺序与失效来源', async t => {
  const {root, source, bytes, methods, trash, board} = fixture(t);
  const original = await board.add(source);
  board.remove(original.id);
  assert.equal(board.list().total, 0);
  fs.unlinkSync(source);
  board.dir = path.join(root, 'new-board');
  await methods['trash.restore'](trash.list()[0].id);
  const restored = board.list().items[0];
  assert.equal(restored.id, original.id);
  assert.equal(restored.assetId, original.assetId);
  assert.equal(restored.createdAt, original.createdAt);
  assert.deepEqual([restored.width, restored.height], [1, 1]);
  assert.equal(restored.sourceMissing, true);
  assert.equal(restored.storedPath, original.storedPath);
  assert.deepEqual(fs.readFileSync(restored.storedPath), bytes);
  assert.equal(trash.list().length, 0);
});

test('旧版仅保存来源路径的回收登记也能重建收藏；在新目录重收后按内容识别冲突', async t => {
  const {root, source, methods, trash, board} = fixture(t);
  const original = await board.add(source);
  board.remove(original.id);
  const registry = JSON.parse(fs.readFileSync(trash.file));
  const old = registry.items[0];
  delete old.favorite;
  fs.writeFileSync(trash.file, JSON.stringify(registry));
  await methods['trash.restore'](old.id);
  const rebuilt = board.list().items[0];
  assert.equal(rebuilt.hash, original.hash);
  assert.equal(rebuilt.sourcePath, source);
  board.remove(rebuilt.id);
  board.dir = path.join(root, 'new-board');
  const active = await board.add(source);
  const [pending] = trash.list();
  assert.notEqual(active.storedPath, pending.origin);
  await assert.rejects(methods['trash.restore'](pending.id), {code: 'CONFLICT'});
  assert.equal(board.list().items[0].id, active.id);
  assert.equal(trash.list()[0].exists, true);
});

test('模拟目录位于不同卷时，移入和恢复都能完整保留目录内容', t => {
  const {root, trash} = fixture(t);
  const dir = path.join(root, 'backup');
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'part.bin'), 'complete backup');
  const rename = fs.renameSync, moved = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    if ((from === dir || to === dir) && path.basename(from) !== 'payload') {
      moved.push(from);
      throw Object.assign(new Error('different volumes'), {code: 'EXDEV'});
    }
    return rename(from, to);
  });
  const entry = trash.move(dir, {kind: 'backup'});
  assert.equal(fs.existsSync(dir), false);
  trash.restore(entry.id);
  assert.equal(fs.readFileSync(path.join(dir, 'part.bin'), 'utf8'), 'complete backup');
  assert.deepEqual(moved, [dir, entry.stored]);
  assert.equal(trash.list().length, 0);
});

test('登记损坏或登记写入失败时，取消收藏保留图片和数据库记录', async t => {
  const {source, bytes, trash, board} = fixture(t);
  const original = await board.add(source);
  fs.mkdirSync(trash.dir, {recursive: true});
  fs.writeFileSync(trash.file, '{"items":');
  assert.throws(() => board.remove(original.id), {code: 'CORRUPT_DATA'});
  assert.equal(fs.readFileSync(trash.file, 'utf8'), '{"items":');
  fs.writeFileSync(trash.file, '{"items":[]}');
  const save = t.mock.method(trash, '_save', () => { throw new Error('disk full'); });
  assert.throws(() => board.remove(original.id), /disk full/);
  save.mock.restore();
  assert.equal(board.list().items[0].id, original.id);
  assert.deepEqual(fs.readFileSync(original.storedPath), bytes);
  assert.equal(trash.list().length, 0);
});

test('恢复时无法注销登记可再次尝试；失败期间不出现失效收藏', async t => {
  const {source, methods, trash, board} = fixture(t);
  const original = await board.add(source);
  board.remove(original.id);
  const [pending] = trash.list();
  const write = TrashStore.prototype._save;
  const save = t.mock.method(TrashStore.prototype, '_save', function (registry) {
    if (!registry.items.length) throw new Error('registry unavailable');
    return write.call(this, registry);
  });
  await assert.rejects(methods['trash.restore'](pending.id), /registry unavailable/);
  assert.equal(board.list().total, 0);
  assert.equal(trash.list()[0].exists, true);
  save.mock.restore();
  await methods['trash.restore'](pending.id);
  assert.equal(board.list().items[0].id, original.id);
});

test('恢复中断后重试已登记的收藏，兼容文件搬回前与搬回后两种断点', async t => {
  const {source, db, methods, trash, board} = fixture(t);
  const original = await board.add(source);
  board.remove(original.id);
  const [pending] = trash.list();
  // A terminated process may have committed the row and not yet issued the file move.
  db.run('INSERT INTO favorites (id, asset_id, source_path, stored_path, content_hash, width, height, created_at) VALUES (?,?,?,?,?,?,?,?)',
    original.id, original.assetId, original.sourcePath, original.storedPath, original.hash, original.width, original.height, original.createdAt);
  assert.equal(board.list().items[0].broken, true);
  const write = TrashStore.prototype._save;
  const interrupted = t.mock.method(TrashStore.prototype, '_save', function (registry) {
    // Leave precisely the registry that would be on disk after publication but before the final write.
    if (registry.items.length) write.call(this, registry);
  });
  await methods['trash.restore'](pending.id);
  assert.equal(board.list().items[0].broken, false);
  assert.equal(trash.list()[0].exists, false);
  interrupted.mock.restore();
  await methods['trash.restore'](pending.id);
  assert.equal(trash.list().length, 0);
  assert.equal(board.list().total, 1);
  assert.equal(board.list().items[0].id, original.id);
});
