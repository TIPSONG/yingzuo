'use strict';
// RV06：停止 ComfyUI / 释放显存走统一环境保护：环境锁、暂停提交、等待 starting、锁内核实归属与后端队列；退出时同样核对。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
const {createApi} = require('../desktop/services/api.cjs');

function mk(t, opt = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv06-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const layout = ensureLayout(d);
  const calls = [];
  const state = {owned: opt.owned ?? true, queue: opt.queue ?? {queue_running: [], queue_pending: []}, ours: new Set(opt.ours ?? []), active: [], startingUntil: null};
  const comfy = {verifyOwned: async () => (typeof state.owned === 'function' ? state.owned() : state.owned), stop: async () => { calls.push('stop'); return {stopped: true}; }, freeMemory: async () => { calls.push('free'); return {ok: true}; }, logTail: () => []};
  const leases = [];
  const hooks = {activeTasks: () => state.active, waitForIdle: async ({timeoutMs}) => { if (state.startingUntil) await state.startingUntil; }, pauseSubmissions: n => { leases.push(`+${n}`); return () => leases.push(`-${n}`); }, resumeSubmissions() {}, cancelActive: async () => {}};
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname === '/queue') { if (opt.queueDelay) await opt.queueDelay(); if (state.queue === 'error') return new Response('x', {status: 500}); return new Response(JSON.stringify(state.queue)); }
    throw new Error('offline');
  };
  const locks = createLocks();
  const api = createApi({electron: {safeStorage: {isEncryptionAvailable: () => false}, shell: {}, dialog: {}}, app: {getVersion: () => '0'}, layout, dataRoot: {root: d, mode: 'test'}, configRepo: {config: {comfy: {url: 'http://127.0.0.1:8188/', root: ''}, lmstudio: {url: 'http://127.0.0.1:1/v1', cli: ''}}, snapshot: () => ({}), derived: () => ({})}, logger: {info() {}, warn() {}, error() {}, tail: () => []}, events: {emit() {}}, locks, editor: {connected: false, disconnectEditor() {}}, migration: null, getWindow: () => null, fetch: fetchImpl, root: d, comfy, taskService: {hooks, tasks: {byPromptId: id => (state.ours.has(id) ? {id} : null)}}});
  return {api, calls, state, leases, locks};
}

test('RV06：owned 后端只有外部任务——停止与释放显存都拒绝，未调用 stop/free；租约与锁释放', async t => {
  const {api, calls, leases, locks} = mk(t, {queue: {queue_running: [[0, 'foreign-1']], queue_pending: []}});
  await assert.rejects(api.methods['services.stopComfy'](), /其他来源/);
  await assert.rejects(api.methods['services.freeComfyMemory'](), /其他来源/);
  assert.deepEqual(calls, []);
  assert.deepEqual(leases, ['+stop-comfy', '-stop-comfy', '+free-comfy-memory', '-free-comfy-memory']);
  assert.equal(locks.environment.locked, false);
});
test('RV06：后端队列无法确认（HTTP 500）——拒绝', async t => {
  const {api, calls} = mk(t, {queue: 'error'});
  await assert.rejects(api.methods['services.stopComfy'](), /无法确认/);
  assert.deepEqual(calls, []);
});
test('RV06：任务正在启动（starting）期间——等待后再在锁内核对；启动超出等待则拒绝', async t => {
  const {api, calls, state} = mk(t);
  let done; state.startingUntil = new Promise(r => { done = r; });
  const p = api.methods['services.stopComfy']();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(calls, [], '等待期间未停止');
  state.queue = {queue_running: [[0, 'ours-1']], queue_pending: []}; state.ours.add('ours-1'); // 启动完成的是本应用任务
  state.active = [{id: 'ours'}];
  done();
  await assert.rejects(p, /本应用任务/);
  assert.deepEqual(calls, []);
});
test('RV06：等待锁/延迟查询期间服务身份改变——锁内重新核实后拒绝停止', async t => {
  let n = 0;
  const {api, calls, state} = mk(t, {queueDelay: async () => { await new Promise(r => setTimeout(r, 5)); }});
  state.owned = () => (++n > 0 ? false : true); // 进入保护后核实为非本应用实例
  await assert.rejects(api.methods['services.stopComfy'](), e => e.code === 'NOT_OWNED');
  assert.deepEqual(calls, []);
});
test('RV06：环境锁被维护占用时不停止、不释放', async t => {
  const {api, calls, locks} = mk(t);
  const rel = locks.environment.tryAcquire('maintenance:x');
  await assert.rejects(api.methods['services.stopComfy'](), e => e.code === 'LOCKED');
  await assert.rejects(api.methods['services.freeComfyMemory'](), e => e.code === 'LOCKED');
  rel(); assert.deepEqual(calls, []);
});
test('RV06：外部实例释放显存需显式确认；空闲本应用实例可停止', async t => {
  const ext = mk(t, {owned: false});
  await assert.rejects(ext.api.methods['services.freeComfyMemory'](), e => e.details?.needsConfirm);
  await assert.rejects(ext.api.methods['services.stopComfy'](), e => e.code === 'NOT_OWNED');
  assert.deepEqual(ext.calls, []);
  await ext.api.methods['services.freeComfyMemory']({confirmExternal: true});
  assert.deepEqual(ext.calls, ['free']);
  const own = mk(t);
  await own.api.methods['services.stopComfy']();
  assert.deepEqual(own.calls, ['stop']);
});
test('RV06：退出时 owned 服务中有其他来源任务或无法确认——不停止', async t => {
  const a = mk(t, {queue: {queue_running: [[0, 'foreign']], queue_pending: []}});
  await a.api.shutdownOwnedServices(); assert.deepEqual(a.calls, []);
  const b = mk(t, {queue: 'error'});
  await b.api.shutdownOwnedServices(); assert.deepEqual(b.calls, []);
  const c = mk(t);
  await c.api.shutdownOwnedServices(); assert.deepEqual(c.calls, ['stop']);
});
