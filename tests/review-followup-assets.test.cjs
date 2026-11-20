'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {DownloadManager} = require('../desktop/services/online/downloader.cjs');
const {WorkerPool, TempJournal, WORKER, sharedPool} = require('../desktop/core/worker-pool.cjs');
const {createAssetsMethods} = require('../desktop/services/assets-api.cjs');
const {CivitaiProvider} = require('../desktop/services/online/providers.cjs');
const {publishNewFile} = require('../desktop/core/publish-new-file.cjs');
const {FavoritesBoard} = require('../desktop/services/favorites.cjs');
const crypto = require('node:crypto');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-assets-followup-'));
  const db = Database.open(path.join(dir, 'data.db'));
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {dir, db};
}
async function finished(manager, id) {
  for (let i = 0; i < 1000; i++) {
    const d = manager.get(id);
    if (['completed', 'failed', 'cancelled'].includes(d.state) && !manager.running.has(id)) return d;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('download did not settle');
}
const add = (m, destination, id = 'model') => m.add({source: 'url', fileId: id, urlRef: {id}, destination});

test('download retries reserve their target and each download owns a separate partial file', t => {
  const {dir, db} = fixture(t);
  const m = new DownloadManager({db, resolve: async () => ({}), concurrency: 0});
  const destination = path.join(dir, 'model.gguf');
  const first = add(m, destination, 'old');
  m._update(first.id, {state: 'failed'});
  fs.writeFileSync(first.tempPath, 'old partial');
  const second = add(m, destination, 'new');
  assert.notEqual(first.tempPath, second.tempPath, 'different source tasks must not share bytes');
  assert.throws(() => m.resume(first.id), {code: 'CONFLICT'}, 'resume must recheck active target ownership');
  assert.equal(m.get(first.id).state, 'failed');
  m.cancel(second.id);
  assert.equal(fs.readFileSync(first.tempPath, 'utf8'), 'old partial');
  assert.equal(m.resume(first.id).state, 'queued');
});

test('download target claims honor Windows path casing when adding or resuming', t => {
  const {dir, db} = fixture(t);
  const m = new DownloadManager({db, resolve: async () => ({}), concurrency: 0, platform: 'win32'});
  const first = add(m, path.join(dir, 'Model.gguf'));
  assert.throws(() => add(m, path.join(dir, 'model.gguf')), {code: 'CONFLICT'});
  m._update(first.id, {state: 'failed'});
  const second = add(m, path.join(dir, 'model.gguf'));
  assert.throws(() => m.resume(first.id), {code: 'CONFLICT'});
  assert.equal(m.get(second.id).state, 'queued');
});

test('download completion never replaces a file created between its final check and publication', async t => {
  const {dir, db} = fixture(t);
  const destination = path.join(dir, 'model.gguf'), body = Buffer.from('downloaded model');
  const m = new DownloadManager({db, resolve: async () => ({url: 'https://fixture.invalid/model'}), maxRetries: 0,
    fetchImpl: async () => new Response(body, {headers: {'content-length': String(body.length)}})});
  const originalExists = fs.existsSync;
  let checks = 0;
  fs.existsSync = file => {
    if (file === destination && ++checks === 2) { fs.writeFileSync(destination, 'another writer'); return false; }
    return originalExists(file);
  };
  let result, d;
  try { d = add(m, destination); result = await finished(m, d.id); }
  finally { fs.existsSync = originalExists; }
  assert.equal(result.state, 'failed');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'another writer');
  assert.deepEqual(fs.readFileSync(d.tempPath), body, 'the complete downloaded copy remains recoverable');
});

