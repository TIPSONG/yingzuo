'use strict';
// O05/O06：通用下载器。流式写入 .part、Range 续传（If-Range 校验源未变）、受控并发、取消、退避重试、
// 大小与 sha256 校验、原子改名完成。任务记录只保存 provider 引用（urlRef），每次开始前重新解析下载地址，
// 不把签名 URL 或账号令牌写进数据库。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {Readable, Transform} = require('node:stream');
const {AppError, CODES} = require('../../core/errors.cjs');
const {CancelToken} = require('../../core/locks.cjs');

const row = r => r && {id: r.id, source: r.source, fileId: r.file_id, urlRef: JSON.parse(r.url_ref), destination: r.destination, tempPath: r.temp_path, etag: r.etag, lastModified: r.last_modified, expectedHash: r.expected_hash, hashKind: r.hash_kind, totalBytes: r.total_bytes, receivedBytes: r.received_bytes, state: r.state, error: r.error ? JSON.parse(r.error) : null, verification: r.verification ? JSON.parse(r.verification) : null, createdAt: r.created_at, updatedAt: r.updated_at};
const ACTIVE = ['queued', 'downloading', 'verifying'];

async function hashFile(file, bytes) {
  const h = crypto.createHash('sha256');
  if (!bytes) return h;
  await pipeline(fs.createReadStream(file, {start: 0, end: bytes - 1}), new Transform({transform(c, _e, cb) { h.update(c); cb(); }}));
  return h;
}

