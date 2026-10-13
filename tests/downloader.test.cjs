'use strict';
// O05/O06：下载器——使用本机 HTTP 服务（支持 Range/If-Range/ETag）测试续传、源变化、校验、取消、恢复。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {Database} = require('../desktop/repositories/database.cjs');
const {DownloadManager} = require('../desktop/services/online/downloader.cjs');

function server(t, state) {
  const srv = http.createServer((req, res) => {
    state.requests.push({range: req.headers.range, ifRange: req.headers['if-range'], auth: req.headers.authorization});
    if (state.status) { res.writeHead(state.status); return res.end(); }
    const body = state.body, etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const throttle = state.slow;
    const send = (buf, headers, code) => { res.writeHead(code, {etag, 'accept-ranges': 'bytes', 'content-length': buf.length, ...headers}); if (!throttle) return res.end(buf); let i = 0; const tick = () => { if (i >= buf.length || res.destroyed) return res.end(); res.write(buf.subarray(i, i + 1024)); i += 1024; setTimeout(tick, 5); }; tick(); };
    if (m && (!req.headers['if-range'] || req.headers['if-range'] === etag)) { const start = Number(m[1]); return send(body.subarray(start), {'content-range': `bytes ${start}-${body.length - 1}/${body.length}`}, 206); }
    send(body, {}, 200);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => { t.after(() => srv.close()); r(`http://127.0.0.1:${srv.address().port}/f.bin`); }));
}
function setup(t, url, extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-dl-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const db = Database.open(path.join(d, 'y.sqlite')); t.after(() => db.close());
  const resolveCalls = [];
  const m = new DownloadManager({db, resolve: async ref => { resolveCalls.push(ref); return {url, headers: {authorization: 'Bearer secret-token'}}; }, sleep: async () => {}, ...extra});
  return {d, db, m, resolveCalls};
}
const until = async (m, id, states) => { for (let i = 0; i < 2000; i++) { const s = m.get(id).state; if (states.includes(s) && !m.running.has(id)) return m.get(id); await new Promise(r => setTimeout(r, 5)); } throw new Error(`超时：${m.get(id).state}`); };
const body = n => crypto.randomBytes(n);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

test('O05：流式下载、sha256 校验、原子完成；令牌不写入数据库', async t => {
  const st = {body: body(300000), requests: []}; const url = await server(t, st);
  const {d, db, m} = setup(t, url);
  const dest = path.join(d, 'models', 'a.gguf');
  const dl = m.add({source: 'url', fileId: 'a', urlRef: {provider: 'url', url}, destination: dest, expectedHash: sha(st.body)});
  const done = await until(m, dl.id, ['completed', 'failed']);
  assert.equal(done.state, 'completed', JSON.stringify(done.error)); assert.equal(sha(fs.readFileSync(dest)), sha(st.body));
  assert.ok(!fs.existsSync(`${dest}.part`));
  assert.ok(!JSON.stringify(db.all('SELECT * FROM downloads')).includes('secret-token'));
  assert.throws(() => m.add({source: 'url', fileId: 'a', urlRef: {}, destination: dest}), /已存在/);
});
test('O05/O06：暂停后续传（Range + If-Range），哈希覆盖整个文件', async t => {
  const st = {body: body(400000), requests: [], slow: true}; const url = await server(t, st);
  const {d, m} = setup(t, url);
  const dest = path.join(d, 'b.bin');
  const dl = m.add({source: 'url', fileId: 'b', urlRef: {url}, destination: dest, expectedHash: sha(st.body)});
  for (let i = 0; i < 400 && !(fs.existsSync(`${dest}.part`) && fs.statSync(`${dest}.part`).size > 20000); i++) await new Promise(r => setTimeout(r, 5));
  m.pause(dl.id);
  const p = await until(m, dl.id, ['paused']);
  assert.ok(p.receivedBytes > 0 && p.receivedBytes < st.body.length);
  st.slow = false;
  m.resume(dl.id);
  const done = await until(m, dl.id, ['completed', 'failed']);
  assert.equal(done.state, 'completed', JSON.stringify(done.error));
  const last = st.requests.at(-1); assert.match(last.range, /^bytes=\d+-$/); assert.ok(last.ifRange);
  assert.equal(sha(fs.readFileSync(dest)), sha(st.body));
});
test('O06：源文件变化（ETag 不同）时从头下载；重启恢复为暂停并按 .part 大小续传', async t => {
  const st = {body: body(50000), requests: []}; const url = await server(t, st);
  const {d, db, m} = setup(t, url);
  const dest = path.join(d, 'c.bin');
  fs.writeFileSync(`${dest}.part`, st.body.subarray(0, 1000));
  const id = 'dl_x';
  db.run(`INSERT INTO downloads (id, source, file_id, url_ref, destination, temp_path, etag, received_bytes, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, 'url', 'c', JSON.stringify({url}), dest, `${dest}.part`, '"old-etag"', 0, 'downloading', 'x', 'x');
  const rec = m.recoverOnStartup();
  assert.equal(rec[0].state, 'paused'); assert.equal(rec[0].receivedBytes, 1000);
  st.body = body(60000); // 源已更新
  m.resume(id);
  const done = await until(m, id, ['completed', 'failed']);
  assert.equal(done.state, 'completed'); assert.equal(st.requests.at(-1).ifRange, '"old-etag"');
  assert.equal(sha(fs.readFileSync(dest)), sha(st.body), '没有把旧片段拼到新文件上');
});
test('O05：hash 不符失败并删除临时文件；403 不重试；取消删除临时文件；并发受限', async t => {
  const st = {body: body(20000), requests: []}; const url = await server(t, st);
  const {d, m} = setup(t, url, {concurrency: 1});
  const bad = m.add({source: 'url', fileId: 'x', urlRef: {url}, destination: path.join(d, 'x.bin'), expectedHash: 'a'.repeat(64)});
  const second = m.add({source: 'url', fileId: 'y', urlRef: {url}, destination: path.join(d, 'y.bin')});
  assert.equal(m.running.size, 1, '并发 1');
  const f = await until(m, bad.id, ['failed']);
  assert.match(f.error.message, /sha256/); assert.ok(!fs.existsSync(path.join(d, 'x.bin.part')));
  assert.equal((await until(m, second.id, ['completed'])).verification.matchedExpected, false);
  st.status = 403; const before = st.requests.length;
  const forb = m.add({source: 'url', fileId: 'z', urlRef: {url}, destination: path.join(d, 'z.bin')});
  const ff = await until(m, forb.id, ['failed']);
  assert.match(ff.error.message, /凭据|许可/); assert.equal(st.requests.length - before, 1, '授权错误不重试');
  st.status = null; st.slow = true;
  const c = m.add({source: 'url', fileId: 'w', urlRef: {url}, destination: path.join(d, 'w.bin')});
  await new Promise(r => setTimeout(r, 30)); m.cancel(c.id);
  assert.equal((await until(m, c.id, ['cancelled'])).state, 'cancelled'); assert.ok(!fs.existsSync(path.join(d, 'w.bin.part')));
});
