'use strict';
// R17：worker 执行层——hash 正确、主线程保持响应、取消、排队、上限、未知任务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {WorkerPool, WORKER} = require('../desktop/core/worker-pool.cjs');

test('R17：sha256 在 worker 中计算，主线程计时器在此期间持续运行', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-wp-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const f = path.join(dir, 'm.bin'), data = crypto.randomBytes(48 << 20); fs.writeFileSync(f, data);
  const pool = new WorkerPool(); t.after(() => pool.close());
  let ticks = 0; const iv = setInterval(() => ticks++, 5);
  const progress = [];
  const r = await pool.run('sha256', {file: f}, {onProgress: p => progress.push(p)});
  clearInterval(iv);
  assert.equal(r.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.ok(progress.at(-1).done === data.length);
  assert.ok(ticks > 0, 'IPC/主线程应在 hash 期间可响应');
});

test('R17：取消正在运行与排队中的任务；并发受限', async t => {
  const pool = new WorkerPool({size: 1}); t.after(() => pool.close());
  const a = new AbortController(), b = new AbortController();
  const p1 = pool.run('sleep', {ms: 5000}, {signal: a.signal}), p2 = pool.run('sleep', {ms: 5000}, {signal: b.signal});
  assert.equal(pool.active.size, 1); assert.equal(pool.waiting.length, 1);
  b.abort(); a.abort();
  await assert.rejects(p1, {code: 'CANCELLED'}); await assert.rejects(p2, {code: 'CANCELLED'});
  assert.deepEqual(await pool.run('sleep', {ms: 1}), {slept: 1});
});

test('R17：图片大小上限、未知任务、缺失文件均以错误返回', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-wp-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const f = path.join(dir, 'big.png'); fs.writeFileSync(f, Buffer.alloc(2048));
  const pool = new WorkerPool(); t.after(() => pool.close());
  await assert.rejects(pool.run('imageProbe', {file: f, maxBytes: 1024}), {code: 'TOO_LARGE'});
  assert.equal((await pool.run('imageProbe', {file: f, headBytes: 16})).size, 2048);
  await assert.rejects(pool.run('nope', {}), {code: 'UNKNOWN_TASK'});
  await assert.rejects(pool.run('sha256', {file: path.join(dir, 'missing')}), {code: 'ENOENT'});
  assert.ok(fs.existsSync(WORKER));
});

test('S09：worker 内读取图片元数据（只回传小结果）、由 sharp 生成缩略图、流式复制', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-wp2-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const sharp = require('sharp'); const png = path.join(dir, '图.png');
  await sharp({create: {width: 20, height: 10, channels: 3, background: '#123456'}}).png().toFile(png);
  const pool = new WorkerPool({size: 2}); t.after(() => pool.close());
  const m = await pool.run('imageMeta', {file: png});
  assert.deepEqual([m.format, m.metadata.dimensions.width, m.metadata.dimensions.height], ['png', 20, 10]);
  assert.ok(!Buffer.isBuffer(m.head));
  const big = await pool.run('imageMeta', {file: png, maxBytes: 10});
  assert.match(big.metadata.readError, /超过读取上限/);
  const tmp = path.join(dir, 't.webp'); await pool.run('thumbnail', {src: png, tmp, size: 8});
  const meta = await sharp(tmp).metadata(); assert.equal(meta.format, 'webp'); assert.ok(meta.width <= 8);
  const dest = path.join(dir, 'copy.png'); await pool.run('copyFile', {src: png, dest});
  assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(png));
  await assert.rejects(pool.run('copyFile', {src: png, dest}), e => e.code === 'EEXIST');
  await assert.rejects(pool.run('thumbnail', {src: path.join(dir, 'none.png'), tmp: path.join(dir, 'x.webp'), size: 8}));
});
test('S09：AssetIndex 经 worker 扫描与生成缩略图；同一缓存键并发请求去重；源变化后丢弃结果', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-wp3-')); 
  const {Database} = require('../desktop/repositories/database.cjs');
  const {AssetIndex} = require('../desktop/services/asset-index.cjs');
  const db = Database.open(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const out = path.join(dir, 'out'); fs.mkdirSync(out);
  const sharp = require('sharp');
  for (let i = 0; i < 3; i++) await sharp({create: {width: 16, height: 16, channels: 3, background: '#808080'}}).png().toFile(path.join(out, `${i}.png`));
  const runs = []; const real = new WorkerPool({size: 2}); t.after(() => real.close());
  const pool = {run: (k, a, o) => { runs.push(k); return real.run(k, a, o); }};
  const idx = new AssetIndex({db, roots: [{id: 'o', path: out}], thumbsDir: path.join(dir, 'thumbs'), sharp: null, pool});
  const s = await idx.scan(); assert.equal(s.indexed, 3);
  assert.equal(runs.filter(k => k === 'imageMeta').length, 3, '元数据在 worker 中读取');
  const item = idx.list().items[0]; assert.equal(item.width, 16);
  const [a, b] = await Promise.all([idx.thumbnail(item.id), idx.thumbnail(item.id)]);
  assert.equal(a.path, b.path); assert.equal(runs.filter(k => k === 'thumbnail').length, 1, '并发去重');
  assert.equal((await idx.thumbnail(item.id)).cached, true);
  // 源变化：缓存键失效；生成期间变化则丢弃
  const other = idx.list().items[1];
  const slow = {run: async (k, a, o) => { const r = await real.run(k, a, o); if (k === 'thumbnail') fs.appendFileSync(path.join(out, path.basename(other.path)), 'x'); return r; }};
  idx.pool = slow;
  await assert.rejects(idx.thumbnail(other.id), e => e.code === 'CONFLICT');
  assert.ok(!fs.readdirSync(path.join(dir, 'thumbs'), {recursive: true}).some(n => String(n).endsWith('.tmp')), '不留临时文件');
});