class DownloadManager {
  /**
   * resolve(urlRef) → {url, headers}：由 provider 解析（可带临时授权头，不持久化）。
   */
  constructor({db, resolve, events, logger, fetchImpl = fetch, concurrency = 2, maxRetries = 3, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => new Date().toISOString()}) {
    Object.assign(this, {db, resolve, events, logger, fetchImpl, concurrency, maxRetries, sleep, now});
    this.tokens = new Map(); this.running = new Set();
  }
  get(id) { return row(this.db.get('SELECT * FROM downloads WHERE id = ?', id)); }
  list() { return this.db.all('SELECT * FROM downloads ORDER BY created_at DESC LIMIT 500').map(row); }
  _update(id, patch) {
    const cols = {state: 'state', receivedBytes: 'received_bytes', totalBytes: 'total_bytes', etag: 'etag', lastModified: 'last_modified', error: 'error', verification: 'verification'};
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${cols[k]} = ?`); vals.push(['error', 'verification'].includes(k) ? (v == null ? null : JSON.stringify(v)) : v); }
    this.db.run(`UPDATE downloads SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, this.now(), id);
    const d = this.get(id); this.events?.emit('downloads.changed', id, d); return d;
  }
  /** 加入下载。destination 必须是已规划（O04）好的绝对路径。 */
  add({source, fileId, urlRef, destination, expectedHash = null, totalBytes = null}) {
    if (!path.isAbsolute(destination)) throw new AppError(CODES.INVALID_PATH, '下载目标必须是绝对路径。');
    if (fs.existsSync(destination)) throw new AppError(CODES.CONFLICT, `目标文件已存在：${destination}`);
    const dup = this.db.get(`SELECT id FROM downloads WHERE destination = ? AND state IN ('queued','downloading','verifying','paused')`, destination);
    if (dup) throw new AppError(CODES.CONFLICT, '同一目标已有进行中的下载。', {details: {id: dup.id}});
    const id = `dl_${crypto.randomUUID()}`, at = this.now();
    this.db.run('INSERT INTO downloads (id, source, file_id, url_ref, destination, temp_path, expected_hash, hash_kind, total_bytes, received_bytes, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)',
      id, source, String(fileId), JSON.stringify(urlRef), destination, `${destination}.part`, expectedHash ? expectedHash.toLowerCase() : null, expectedHash ? 'sha256' : null, totalBytes, 'queued', at, at);
    this.pump();
    return this.get(id);
  }
  pump() {
    for (const d of this.db.all(`SELECT * FROM downloads WHERE state = 'queued' ORDER BY created_at`).map(row)) {
      if (this.running.size >= this.concurrency) break;
      if (this.running.has(d.id)) continue;
      this.running.add(d.id);
      this._run(d.id).catch(e => this.logger?.error('download crashed', {id: d.id, error: e.message})).finally(() => { this.running.delete(d.id); this.tokens.delete(d.id); this.pump(); });
    }
  }
  pause(id) { const d = this.get(id); if (!d) throw new AppError(CODES.NOT_FOUND, '下载不存在。'); if (d.state === 'queued') return this._update(id, {state: 'paused'}); this.tokens.get(id)?.cancel('pause'); return d; }
  resume(id) { const d = this.get(id); if (!['paused', 'failed'].includes(d?.state)) throw new AppError(CODES.INVALID_STATE, '只有暂停或失败的下载可以继续。'); this._update(id, {state: 'queued', error: null}); this.pump(); return this.get(id); }
  cancel(id) {
    const d = this.get(id); if (!d) throw new AppError(CODES.NOT_FOUND, '下载不存在。');
    if (this.running.has(id)) { this.tokens.get(id)?.cancel('cancel'); return d; }
    if (['completed', 'cancelled'].includes(d.state)) return d;
    try { fs.rmSync(d.tempPath, {force: true}); } catch { /* 忽略 */ }
    return this._update(id, {state: 'cancelled'});
  }
  /** O06：启动时把中断的下载置为暂停，核对 .part 实际大小。 */
  recoverOnStartup() {
    for (const d of this.db.all(`SELECT * FROM downloads WHERE state IN ('downloading','verifying','queued')`).map(row)) {
      const size = fs.existsSync(d.tempPath) ? fs.statSync(d.tempPath).size : 0;
      this.db.run('UPDATE downloads SET state = ?, received_bytes = ?, updated_at = ? WHERE id = ?', 'paused', size, this.now(), d.id);
    }
    return this.db.all(`SELECT * FROM downloads WHERE state = 'paused'`).map(row);
  }
  async _run(id) {
    const token = new CancelToken(); this.tokens.set(id, token);
    let attempt = 0;
    for (;;) {
      try { await this._attempt(id, token); return; }
      catch (error) {
        const reason = token.cancelled ? token.reason : null;
        if (reason === 'pause') { const size = fs.existsSync(this.get(id).tempPath) ? fs.statSync(this.get(id).tempPath).size : 0; this._update(id, {state: 'paused', receivedBytes: size}); return; }
        if (reason === 'cancel') { try { fs.rmSync(this.get(id).tempPath, {force: true}); } catch { /* 忽略 */ } this._update(id, {state: 'cancelled'}); return; }
        const retryable = error.retryable !== false && attempt < this.maxRetries;
        this.logger?.warn('download attempt failed', {id, attempt, error: error.message});
        if (!retryable) { this._update(id, {state: 'failed', error: {code: error.code ?? 'DOWNLOAD_FAILED', message: error.message}}); return; }
        attempt++;
        await this.sleep(Math.min(30000, 1000 * 2 ** attempt));
        if (token.cancelled) continue; // 下一轮进入 catch 分支处理
      }
    }
  }
  async _attempt(id, token) {
    if (token.cancelled) throw new Error(token.reason);
    let d = this.get(id);
    d = this._update(id, {state: 'downloading', error: null});
    const {url, headers = {}} = await this.resolve(d.urlRef); // O06：每次重新解析（签名 URL 可能过期）
    let have = fs.existsSync(d.tempPath) ? fs.statSync(d.tempPath).size : 0;
    const req = {...headers};
    if (have > 0) { req.range = `bytes=${have}-`; if (d.etag) req['if-range'] = d.etag; else if (d.lastModified) req['if-range'] = d.lastModified; }
    const controller = new AbortController();
    const off = token.onCancel ? token.onCancel(() => controller.abort()) : null;
    const timer = setInterval(() => { if (token.cancelled) controller.abort(); }, 200);
    try {
      const res = await this.fetchImpl(url, {headers: req, signal: controller.signal, redirect: 'follow'});
      if (res.status === 401 || res.status === 403) throw Object.assign(new AppError(CODES.FORBIDDEN, `来源拒绝访问（HTTP ${res.status}）：可能需要登录凭据或先在网站上同意许可。`), {retryable: false});
      if (res.status === 404) throw Object.assign(new AppError(CODES.NOT_FOUND, '来源文件不存在（HTTP 404）。'), {retryable: false});
      if (res.status === 416) { have = 0; fs.rmSync(d.tempPath, {force: true}); throw new AppError(CODES.CONFLICT, '续传位置无效，已清除临时文件重新下载。'); }
      if (!res.ok) throw new AppError(CODES.SERVICE_UNAVAILABLE, `下载失败：HTTP ${res.status}`);
      const etag = res.headers.get('etag'), lastModified = res.headers.get('last-modified');
      let append = false;
      if (res.status === 206) {
        const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(res.headers.get('content-range') ?? '');
        if (!m || Number(m[1]) !== have) throw new AppError(CODES.CONFLICT, '服务器返回的续传范围不一致。');
        append = true;
        if (m[3] !== '*') this._update(id, {totalBytes: Number(m[3])});
      } else {
        // 200：源已变化（If-Range 不匹配）或不支持 Range → 从头下载
        if (have > 0) this.logger?.info('download restart from 0', {id, reason: d.etag && etag && d.etag !== etag ? 'etag changed' : 'no range'});
        have = 0;
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len) && len > 0) this._update(id, {totalBytes: len});
      }
      if (d.totalBytes && this.get(id).totalBytes && d.totalBytes !== this.get(id).totalBytes) throw Object.assign(new AppError(CODES.CONFLICT, '来源文件大小与计划不一致，已停止。'), {retryable: false});
      this._update(id, {etag, lastModified, receivedBytes: have});
      const hash = await hashFile(d.tempPath, append ? have : 0);
      let received = have, lastEmit = 0;
      const meter = new Transform({transform: (chunk, _e, cb) => {
        hash.update(chunk); received += chunk.length;
        const t = Date.now(); if (t - lastEmit > 500) { lastEmit = t; this.db.run('UPDATE downloads SET received_bytes = ? WHERE id = ?', received, id); this.events?.emit('downloads.progress', id, {receivedBytes: received, totalBytes: this.get(id).totalBytes}); }
        cb(null, chunk);
      }});
      fs.mkdirSync(path.dirname(d.tempPath), {recursive: true});
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(d.tempPath, {flags: append ? 'a' : 'w'}), {signal: controller.signal});
      this._update(id, {state: 'verifying', receivedBytes: received});
      const total = this.get(id).totalBytes;
      if (total && received !== total) throw new AppError(CODES.CONFLICT, `下载大小不符：收到 ${received}，应为 ${total}。`);
      const digest = hash.digest('hex');
      if (d.expectedHash && digest !== d.expectedHash) { fs.rmSync(d.tempPath, {force: true}); throw Object.assign(new AppError(CODES.CORRUPT_DATA, 'sha256 校验失败，文件已删除。'), {retryable: false}); }
      if (fs.existsSync(d.destination)) throw Object.assign(new AppError(CODES.CONFLICT, '目标位置在下载期间出现了同名文件，未覆盖。临时文件已保留。'), {retryable: false});
      fs.renameSync(d.tempPath, d.destination);
      this._update(id, {state: 'completed', verification: {sha256: digest, matchedExpected: !!d.expectedHash, bytes: received}});
    } finally { clearInterval(timer); off?.(); }
  }
}
module.exports = {DownloadManager, ACTIVE};