test('favorite location changes apply to new copies while existing favorites retain their location', async t => {
  const {dir, db} = fixture(t), out = path.join(dir, 'output'); fs.mkdirSync(out);
  const sharp = require('sharp');
  for (const [name, color] of [['a.png', '#112233'], ['b.png', '#445566']]) {
    await sharp({create: {width: 8, height: 8, channels: 3, background: color}}).png().toFile(path.join(out, name));
  }
  const layout = {root: dir, database: path.join(dir, 'data.db'), thumbnails: path.join(dir, 'thumbs'), favorites: path.join(dir, 'favorites'), trash: path.join(dir, 'trash')};
  let favorites = layout.favorites;
  const configRepo = {derived: () => ({output: out, favorites})};
  const api = createAssetsMethods({db, layout, configRepo, electron: {shell: {}, dialog: {}}});
  await api['assets.scan']();
  const items = api['assets.list']().items;
  const first = await api['assets.favorite'](items.find(x => x.name === 'a.png').id);
  favorites = path.join(dir, 'new-favorites');
  const second = await api['assets.favorite'](items.find(x => x.name === 'b.png').id);
  await sharedPool().cleaned(); api.dispose();
  assert.ok(second.storedPath.startsWith(favorites + path.sep), 'new favorite uses the newly saved directory');
  assert.ok(fs.existsSync(first.storedPath), 'changing configuration does not move old favorites');
  assert.equal(api['assets.favorites']().items.length, 2);
});

test('worker copy never overwrites a destination that appears at its final publication check', async t => {
  const {dir} = fixture(t), src = path.join(dir, 'source.bin'), dest = path.join(dir, 'copy.bin');
  fs.writeFileSync(src, 'original image');
  const script = path.join(dir, 'race-worker.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs'); const original = fs.existsSync; let checks = 0; fs.existsSync = file => { if (file === ${JSON.stringify(dest)} && ++checks === 2) { fs.writeFileSync(file, 'another writer'); return false; } return original(file); }; require(${JSON.stringify(WORKER)});`);
  const pool = new WorkerPool({size: 1, script});
  try {
    await assert.rejects(pool.run('copyFile', {src, dest}), {code: 'EEXIST'});
    await pool.cleaned();
    assert.equal(fs.readFileSync(dest, 'utf8'), 'another writer');
    assert.ok(!fs.readdirSync(dir).some(x => x.includes('.yz-copy-')));
  } finally { await pool.close(); }
});

test('publication falls back to exclusive copy on filesystems without hard links', async t => {
  const {dir} = fixture(t), temp = path.join(dir, 'owned.part'), dest = path.join(dir, 'result.bin');
  fs.writeFileSync(temp, 'verified bytes');
  const originalLink = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('links unavailable'), {code: 'ENOTSUP'}); };
  try {
    await publishNewFile(temp, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'verified bytes');
    assert.ok(!fs.existsSync(temp));
    fs.writeFileSync(temp, 'new download');
    await assert.rejects(publishNewFile(temp, dest), {code: 'EEXIST'});
    assert.equal(fs.readFileSync(dest, 'utf8'), 'verified bytes');
    assert.equal(fs.readFileSync(temp, 'utf8'), 'new download');
  } finally { fs.linkSync = originalLink; }
});

test('a pause received during final verification preserves partial bytes and does not publish', async t => {
  const {dir, db} = fixture(t), dest = path.join(dir, 'pause.bin');
  let m;
  m = new DownloadManager({db, resolve: async () => ({url: 'https://fixture.invalid/model'}), maxRetries: 0,
    events: {emit: (event, id, data) => { if (event === 'downloads.changed' && data.state === 'verifying') m.pause(id); }},
    fetchImpl: async () => new Response('complete but paused', {headers: {'content-length': '19'}})});
  const d = add(m, dest);
  for (let i = 0; i < 1000 && m.running.has(d.id); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(m.get(d.id).state, 'paused');
  assert.ok(!fs.existsSync(dest));
  assert.equal(fs.readFileSync(d.tempPath, 'utf8'), 'complete but paused');
});

test('worker rejects a source changed before copy completion and does not leave a partial destination', async t => {
  const {dir} = fixture(t), src = path.join(dir, 'source.bin'), dest = path.join(dir, 'copy.bin');
  fs.writeFileSync(src, 'original bytes');
  const script = path.join(dir, 'change-worker.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs'); const original = fs.createReadStream; fs.createReadStream = (...args) => { const stream = original(...args); if(args[0] === ${JSON.stringify(src)}) stream.on('end', () => fs.appendFileSync(args[0], 'changed')); return stream; }; require(${JSON.stringify(WORKER)});`);
  const pool = new WorkerPool({size: 1, script});
  try {
    await assert.rejects(pool.run('copyFile', {src, dest}), {code: 'SOURCE_CHANGED'});
    await pool.cleaned();
    assert.ok(!fs.existsSync(dest));
    assert.equal(fs.readFileSync(src, 'utf8'), 'original byteschanged');
    assert.ok(!fs.readdirSync(dir).some(x => x.includes('.yz-copy-')));
  } finally { await pool.close(); }
});

