'use strict';
// R15/D14：206 续传必须核对来源身份；无可靠身份或身份变化时从零重下，不得拼接新旧内容。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {Database} = require('../desktop/repositories/database.cjs');
const {DownloadManager, resumeValidator} = require('../desktop/services/online/downloader.cjs');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
// 可编程假来源：handler(req) → {status, headers, body}
function fakeFetch(handler, log) {
  return async (_url, {headers}) => { log.push({...headers}); const r = handler(headers); return new Response(r.body ?? null, {status: r.status, headers: r.headers}); };
}
function setup(t, handler, {etag = null, lastModified = null, partBytes, totalBytes = null, expectedHash = null} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-dlr-'));
  const db = Database.open(path.join(dir, 'y.sqlite'));
  t.after(() => { try { db.close(); } catch { /* 已关闭 */ } fs.rmSync(dir, {recursive: true, force: true}); });
  const log = [];
  const m = new DownloadManager({db, resolve: async () => ({url: 'http://x/f'}), fetchImpl: fakeFetch(handler, log), sleep: async () => {}});
  const dest = path.join(dir, 'f.bin'), at = new Date().toISOString();
  fs.writeFileSync(`${dest}.part`, partBytes);
  db.run('INSERT INTO downloads (id, source, file_id, url_ref, destination, temp_path, expected_hash, hash_kind, total_bytes, received_bytes, state, etag, last_modified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'dl_t', 'url', 'f', '{}', dest, `${dest}.part`, expectedHash, expectedHash ? 'sha256' : null, totalBytes, partBytes.length, 'queued', etag, lastModified, at, at);
  return {m, dest, log};
}
const until = async (m, id) => { for (let i = 0; i < 2000; i++) { const d = m.get(id); if (['completed', 'failed'].includes(d.state) && !m.running.has(id)) return d; await new Promise(r => setTimeout(r, 5)); } throw new Error('超时'); };
const range = (buf, from, etag) => ({status: 206, headers: {etag, 'content-range': `bytes ${from}-${buf.length - 1}/${buf.length}`, 'content-length': String(buf.length - from)}, body: buf.subarray(from)});
const full = (buf, etag) => ({status: 200, headers: {etag, 'content-length': String(buf.length)}, body: buf});

test('R15：资源函数——弱 ETag 不作续传依据，回退 Last-Modified，否则不可续传', () => {
  assert.equal(resumeValidator({etag: '"a"'}), '"a"');
  assert.equal(resumeValidator({etag: 'W/"a"', lastModified: 'Mon'}), 'Mon');
  assert.equal(resumeValidator({etag: 'W/"a"'}), null);
  assert.equal(resumeValidator({}), null);
});

test('R15：旧 .part 无来源身份 → 不发 Range，从零重下（无 expectedHash 也不拼接）', async t => {
  const oldBody = Buffer.alloc(1000, 1), newBody = Buffer.alloc(2000, 2);
  const {m, dest, log} = setup(t, h => h.range ? range(newBody, 1000, '"n"') : full(newBody, '"n"'), {partBytes: oldBody});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed', JSON.stringify(d.error));
  assert.equal(log[0].range, undefined);
  assert.equal(sha(fs.readFileSync(dest)), sha(newBody));
});

test('R15：206 但 ETag 已变化（等大小新源）→ 清除 .part 重下，结果为完整新文件', async t => {
  const oldBody = Buffer.alloc(2000, 1), newBody = Buffer.alloc(2000, 2);
  // 错误来源：忽略 If-Range，始终对 Range 返回 206（新 ETag）
  const {m, dest, log} = setup(t, h => h.range ? range(newBody, Number(/=(\d+)/.exec(h.range)[1]), '"new"') : full(newBody, '"new"'), {etag: '"old"', partBytes: oldBody.subarray(0, 1000), totalBytes: 2000});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed', JSON.stringify(d.error));
  assert.equal(log[0].range, 'bytes=1000-'); assert.equal(log[0]['if-range'], '"old"');
  assert.equal(log[1].range, undefined);
  assert.equal(sha(fs.readFileSync(dest)), sha(newBody));
});

test('R15：206 总大小与计划不符 / Content-Range 结尾不完整 → 不追加', async t => {
  const body = Buffer.alloc(2000, 3);
  let n = 0;
  const {m, dest, log} = setup(t, h => {
    if (h.range && n++ === 0) return {status: 206, headers: {etag: '"e"', 'content-range': 'bytes 1000-1499/2000'}, body: body.subarray(1000, 1500)};
    return full(body, '"e"');
  }, {etag: '"e"', partBytes: Buffer.alloc(1000, 9), totalBytes: 2000});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed', JSON.stringify(d.error));
  assert.equal(log.length, 2); assert.equal(log[1].range, undefined);
  assert.equal(sha(fs.readFileSync(dest)), sha(body));
});

test('R15：同一来源（强 ETag 一致）正常续传', async t => {
  const body = crypto.randomBytes(3000);
  const {m, dest, log} = setup(t, h => h.range && h['if-range'] === '"s"' ? range(body, 1200, '"s"') : full(body, '"s"'), {etag: '"s"', partBytes: body.subarray(0, 1200), totalBytes: 3000, expectedHash: sha(body)});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed', JSON.stringify(d.error));
  assert.equal(log.length, 1); assert.equal(log[0].range, 'bytes=1200-');
  assert.equal(sha(fs.readFileSync(dest)), sha(body));
});

test('R15：只有 Last-Modified 时以其作 If-Range，206 返回不同 Last-Modified → 重下', async t => {
  const body = Buffer.alloc(1500, 5);
  const {m, dest, log} = setup(t, h => h.range ? {...range(body, 500, undefined), headers: {'last-modified': 'Tue, 02 Jan 2024 00:00:00 GMT', 'content-range': 'bytes 500-1499/1500'}} : {status: 200, headers: {'last-modified': 'Tue, 02 Jan 2024 00:00:00 GMT'}, body},
    {lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT', partBytes: Buffer.alloc(500, 7)});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed', JSON.stringify(d.error));
  assert.equal(log[0]['if-range'], 'Mon, 01 Jan 2024 00:00:00 GMT');
  assert.equal(sha(fs.readFileSync(dest)), sha(body));
});

test('R15：416 清除 .part 后会重试从零下载（不再直接失败）', async t => {
  const body = Buffer.alloc(800, 4);
  const {m, dest, log} = setup(t, h => h.range ? {status: 416, headers: {}} : full(body, '"q"'), {etag: '"q"', partBytes: Buffer.alloc(900, 1)});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed', JSON.stringify(d.error));
  assert.equal(log.length, 2);
  assert.equal(sha(fs.readFileSync(dest)), sha(body));
});

test('续传：弱 ETag 回退到相同 Last-Modified 时可以续传，不强制整文件重下', async t => {
  const body = Buffer.from('original whole content'), modified = 'Mon, 01 Jan 2024 00:00:00 GMT';
  const {m, dest, log} = setup(t, h => h.range
    ? {status: 206, headers: {etag: 'W/"weak"', 'last-modified': modified, 'content-range': `bytes 4-${body.length - 1}/${body.length}`}, body: body.subarray(4)}
    : {...full(body, 'W/"weak"'), headers: {'last-modified': modified}},
  {etag: 'W/"weak"', lastModified: modified, partBytes: body.subarray(0, 4), totalBytes: body.length});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed'); assert.equal(log.length, 1);
  assert.equal(log[0]['if-range'], modified); assert.deepEqual(fs.readFileSync(dest), body);
});

test('续传：206 缺少用于续传的 Last-Modified 时不拼接旧内容', async t => {
  const body = Buffer.from('new full contents');
  const {m, dest, log} = setup(t, h => h.range
    ? {status: 206, headers: {'content-range': `bytes 4-${body.length - 1}/${body.length}`}, body: body.subarray(4)}
    : full(body, '"new"'),
  {lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT', partBytes: Buffer.from('OLD!'), totalBytes: body.length});
  m.pump(); const d = await until(m, 'dl_t');
  assert.equal(d.state, 'completed'); assert.equal(log.length, 2);
  assert.equal(log[1].range, undefined); assert.deepEqual(fs.readFileSync(dest), body);
});
