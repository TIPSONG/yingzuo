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
