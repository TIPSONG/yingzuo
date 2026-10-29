'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {stripForShare} = require('../desktop/core/image-meta.cjs');
const {Database} = require('../desktop/repositories/database.cjs');
const {createAssetsMethods} = require('../desktop/services/assets-api.cjs');

for (const format of ['png', 'webp']) test(`Issue 5: ${format} share export preserves orientation, pixels, alpha and color while removing private Exif`, async () => {
  const src = await sharp({create: {width: 8, height: 4, channels: 4, background: {r: 30, g: 100, b: 200, alpha: 0.5}}})
    .withMetadata({orientation: 6}).withIccProfile('p3').withExifMerge({IFD0: {ImageDescription: 'PRIVATE-GENERATION-PROMPT', Artist: 'PRIVATE-ARTIST'}})[format]().toBuffer();
  const result = stripForShare(src).buffer;
  const a = await sharp(src).metadata(), b = await sharp(result).metadata();
  assert.equal(a.orientation, 6);
  assert.equal(b.orientation, 6, 'display orientation must survive metadata removal');
  assert.deepEqual(b.autoOrient, a.autoOrient);
  assert.ok(b.icc.equals(a.icc)); assert.equal(b.hasAlpha, true);
  assert.ok((await sharp(src).raw().toBuffer()).equals(await sharp(result).raw().toBuffer()));
  assert.ok(!result.includes(Buffer.from('PRIVATE-GENERATION-PROMPT')));
  assert.ok(!result.includes(Buffer.from('PRIVATE-ARTIST')));
});

test('Issue 5: favorite copies remain viewable and exportable after source deletion and directory changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-issue5-'));
  const output = path.join(root, 'output'), oldFavorites = path.join(root, 'favorites'), dest = path.join(root, 'export');
  for (const dir of [output, oldFavorites, dest]) fs.mkdirSync(dir);
  const db = Database.open(path.join(root, 'data.sqlite'));
  t.after(() => db.close());
  const src = path.join(output, 'reference.png'), bytes = await sharp({create: {width: 8, height: 4, channels: 4, background: '#123456'}}).png().toBuffer();
  fs.writeFileSync(src, bytes);
  let favorites = oldFavorites;
  const layout = {root, database: path.join(root, 'data.sqlite'), thumbnails: path.join(root, 'thumbs'), favorites, trash: path.join(root, 'trash')};
  const opened = [], revealed = [];
  const api = createAssetsMethods({db, layout, configRepo: {derived: () => ({output, favorites})}, electron: {
    shell: {openPath: async file => { opened.push(file); return ''; }, showItemInFolder: file => revealed.push(file)},
    dialog: {showOpenDialog: async () => ({canceled: false, filePaths: [dest]})},
  }});
  t.after(() => api.dispose());
  await api['assets.scan']();
  const original = api['assets.list']().items[0], saved = await api['assets.favorite'](original.id);
  fs.unlinkSync(src); favorites = path.join(root, 'new-favorites');
  await api['assets.scan']();
  const ref = `favorite:${saved.id}`;
  const detail = await api['assets.get'](ref);
  assert.equal(detail.path, saved.storedPath); assert.equal(detail.favoriteId, saved.id); assert.equal(detail.sourceMissing, true);
  assert.deepEqual(detail.generation.prompts, []); assert.deepEqual(detail.generation.checkpoints, []); assert.deepEqual(detail.generation.samplers, []);
  assert.ok((await api['assets.thumbnail'](ref)).dataUrl.startsWith('data:image/webp;base64,'));
  await api['assets.openFile'](ref); api['assets.revealFile'](ref);
  assert.deepEqual(opened, [saved.storedPath]); assert.deepEqual(revealed, [saved.storedPath]);
  const originalExport = await api['assets.exportOriginal'](ref), shareExport = await api['assets.exportShare'](ref);
  assert.ok(fs.readFileSync(originalExport.exported).equals(bytes)); assert.ok(fs.existsSync(shareExport.exported));
  assert.equal(api['assets.list']().total, 0, 'viewing favorites must not add copies back into the output gallery');
  await assert.rejects(async () => api['assets.get']('favorite:unknown'), {code: 'NOT_FOUND'});
  await assert.rejects(async () => api['assets.openFile'](`favorite:${saved.storedPath}`), {code: 'NOT_FOUND'});
  fs.unlinkSync(saved.storedPath);
  await assert.rejects(async () => api['assets.thumbnail'](ref), {code: 'NOT_FOUND'});
});
