'use strict';
// Q01：任务持久化。不可变快照（UI 图 + API prompt + 参数 + 素材引用）内容寻址保存在 task-snapshots/；
// 数据库只存快照引用、hash、状态。每次状态转移都写 task_events。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {writeFileAtomic, sha256} = require('../core/fs-atomic.cjs');
const {assertTransition, TERMINAL_STATES} = require('../../shared/schema.cjs');
const {AppError, CODES} = require('../core/errors.cjs');

class SnapshotStore {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, {recursive: true}); }
  /** 写入快照，返回 {ref, hash}；相同内容复用同一文件。 */
  put(snapshot) {
    const body = JSON.stringify(snapshot);
    const hash = sha256(body);
    const ref = `task-snapshots/${hash.slice(0, 2)}/${hash}.json`;
    const file = path.join(this.dir, hash.slice(0, 2), `${hash}.json`);
    if (!fs.existsSync(file)) writeFileAtomic(file, body);
    return {ref, hash};
  }
  get(ref, expectedHash) {
    if (!/^task-snapshots\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/.test(ref)) throw new AppError(CODES.INVALID_ARGUMENT, '快照引用无效。');
    const file = path.join(this.dir, ...ref.split('/').slice(1));
    const body = fs.readFileSync(file, 'utf8');
    const hash = sha256(body);
    if (expectedHash && hash !== expectedHash) throw new AppError(CODES.INTEGRITY, '任务快照校验失败，文件可能被修改。');
    return JSON.parse(body);
  }
}
const parse = (v, fallback) => { if (v == null) return fallback; try { return JSON.parse(v); } catch { return fallback; } };
function rowToTask(r) {
  if (!r) return null;
  return {id: r.id, kind: r.kind, state: r.state, workflowId: r.workflow_id, snapshotRef: r.snapshot_ref, snapshotHash: r.snapshot_hash, inputRevision: r.input_revision, requestId: r.request_id, comfyPromptId: r.comfy_prompt_id, clientId: r.client_id, groupId: r.group_id, retryOf: r.retry_of, seq: r.seq, outputs: parse(r.outputs, []), error: parse(r.error, null), progress: parse(r.progress, null), external: !!r.external, timestamps: {createdAt: r.created_at, updatedAt: r.updated_at, submittedAt: r.submitted_at, finishedAt: r.finished_at}};
}
class TaskRepository {
  constructor(db, snapshots, {now = () => new Date().toISOString(), events} = {}) { this.db = db; this.snapshots = snapshots; this.now = now; this.events = events; }
  /** 创建任务：先持久化快照，再插入记录（state 默认 queued）。 */
  create({kind = 'generate', workflowId, snapshot, inputRevision = 0, clientId, groupId = null, retryOf = null, state = 'queued'}) {
    const {ref, hash} = this.snapshots.put(snapshot);
    const id = crypto.randomUUID(), requestId = crypto.randomUUID(), at = this.now();
    this.db.transaction(() => {
      const seq = (this.db.get('SELECT coalesce(max(seq),0)+1 AS s FROM tasks').s);
      this.db.run(`INSERT INTO tasks(id,kind,state,workflow_id,snapshot_ref,snapshot_hash,input_revision,request_id,client_id,group_id,retry_of,seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, kind, state, workflowId, ref, hash, inputRevision, requestId, clientId, groupId, retryOf, seq, at, at);
      this.db.run('INSERT INTO task_events(task_id,from_state,to_state,reason,at) VALUES(?,?,?,?,?)', id, null, state, retryOf ? `重试自 ${retryOf}` : '创建', at);
    });
    const task = this.get(id);
    this.events?.emit('tasks.changed', id, task);
    return task;
  }
  get(id) { return rowToTask(this.db.get('SELECT * FROM tasks WHERE id = ?', id)); }
  byPromptId(promptId) { return rowToTask(this.db.get('SELECT * FROM tasks WHERE comfy_prompt_id = ?', promptId)); }
  snapshotOf(task) { return this.snapshots.get(task.snapshotRef, task.snapshotHash); }
  /** 状态转移（校验状态机）+ 附加字段 + 事件，单事务。 */
  transition(id, to, {reason = null, data, patch = {}} = {}) {
    let task;
    this.db.transaction(() => {
      const row = this.db.get('SELECT state FROM tasks WHERE id = ?', id);
      if (!row) throw new AppError(CODES.NOT_FOUND, '任务不存在。');
      assertTransition(row.state, to);
      const at = this.now();
      const sets = ['state = ?', 'updated_at = ?'], values = [to, at];
      const map = {comfyPromptId: 'comfy_prompt_id', outputs: 'outputs', error: 'error', progress: 'progress'};
      for (const [k, v] of Object.entries(patch)) { if (!map[k]) throw new AppError(CODES.INVALID_ARGUMENT, `不能修改字段 ${k}`); sets.push(`${map[k]} = ?`); values.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v); }
      if (to === 'submitted') { sets.push('submitted_at = coalesce(submitted_at, ?)'); values.push(at); }
      if (TERMINAL_STATES.includes(to)) { sets.push('finished_at = ?'); values.push(at); }
      this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
      this.db.run('INSERT INTO task_events(task_id,from_state,to_state,reason,data,at) VALUES(?,?,?,?,?,?)', id, row.state, to, reason, data === undefined ? null : JSON.stringify(data), at);
    });
    task = this.get(id);
    this.events?.emit('tasks.changed', id, task);
    return task;
  }
  /** 非状态变化的进度更新（不写 task_events，避免刷屏）。 */
  setProgress(id, progress) { this.db.run('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?', JSON.stringify(progress), this.now(), id); const t = this.get(id); this.events?.emit('tasks.progress', id, {progress}); return t; }
  setPromptId(id, promptId) { this.db.run('UPDATE tasks SET comfy_prompt_id = ?, updated_at = ? WHERE id = ?', promptId, this.now(), id); return this.get(id); }
  list({states, limit = 200, groupId} = {}) {
    const where = [], params = [];
    if (states?.length) { where.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
    if (groupId) { where.push('group_id = ?'); params.push(groupId); }
    return this.db.all(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`, ...params, Math.min(limit, 1000)).map(rowToTask);
  }
  /** FIFO：最早的 queued 任务 */
  nextQueued() { return rowToTask(this.db.get("SELECT * FROM tasks WHERE state = 'queued' ORDER BY seq ASC LIMIT 1")); }
  events_(id) { return this.db.all('SELECT from_state, to_state, reason, data, at FROM task_events WHERE task_id = ? ORDER BY id', id).map(e => ({...e, data: parse(e.data, null)})); }
  lineage(id) { const out = []; let t = this.get(id); while (t) { out.unshift(t.id); t = t.retryOf ? this.get(t.retryOf) : null; if (out.length > 100) break; } return out; }
  /** 用原快照创建重试任务（不读当前表单）。 */
  retry(id) {
    const t = this.get(id);
    if (!t) throw new AppError(CODES.NOT_FOUND, '任务不存在。');
    if (!['failed', 'cancelled', 'unknown'].includes(t.state)) throw new AppError(CODES.INVALID_STATE, '只有失败、已取消或状态未知的任务可以重试。');
    const snapshot = this.snapshotOf(t);
    return this.create({kind: t.kind, workflowId: t.workflowId, snapshot, inputRevision: t.inputRevision, clientId: t.clientId, groupId: t.groupId, retryOf: t.id});
  }
}
module.exports = {TaskRepository, SnapshotStore, rowToTask};
