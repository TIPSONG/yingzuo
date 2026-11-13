'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const {Database} = require('../desktop/repositories/database.cjs');
const {FavoritesBoard} = require('../desktop/services/favorites.cjs');

test('re-favoriting a missing saved copy restores it without duplicating the record', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-nov13-favorite-'));
  const db = Database.open(path.join(root, 'data.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const source = path.join(root, 'source.png');
  await sharp({create: {width: 8, height: 4, channels: 4, background: '#123456'}}).png().toFile(source);
  const board = new FavoritesBoard({db, favoritesDir: path.join(root, 'favorites'), trashDir: path.join(root, 'trash')});
  const first = await board.add(source);
  fs.unlinkSync(first.storedPath);
  board.dir = path.join(root, 'new-favorites');
  const restored = await board.add(source);
  assert.equal(restored.id, first.id);
  assert.equal(restored.broken, false);
  assert.equal(board.list().total, 1);
  assert.ok(fs.readFileSync(restored.storedPath).equals(fs.readFileSync(source)));
  assert.equal((await board.add(source)).duplicate, true);
});

test('re-favoriting a missing copy at the same path reports a repair', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-nov13-favorite-same-'));
  const db = Database.open(path.join(root, 'data.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const source = path.join(root, 'source.png');
  await sharp({create: {width: 8, height: 4, channels: 4, background: '#123456'}}).png().toFile(source);
  const board = new FavoritesBoard({db, favoritesDir: path.join(root, 'favorites'), trashDir: path.join(root, 'trash'), now: () => '2026-11-13T00:00:00Z'});
  const first = await board.add(source);
  fs.unlinkSync(first.storedPath);
  const restored = await board.add(source);
  assert.equal(restored.storedPath, first.storedPath);
  assert.equal(restored.id, first.id);
  assert.equal(restored.repaired, true);
  assert.equal(restored.duplicate, false);
  assert.ok(fs.readFileSync(restored.storedPath).equals(fs.readFileSync(source)));
  assert.equal(board.list().total, 1);
});