/* ---------- C08：关闭生命周期 ---------- */
test('C08：close 期间与之后拒绝新任务；排队与运行中的任务都终态；重复 close 共用同一 Promise；活动 worker 归零', async () => {
  const pool = new WorkerPool({size: 1});
  const p1 = pool.run('sleep', {ms: 5000}), p2 = pool.run('sleep', {ms: 5000});
  await new Promise(r => setTimeout(r, 30));
  const c1 = pool.close(), c2 = pool.close();
  assert.equal(c1, c2);
  await assert.rejects(pool.run('sleep', {ms: 1}), {code: 'CLOSED'}, 'closing 时不接受新任务');
  await assert.rejects(p1, {code: 'CANCELLED'}); await assert.rejects(p2, {code: 'CANCELLED'});
  await c1;
  assert.equal(pool.state, 'closed'); assert.equal(pool.activeCount, 0); assert.equal(pool.waiting.length, 0);
  await assert.rejects(pool.run('sleep', {ms: 1}), {code: 'CLOSED'});
});
test('C08：取消后清理 AbortSignal 监听；被终止任务的登记临时文件被清理', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-wp4-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const pool = new WorkerPool({size: 1}); t.after(() => pool.close());
  const tmpf = path.join(dir, 'partial.tmp'); fs.writeFileSync(tmpf, 'x');
  const ac = new AbortController(); let added = 0, removed = 0;
  const sig = ac.signal, add = sig.addEventListener.bind(sig), rem = sig.removeEventListener.bind(sig);
  sig.addEventListener = (...a) => { added++; return add(...a); }; sig.removeEventListener = (...a) => { removed++; return rem(...a); };
  const p = pool.run('sleep', {ms: 5000}, {signal: sig, temps: [tmpf]});
  await new Promise(r => setTimeout(r, 30)); ac.abort();
  await assert.rejects(p, {code: 'CANCELLED'}); await pool.cleaned(); // RV10：清理发生在 worker 真实退出之后
  assert.equal(added, removed, '监听已移除'); assert.ok(!fs.existsSync(tmpf), '临时文件已清理');
  const ok = await pool.run('sleep', {ms: 1}, {signal: new AbortController().signal}); assert.deepEqual(ok, {slept: 1});
  assert.equal(pool.activeCount, 0);
});
test('C08：worker 崩溃以错误终态返回，池继续可用', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-wp5-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const script = path.join(dir, 'crash.cjs'); fs.writeFileSync(script, "require('node:worker_threads').parentPort.on('message', () => process.exit(3));");
  const pool = new WorkerPool({size: 1, script}); t.after(() => pool.close());
  await assert.rejects(pool.run('x', {}), {code: 'WORKER_EXITED'});
  await assert.rejects(pool.run('x', {}), {code: 'WORKER_EXITED'});
  assert.equal(pool.activeCount, 0);
});