test('Civitai resolves the chosen file, refreshes its address and refuses to fall back to another file', async () => {
  let versionReads = 0;
  const provider = new CivitaiProvider({token: () => 'private-token', fetchImpl: async url => {
    assert.equal(String(url), 'https://civitai.com/api/v1/model-versions/77'); versionReads++;
    return new Response(JSON.stringify({id: 77, files: [
      {id: 1, downloadUrl: 'https://civitai.com/api/download/models/77?fp=fp32'},
      {id: 2, downloadUrl: `https://civitai.com/api/download/models/77?fp=fp16&revision=${versionReads}`},
      {id: 3, downloadUrl: 'https://cdn.example.invalid/file.bin?temporary=private'}
    ]}));
  }});
  const first = await provider.resolveDownload({versionId: 77, fileId: 2});
  assert.match(first.url, /fp=fp16&revision=1$/);
  assert.equal(first.headers.authorization, 'Bearer private-token');
  assert.match((await provider.resolveDownload({versionId: 77, fileId: 2})).url, /revision=2$/);
  await assert.rejects(provider.resolveDownload({versionId: 77, fileId: 999}), {code: 'NOT_FOUND'});
  assert.deepEqual((await provider.resolveDownload({versionId: 77, fileId: 3})).headers, {}, 'provider credentials must not be sent to a different origin');
});

test('concurrent favorite requests for the same image converge on one copy and one record', async t => {
  const {dir, db} = fixture(t), src = path.join(dir, 'image.png');
  await require('sharp')({create: {width: 8, height: 8, channels: 3, background: '#123456'}}).png().toFile(src);
  const board = new FavoritesBoard({db, favoritesDir: path.join(dir, 'favorites'), trashDir: path.join(dir, 'trash')});
  const [a, b] = await Promise.all([board.add(src), board.add(src)]);
  assert.equal(a.id, b.id); assert.equal(board.list().total, 1);
  assert.ok(a.duplicate || b.duplicate);
});

test('an unexpected existing favorite-path file is never deleted on integrity failure', async t => {
  const {dir, db} = fixture(t), src = path.join(dir, 'image.png'), favoritesDir = path.join(dir, 'favorites');
  await require('sharp')({create: {width: 8, height: 8, channels: 3, background: '#123456'}}).png().toFile(src);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  const stored = path.join(favoritesDir, '2026-10', `${hash.slice(0, 16)}.png`);
  fs.mkdirSync(path.dirname(stored), {recursive: true}); fs.writeFileSync(stored, 'unrelated existing contents');
  const board = new FavoritesBoard({db, favoritesDir, trashDir: path.join(dir, 'trash'), now: () => '2026-10-26T00:00:00Z'});
  await assert.rejects(board.add(src), {code: 'INTEGRITY'});
  assert.equal(fs.readFileSync(stored, 'utf8'), 'unrelated existing contents');
  assert.equal(board.list().total, 0); assert.ok(fs.existsSync(src));
});

