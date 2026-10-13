'use strict';
// Q01–Q07/Q10：任务仓库与调度器。使用内存中的 ComfyUI 替身（模拟 /queue、/history、/prompt），
// 不是真实 ComfyUI 验收。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {TaskRepository, SnapshotStore} = require('../desktop/repositories/task-repo.cjs');
const {QueueService, expandBatch} = require('../desktop/services/queue-service.cjs');
const {Mutex} = require('../desktop/core/locks.cjs');
const {EventBus} = require('../desktop/core/events.cjs');
const {AppError} = require('../desktop/core/errors.cjs');
const {parseHistoryEntry, parseQueue, nodeErrorList} = require('../desktop/adapters/comfy-http.cjs');

function setup(t, opts = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-q-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const db = Database.open(path.join(d, 'y.sqlite')); t.after(() => db.close());
  const events = new EventBus();
  const tasks = new TaskRepository(db, new SnapshotStore(path.join(d, 'task-snapshots')), {events});
  const fake = new FakeComfy(opts);
  const q = new QueueService({tasks, client: () => fake, gpuLock: new Mutex('GPU'), events, clientId: 'client-1', pollMs: 1, externalWaitMs: 1, sleep: () => new Promise(r => setImmediate(r)), ...opts.queue});
  return {d, db, tasks, fake, q, events};
}
class FakeComfy {
  constructor({acceptClientId = true} = {}) { this.queueRunning = []; this.queuePending = []; this.historyMap = {}; this.submits = []; this.acceptClientId = acceptClientId; this.n = 0; this.interrupts = []; this.deleted = []; this.failSubmit = null; this.autoFinish = 'success'; }
  async queue() { return {queue_running: this.queueRunning.map(x => [x.n, x.id, {}, x.extra, []]), queue_pending: this.queuePending.map(x => [x.n, x.id, {}, x.extra, []])}; }
  async history(id) { if (id) return this.historyMap[id] ? {[id]: this.historyMap[id]} : {}; return this.historyMap; }
  async submit({prompt, clientId, requestId, promptId}) {
    this.submits.push({prompt, requestId});
    const id = this.acceptClientId ? promptId : `srv-${++this.n}`;
    const extra = {client_id: clientId, yingzuo: {requestId}};
    if (this.failSubmit === 'lost-after-accept') { this.historyMap[id] = done(extra, 'success'); throw new AppError('NETWORK', 'socket hang up'); }
    if (this.failSubmit === 'lost-before-accept') throw new AppError('NETWORK', 'ECONNRESET');
    if (this.failSubmit === 'node-errors') throw new AppError('INVALID_ARGUMENT', 'Prompt outputs failed validation', {details: {nodeErrors: {5: {class_type: 'KSampler', errors: [{message: 'Value 0 smaller than min', extra_info: {input_name: 'steps'}}]}}}});
    if (this.autoFinish) this.historyMap[id] = done(extra, this.autoFinish);
    else this.queueRunning.push({n: ++this.n, id, extra});
    return {prompt_id: id, number: this.n, node_errors: {}};
  }
  async deleteQueued(ids) { this.deleted.push(...ids); this.queuePending = this.queuePending.filter(x => !ids.includes(x.id)); }
  async interrupt(id) { this.interrupts.push(id); const r = this.queueRunning.find(x => x.id === id); if (r) { this.queueRunning = this.queueRunning.filter(x => x !== r); this.historyMap[id] = done(r.extra, 'interrupted'); } }
}
function done(extra, kind) {
  const messages = kind === 'error' ? [['execution_error', {node_id: '5', node_type: 'KSampler', exception_message: 'CUDA OOM'}]] : kind === 'interrupted' ? [['execution_interrupted', {}]] : [['execution_success', {}]];
  return {prompt: [1, 'x', {}, extra, []], outputs: kind === 'success' ? {9: {images: [{filename: 'a.png', subfolder: '', type: 'output'}]}, 12: {text: ['润色后的提示词']}} : {}, status: {status_str: kind === 'success' ? 'success' : 'error', completed: kind === 'success', messages}};
}
const snap = (p = 'cat') => ({uiGraph: {nodes: []}, apiPrompt: {1: {class_type: 'CLIPTextEncode', inputs: {text: p}}}, params: {prompt: p}});
const settle = async q => { for (let i = 0; i < 200 && (q.pumping || q.running); i++) await new Promise(r => setImmediate(r)); };

