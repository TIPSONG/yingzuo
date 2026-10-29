'use strict';
// RV10：worker 临时文件由主进程分配并登记；worker 真实退出后清理；失败保留可恢复记录；关闭期间不再创建新池。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wp = require('../desktop/core/worker-pool.cjs');
const {WorkerPool, TempJournal} = wp;

const mk = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv10-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const big = (d, mb = 64) => { const f = path.join(d, 'big.bin'); const fd = fs.openSync(f, 'w'); const buf = Buffer.alloc(1 << 20, 7); for (let i = 0; i < mb; i++) fs.writeSync(fd, buf); fs.closeSync(fd); return f; };
const leftovers = d => fs.readdirSync(d).filter(n => /\.yz-(copy|pack)-/.test(n));

test('RV10：真实 copyFile 复制中取消——登记的 .yz-copy 临时文件在 worker 退出后被清理，登记清空，目标未生成', async t => {
  const d = mk(t), journal = path.join(d, 'j', 'temps.json');
  const pool = new WorkerPool({size: 1, journalFile: journal}); t.after(() => pool.close());
  const src = big(d, 256), dest = path.join(d, 'out.bin'), ac = new AbortController();
  const p = pool.run('copyFile', {src, dest}, {signal: ac.signal, onProgress: () => {}});
  for (let i = 0; i < 200 && !fs.existsSync(journal); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(new TempJournal(journal).read().length, 1, '启动 worker 前已登记');
  assert.match(new TempJournal(journal).read()[0].path, /out\.bin\.yz-copy-/);
  await new Promise(r => setTimeout(r, 30)); ac.abort();
  await assert.rejects(p, {code: 'CANCELLED'});
  await pool.cleaned();
  assert.deepEqual(leftovers(d), []); assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(new TempJournal(journal).read(), []);
});
test('RV10：成功复制后登记移除、目标保留；close 中途终止的复制同样清理', async t => {
  const d = mk(t), journal = path.join(d, 'temps.json');
  const pool = new WorkerPool({size: 1, journalFile: journal});
  const small = path.join(d, 's.txt'); fs.writeFileSync(small, 'hi');
  await pool.run('copyFile', {src: small, dest: path.join(d, 's2.txt')}); await pool.cleaned();
  assert.equal(fs.readFileSync(path.join(d, 's2.txt'), 'utf8'), 'hi');
  assert.deepEqual(new TempJournal(journal).read(), []);
  const p = pool.run('copyFile', {src: big(d, 256), dest: path.join(d, 'o2.bin')});
  const rej = assert.rejects(p, {code: 'CANCELLED'});
  await new Promise(r => setTimeout(r, 40));
  await pool.close(); await rej;
  assert.deepEqual(leftovers(d), []); assert.equal(fs.existsSync(path.join(d, 'o2.bin')), false);
});
test('RV10：worker 崩溃后清理登记临时文件；删除失败的条目保留，下次启动 recover 只清理登记路径', async t => {
  const d = mk(t), journal = path.join(d, 'temps.json');
  const script = path.join(d, 'crash.cjs');
  fs.writeFileSync(script, "const fs=require('node:fs');require('node:worker_threads').parentPort.on('message', m => { fs.writeFileSync(m.args.tmp, 'partial'); process.exit(3); });");
  const pool = new WorkerPool({size: 1, script, journalFile: journal}); t.after(() => pool.close());
  await assert.rejects(pool.run('copyFile', {src: 'x', dest: path.join(d, 'c.bin')}), {code: 'WORKER_EXITED'});
  await pool.cleaned();
  assert.deepEqual(leftovers(d), []);
  // 上次运行遗留的登记（进程被强杀）：只删登记的路径，不按宽泛名称删除
  const stray = path.join(d, 'other.yz-copy-1-1'); fs.writeFileSync(stray, 'not ours');
  const ours = path.join(d, 'm.bin.yz-copy-9-9'); fs.writeFileSync(ours, 'ours');
  new TempJournal(journal).add([ours]);
  const r = wp.configureShared({journalFile: journal});
  assert.deepEqual(r.removed, [ours]); assert.equal(fs.existsSync(ours), false); assert.equal(fs.existsSync(stray), true);
});
test('RV10：图包写入使用主进程登记的临时名；共享池关闭期间/之后晚到调用得到 CLOSED，不新建池', async t => {
  const d = mk(t), journal = path.join(d, 'temps.json');
  wp.configureShared({journalFile: journal});
  const pool = wp.sharedPool();
  const target = path.join(d, 'pkg.yzpack');
  await pool.run('packBuild', {target, title: 't', graph: {nodes: []}, relations: [], exportedGraph: null, refill: [], template: null}).catch(() => {});
  await pool.cleaned();
  assert.deepEqual(leftovers(d), []); assert.deepEqual(new TempJournal(journal).read(), []);
  const closing = wp.closeShared();
  assert.equal(wp.sharedPool(), pool, '关闭中仍返回同一池');
  await assert.rejects(wp.sharedPool().run('sleep', {ms: 1}), {code: 'CLOSED'});
  await closing;
  await assert.rejects(wp.sharedPool().run('sleep', {ms: 1}), {code: 'CLOSED'});
  const fresh = wp.reopenShared(); t.after(() => fresh.close());
  assert.notEqual(fresh, pool); assert.deepEqual(await fresh.run('sleep', {ms: 1}), {slept: 1});
});