test('publication preserves an unrelated file that replaces the newly created hard link', async t => {
  const {dir} = fixture(t), temp = path.join(dir, 'owned.part'), dest = path.join(dir, 'model.bin');
  fs.writeFileSync(temp, 'verified bytes');
  const originalLink = fs.linkSync;
  fs.linkSync = (src, target) => { originalLink(src, target); fs.unlinkSync(target); fs.writeFileSync(target, 'unrelated'); };
  try { await assert.rejects(publishNewFile(temp, dest), {code: 'SOURCE_CHANGED'}); }
  finally { fs.linkSync = originalLink; }
  assert.equal(fs.readFileSync(dest, 'utf8'), 'unrelated');
  assert.equal(fs.readFileSync(temp, 'utf8'), 'verified bytes');
});

test('exclusive-copy fallback detects same-size replacement and preserves the verified source', async t => {
  const {dir} = fixture(t), temp = path.join(dir, 'owned.part'), dest = path.join(dir, 'model.bin');
  fs.writeFileSync(temp, 'verified bytes');
  const originalLink = fs.linkSync, originalWrite = fs.createWriteStream;
  fs.linkSync = () => { throw Object.assign(new Error('links unavailable'), {code: 'ENOTSUP'}); };
  fs.createWriteStream = (...args) => {
    const stream = originalWrite(...args);
    if (args[0] === dest) stream.on('close', () => { fs.unlinkSync(dest); fs.writeFileSync(dest, 'unrelated text'); });
    return stream;
  };
  try { await assert.rejects(publishNewFile(temp, dest), {code: 'SOURCE_CHANGED'}); }
  finally { fs.linkSync = originalLink; fs.createWriteStream = originalWrite; }
  assert.equal(fs.readFileSync(dest, 'utf8'), 'unrelated text');
  assert.equal(fs.readFileSync(temp, 'utf8'), 'verified bytes');
});

test('worker cleanup and restart recovery preserve a replacement at a registered temporary path', async t => {
  const {dir} = fixture(t), journal = path.join(dir, 'temps.json'), script = path.join(dir, 'replace-worker.cjs');
  const dest = path.join(dir, 'copy.bin');
  fs.writeFileSync(script, `const fs = require('node:fs'); require('node:worker_threads').parentPort.on('message', m => { fs.renameSync(m.args.tmp, m.args.tmp + '.original'); fs.writeFileSync(m.args.tmp, 'another writer'); process.exit(3); });`);
  const pool = new WorkerPool({size: 1, script, journalFile: journal});
  try {
    await assert.rejects(pool.run('copyFile', {src: 'unused', dest}), {code: 'WORKER_EXITED'});
    await pool.cleaned();
    const records = new TempJournal(journal).read();
    assert.equal(records.length, 1, 'unknown replacement remains recorded for manual handling');
    assert.equal(fs.readFileSync(records[0].path, 'utf8'), 'another writer');
    const recovered = new TempJournal(journal).recover();
    assert.deepEqual(recovered.removed, []);
    assert.deepEqual(recovered.pending, [records[0].path]);
    assert.equal(fs.readFileSync(records[0].path, 'utf8'), 'another writer');
  } finally { await pool.close(); }
});

test('legacy path-only worker cleanup records are preserved instead of deleting unverifiable files', t => {
  const {dir} = fixture(t), journal = path.join(dir, 'temps.json'), temp = path.join(dir, 'legacy.tmp');
  fs.writeFileSync(temp, 'unknown owner'); fs.writeFileSync(journal, JSON.stringify({items: [{path: temp}]}));
  assert.deepEqual(new TempJournal(journal).recover(), {removed: [], pending: [temp]});
  assert.equal(fs.readFileSync(temp, 'utf8'), 'unknown owner');
});