test('Q01：快照内容寻址、不可变、校验；状态转移写事件；非法转移拒绝', t => {
  const {tasks, d} = setup(t);
  const a = tasks.create({workflowId: 'w', snapshot: snap(), clientId: 'c'});
  const b = tasks.create({workflowId: 'w', snapshot: snap(), clientId: 'c'});
  assert.equal(a.snapshotRef, b.snapshotRef, '相同快照复用文件'); assert.ok(b.seq > a.seq);
  assert.deepEqual(tasks.snapshotOf(a).params, {prompt: 'cat'});
  assert.throws(() => tasks.transition(a.id, 'succeeded'), /不能从 queued/);
  tasks.transition(a.id, 'cancelled', {reason: 'x'});
  assert.deepEqual(tasks.events_(a.id).map(e => e.to_state), ['queued', 'cancelled']);
  const file = path.join(d, 'task-snapshots', ...a.snapshotRef.split('/').slice(1));
  fs.writeFileSync(file, JSON.stringify({tampered: true}));
  assert.throws(() => tasks.snapshotOf(a), e => e.code === 'INTEGRITY');
});
test('Q03/Q04/Q05：FIFO 串行提交，history 终态确认，输出含图片与文本', async t => {
  const {q, tasks, fake} = setup(t);
  const a = q.enqueue({workflowId: 'w', snapshot: snap('a'), inputRevision: 1});
  const b = q.enqueue({workflowId: 'w', snapshot: snap('b'), inputRevision: 1});
  await settle(q);
  assert.deepEqual(fake.submits.map(s => s.prompt[1].inputs.text), ['a', 'b']);
  const ta = tasks.get(a.id);
  assert.equal(ta.state, 'succeeded'); assert.equal(ta.comfyPromptId, a.requestId, '服务端采纳客户端 prompt_id');
  assert.deepEqual(ta.outputs.map(o => o.kind).sort(), ['image', 'text']);
  assert.deepEqual(tasks.events_(a.id).map(e => e.to_state), ['queued', 'preparing', 'submitting', 'submitted', 'running', 'succeeded']);
  assert.equal(tasks.get(b.id).state, 'succeeded');
});
test('空图不能运行', t => {
  const {q} = setup(t);
  assert.throws(() => q.enqueue({workflowId: 'w', snapshot: {apiPrompt: {}}}), /空图/);
});
test('Q04：提交响应丢失但后端已执行 → 通过 history 核对为成功，不重发', async t => {
  const {q, tasks, fake} = setup(t); fake.failSubmit = 'lost-after-accept';
  const a = q.enqueue({workflowId: 'w', snapshot: snap()}); await settle(q);
  assert.equal(fake.submits.length, 1, '没有重发');
  assert.equal(tasks.get(a.id).state, 'succeeded');
  assert.ok(tasks.events_(a.id).some(e => e.to_state === 'reconciling'));
});
test('Q04：提交响应丢失且后端没有记录 → unknown，不自动重发；用户可核对或放弃', async t => {
  const {q, tasks, fake} = setup(t, {acceptClientId: false}); fake.failSubmit = 'lost-before-accept';
  const a = q.enqueue({workflowId: 'w', snapshot: snap()}); await settle(q);
  assert.equal(tasks.get(a.id).state, 'unknown'); assert.equal(fake.submits.length, 1);
  fake.failSubmit = null; // 即使后端恢复也不会自动重发
  q.kick(); await settle(q); assert.equal(fake.submits.length, 1);
  assert.equal((await q.recheck(a.id)).state, 'unknown');
  assert.equal((await q.cancel(a.id)).state, 'cancelled');
});
test('老版本服务忽略客户端 prompt_id 时按 extra_data 标记核对', async t => {
  const {q, tasks, fake} = setup(t, {acceptClientId: false}); fake.failSubmit = 'lost-after-accept';
  const a = q.enqueue({workflowId: 'w', snapshot: snap()}); await settle(q);
  const ta = tasks.get(a.id); assert.equal(ta.state, 'succeeded'); assert.match(ta.comfyPromptId, /^srv-/);
});
test('Q05：节点校验错误返回节点级清单；执行错误记录节点', async t => {
  const {q, tasks, fake} = setup(t); fake.failSubmit = 'node-errors';
  const a = q.enqueue({workflowId: 'w', snapshot: snap()}); await settle(q);
  const ta = tasks.get(a.id); assert.equal(ta.state, 'failed'); assert.equal(ta.error.nodeErrors[0].nodeId, '5'); assert.equal(ta.error.nodeErrors[0].input, 'steps');
  fake.failSubmit = null; fake.autoFinish = 'error';
  const b = q.enqueue({workflowId: 'w', snapshot: snap()}); await settle(q);
  assert.equal(tasks.get(b.id).state, 'failed'); assert.equal(tasks.get(b.id).error.nodeType, 'KSampler');
});
test('Q03：外部任务存在时等待，不提交；外部任务结束后继续', async t => {
  const {q, tasks, fake} = setup(t);
  fake.queueRunning.push({n: 1, id: 'native-1', extra: {client_id: 'browser'}});
  let waits = 0; q.sleep = () => { if (++waits === 3) fake.queueRunning = []; return new Promise(r => setImmediate(r)); };
  const a = q.enqueue({workflowId: 'w', snapshot: snap()}); await settle(q);
  assert.ok(waits >= 3); assert.equal(tasks.get(a.id).state, 'succeeded');
});
test('Q07：运行中精确取消；后端运行的不是目标时拒绝取消；排队中的从队列删除', async t => {
  const {q, tasks, fake} = setup(t); fake.autoFinish = null;
  let release; const gate = new Promise(r => { release = r; });
  q.sleep = () => gate.then(() => new Promise(r => setImmediate(r)));
  const a = q.enqueue({workflowId: 'w', snapshot: snap()});
  for (let i = 0; i < 50 && !['submitted','running'].includes(tasks.get(a.id).state); i++) await new Promise(r => setImmediate(r));
  assert.ok(['submitted','running'].includes(tasks.get(a.id).state));
  // 后端运行的是别人
  const mine = fake.queueRunning.pop(); fake.queueRunning.push({n: 9, id: 'other', extra: {}}); fake.queuePending.push(mine);
  // 实际 a 在 pending：应从队列删除
  const r = await q.cancel(a.id); assert.equal(r.state, 'cancelled'); assert.deepEqual(fake.deleted, [a.requestId]);
  fake.queueRunning = []; release(); await settle(q);
  // 运行中取消
  const b = q.enqueue({workflowId: 'w', snapshot: snap()});
  for (let i = 0; i < 50 && !['submitted','running'].includes(tasks.get(b.id).state); i++) await new Promise(r => setImmediate(r));
  await q.cancel(b.id); assert.deepEqual(fake.interrupts, [b.requestId]);
  await settle(q); assert.equal(tasks.get(b.id).state, 'cancelled', '终态来自 history 的 execution_interrupted');
  const other = tasks.create({workflowId: 'w', snapshot: snap(), clientId: 'c'}); tasks.transition(other.id, 'preparing'); tasks.transition(other.id, 'submitting'); tasks.transition(other.id, 'submitted', {patch: {comfyPromptId: 'p-x'}});
  fake.queueRunning = [{n: 1, id: 'p-y', extra: {}}];
  await assert.rejects(q.cancel(other.id), e => e.code === 'INVALID_STATE' && /误中断/.test(e.message));
});
test('Q07：重试使用原快照、记录谱系，不读当前表单', async t => {
  const {q, tasks, fake} = setup(t); fake.autoFinish = 'error';
  const a = q.enqueue({workflowId: 'w', snapshot: snap('原参数')}); await settle(q);
  fake.autoFinish = 'success';
  const r = q.retry(a.id); await settle(q);
  assert.equal(tasks.get(r.id).retryOf, a.id); assert.equal(fake.submits.at(-1).prompt[1].inputs.text, '原参数');
  assert.deepEqual(tasks.lineage(r.id), [a.id, r.id]);
  assert.throws(() => q.retry(r.id), /只有失败/);
});
test('Q10：重启恢复——未提交暂停、已提交核对；暂停与继续保持 FIFO', async t => {
  const {q, tasks, fake} = setup(t);
  const a = tasks.create({workflowId: 'w', snapshot: snap('a'), clientId: 'c'});
  const b = tasks.create({workflowId: 'w', snapshot: snap('b'), clientId: 'c'});
  const s = tasks.create({workflowId: 'w', snapshot: snap('s'), clientId: 'c'});
  tasks.transition(s.id, 'preparing'); tasks.transition(s.id, 'submitting'); tasks.transition(s.id, 'submitted', {patch: {comfyPromptId: 'p-s'}});
  fake.historyMap['p-s'] = done({}, 'success');
  await q.recoverOnStartup();
  assert.equal(tasks.get(a.id).state, 'paused'); assert.equal(tasks.get(b.id).state, 'paused'); assert.equal(tasks.get(s.id).state, 'succeeded');
  assert.equal(q.paused, true); assert.equal(fake.submits.length, 0, '重启后不自动提交');
  q.resume(); await settle(q);
  assert.deepEqual(fake.submits.map(x => x.prompt[1].inputs.text), ['a', 'b']);
});
test('expandBatch：笛卡尔展开与上限', () => {
  assert.equal(expandBatch({prompts: ['a', 'b'], count: 3, seedStart: 10}).length, 6);
  assert.deepEqual(expandBatch({prompts: ['a'], seeds: [1, 2]}).map(x => x.seed), [1, 2]);
  assert.throws(() => expandBatch({prompts: ['a', 'b'], count: 60}, {max: 100}), /超过上限/);
});
test('history / queue / node_errors 解析', () => {
  const e = parseHistoryEntry(done({yingzuo: {requestId: 'r'}}, 'success'));
  assert.equal(e.state, 'succeeded'); assert.equal(e.requestId, 'r');
  assert.equal(parseHistoryEntry(done({}, 'interrupted')).state, 'cancelled');
  assert.equal(parseHistoryEntry({status: {completed: false, messages: []}, outputs: {}}).state, null, '未完成不判成功');
  assert.equal(parseQueue({queue_running: [[1, 'p', {}, {yingzuo: {requestId: 'r'}}]], queue_pending: []}).running[0].requestId, 'r');
  assert.equal(nodeErrorList({3: {class_type: 'X', errors: [{message: 'm'}]}})[0].nodeType, 'X');
});