test('thumbnail and graph-package writers reject replaced reserved paths before writing', async t => {
  const {dir} = fixture(t), src = path.join(dir, 'source.png'), script = path.join(dir, 'replace-before-write.cjs');
  await require('sharp')({create: {width: 8, height: 8, channels: 3, background: '#123456'}}).png().toFile(src);
  fs.writeFileSync(script, `const fs = require('node:fs'); const port = require('node:worker_threads').parentPort; const original = port.on.bind(port); port.on = (event, listener) => original(event, event === 'message' ? m => { fs.renameSync(m.args.tmp, m.args.tmp + '.reserved'); fs.writeFileSync(m.args.tmp, 'another writer'); listener(m); } : listener); require(${JSON.stringify(WORKER)});`);
  const journal = path.join(dir, 'temps.json'), pool = new WorkerPool({size: 1, script, journalFile: journal});
  try {
    await assert.rejects(pool.run('thumbnail', {src, tmp: path.join(dir, 'thumb.tmp'), size: 8}), {code: 'SOURCE_CHANGED'});
    await pool.cleaned();
    await assert.rejects(pool.run('packBuild', {target: path.join(dir, 'package.json'), title: 'test', graph: {nodes: []}, relations: []}), {code: 'SOURCE_CHANGED'});
    await pool.cleaned();
    const records = new TempJournal(journal).read();
    assert.equal(records.length, 2);
    for (const r of records) assert.equal(fs.readFileSync(r.path, 'utf8'), 'another writer');
    assert.ok(!fs.existsSync(path.join(dir, 'package.json')));
  } finally { await pool.close(); }
});

async function localThumbnailFixture(t, afterRender = () => {}) {
  const {dir, db} = fixture(t), src = path.join(dir, 'local.png'), thumbsDir = path.join(dir, 'thumbs');
  const sharp = require('sharp');
  await sharp({create: {width: 8, height: 8, channels: 3, background: '#123456'}}).png().toFile(src);
  const injected = (...args) => {
    const image = sharp(...args), toBuffer = image.toBuffer.bind(image), toFile = image.toFile.bind(image);
    image.toBuffer = async (...a) => { const result = await toBuffer(...a); afterRender(); return result; };
    image.toFile = async (...a) => { const result = await toFile(...a); afterRender(); return result; };
    return image;
  };
  const {AssetIndex} = require('../desktop/services/asset-index.cjs');
  const index = new AssetIndex({db, roots: [{id: 'test', path: dir}], thumbsDir, sharp: injected});
  return {src, thumbsDir, index, row: index.indexFile(src)};
}

test('local thumbnail generation removes its owned temporary file when the source changes', async t => {
  const setup = await localThumbnailFixture(t, () => fs.appendFileSync(setup.src, 'changed'));
  await assert.rejects(setup.index.thumbnail(setup.row.id), {code: 'CONFLICT'});
  assert.deepEqual(fs.readdirSync(setup.thumbsDir, {recursive: true}).filter(n => /\.(tmp|webp)$/.test(n)), []);
});

test('local thumbnail generation removes its owned temporary file when publication fails', async t => {
  const setup = await localThumbnailFixture(t), rename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (String(src).startsWith(setup.thumbsDir) && String(src).endsWith('.tmp')) throw Object.assign(new Error('simulated publication failure'), {code: 'EACCES'});
    return rename(src, dest);
  };
  try { await assert.rejects(setup.index.thumbnail(setup.row.id), {code: 'EACCES'}); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readdirSync(setup.thumbsDir, {recursive: true}).filter(n => /\.(tmp|webp)$/.test(n)), []);
});

test('local thumbnail generation preserves a replacement temporary path without publishing it', async t => {
  let replaced;
  const setup = await localThumbnailFixture(t, () => {
    replaced = path.join(setup.thumbsDir, fs.readdirSync(setup.thumbsDir, {recursive: true}).find(n => n.endsWith('.tmp')));
    fs.renameSync(replaced, `${replaced}.original`);
    fs.writeFileSync(replaced, 'another writer');
  });
  await assert.rejects(setup.index.thumbnail(setup.row.id), {code: 'SOURCE_CHANGED'});
  assert.equal(fs.readFileSync(replaced, 'utf8'), 'another writer');
  assert.ok(!fs.readdirSync(setup.thumbsDir, {recursive: true}).some(n => n.endsWith('.webp')));
});
