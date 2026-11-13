'use strict';
// RR05: exercise the same coordinator and API as main, with the actual queue's starting/pause barrier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
const {createApi} = require('../desktop/services/api.cjs');
const {QueueService} = require('../desktop/services/queue-service.cjs');
const {prepareQuit, runQuit} = require('../desktop/services/quit-flow.cjs');
const timeout = () => Object.assign(new Error('timeout'), {code: 'TIMEOUT'});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const tick = () => new Promise(r => setImmediate(r));

function fixture(t, opt = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rr05-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const layout = ensureLayout(dir), locks = createLocks(), events = {emit() {}};
  const record = {id: 'queued', state: 'queued'};
  const tasks = {
    list: () => opt.active ?? [], nextQueued: () => opt.queued ? record : null,
    get: () => record, byPromptId: () => null,
    transition() { assert.fail('paused starting task must not enter preparing'); },
  };
  const queue = new QueueService({tasks, client: () => ({queue: async () => opt.queueDelay ? opt.queueDelay.promise : {queue_running: [], queue_pending: []}}), gpuLock: locks.gpu, events});
  const calls = [], errors = [], holds = new Map(); let nextLease = 0;
  const hooks = opt.useQueue ? {
    activeTasks: () => queue.activeTasks(), waitForIdle: o => queue.waitForIdle(o),
    pauseSubmissions: reason => queue.acquirePause(reason), cancelActive: async () => { throw timeout(); },
  } : {
    activeTasks: () => opt.active ?? [],
    waitForIdle: async args => { calls.push('idle'); if (opt.waitForIdle) await opt.waitForIdle(args); },
    pauseSubmissions: reason => { const id = ++nextLease; holds.set(id, reason); return () => holds.delete(id); },
    cancelActive: async () => { throw timeout(); },
  };
  const editor = {quitting: false, connected: false};
  const comfy = {verifyOwned: async () => true, stop: async () => {
    assert.equal(locks.environment.holder, 'quit-services'); calls.push('stop'); return {stopped: true};
  }, logTail: () => [], ensureRunning: async () => { calls.push('start'); }};
  const fetchImpl = async () => {
    calls.push('backend-queue');
    if (opt.backendDelay) await opt.backendDelay.promise;
    if (opt.queueError) throw new Error('offline');
    return new Response(JSON.stringify(opt.backend ?? {queue_running: [], queue_pending: []}));
  };
  const api = createApi({electron: {safeStorage: {isEncryptionAvailable: () => false}, shell: {}, dialog: {showMessageBox: async () => ({response: opt.answers?.shift() ?? 2})}}, app: {}, layout, dataRoot: {root: dir}, configRepo: {config: {comfy: {url: 'http://127.0.0.1:8188/', root: ''}, lmstudio: {url: 'http://127.0.0.1:1234/v1/', cli: ''}}, snapshot: () => ({}), derived: () => ({})}, logger: {info() {}, warn() {}, error() {}, tail: () => []}, events, locks, editor, getWindow: () => null, fetch: fetchImpl, root: dir, comfy, taskService: {hooks, tasks}});
  const run = overrides => runQuit({api, setQuitting: v => { editor.quitting = v; }, save: async () => { calls.push('save'); }, finalize: async () => {
    assert.equal(locks.environment.holder, 'quit-services');
    assert.ok(opt.useQueue ? queue.leases.size >= 2 : holds.size >= 2, 'quit + shutdown leases remain held through queue stop');
    queue.stop(); calls.push('queue-stop'); calls.push('workers-close'); calls.push('destroy');
  }, onError: (error, phase) => errors.push({error, phase}), ...overrides});
  return {api, run, calls, errors, hooks, holds, locks, editor, queue, record};
}

test('RR05: actual queue active=0/starting=1 during delayed backend query cannot reach save, stop, or destroy', async t => {
  const gate = deferred(); const f = fixture(t, {useQueue: true, queued: true, queueDelay: gate});
  const pumping = f.queue.pump(); await tick();
  assert.equal(f.queue.starting, 1); assert.equal(f.queue.activeTasks().length, 0);
  const quit = f.run(); await tick();
  assert.deepEqual(f.calls, []); assert.deepEqual([...f.queue.leases.values()], ['quit']);
  gate.resolve({queue_running: [], queue_pending: []});
  assert.equal(await quit, true); await pumping;
  assert.equal(f.record.state, 'queued'); assert.equal(f.queue.stopped, true);
  assert.equal(f.queue.leases.size, 0); assert.equal(f.locks.environment.locked, false);
  assert.deepEqual(f.calls, ['save', 'backend-queue', 'stop', 'queue-stop', 'workers-close', 'destroy']);
});

test('RR05: task becoming active while starting is re-evaluated and user can return without releasing another quit lease', async t => {
  const state = {active: [], waitForIdle: async () => { state.active = [{id: 'started'}]; throw timeout(); }, answers: [2]};
  const f = fixture(t, state); const other = f.hooks.pauseSubmissions('quit');
  assert.equal(await f.run(), false);
  assert.equal(f.holds.size, 1); assert.equal([...f.holds.values()][0], 'quit');
  assert.deepEqual(f.calls, ['idle']); assert.equal(f.editor.quitting, false); other();
});

test('RR05: maintenance owns the environment; quit preserves window, worker and queue, retaining maintenance lease', async t => {
  const f = fixture(t); const releaseLock = f.locks.environment.tryAcquire('maintenance:update');
  const releaseLease = f.hooks.pauseSubmissions('maintenance:update');
  assert.equal(await f.run(), false);
  assert.equal(f.errors[0].error.code, 'LOCKED'); assert.equal(f.errors[0].phase, 'shutdown');
  assert.equal(f.locks.environment.holder, 'maintenance:update');
  assert.deepEqual([...f.holds.values()], ['maintenance:update']);
  assert.equal(f.queue.stopped, false); assert.equal(f.editor.quitting, false);
  assert.deepEqual(f.calls, ['idle', 'save']); releaseLease(); releaseLock();
});

test('RR05: save failure releases only this attempt, does not call service shutdown or finalization', async t => {
  const f = fixture(t); const releaseOther = f.hooks.pauseSubmissions('quit');
  assert.equal(await f.run({save: async () => { throw new Error('disk full'); }}), false);
  assert.deepEqual(f.calls, ['idle']); assert.equal(f.errors[0].phase, 'save');
  assert.equal(f.holds.size, 1); assert.equal(f.editor.quitting, false); assert.equal(f.queue.stopped, false); releaseOther();
});

test('RR05: lock and leases persist through delayed shutdown queue check and finalization', async t => {
  const gate = deferred(); const f = fixture(t, {backendDelay: gate});
  const quit = f.run(); await tick();
  assert.equal(f.locks.environment.holder, 'quit-services'); assert.equal(f.holds.size, 2);
  assert.equal(f.locks.environment.tryAcquire('maintenance:race'), null);
  assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.includes('destroy'), false);
  gate.resolve(); assert.equal(await quit, true);
  assert.equal(f.holds.size, 0); assert.equal(f.locks.environment.locked, false);
});

test('RR05: foreign queue and unconfirmed backend remain running on normal app exit', async t => {
  for (const opt of [{backend: {queue_running: [[0, 'external']], queue_pending: []}}, {queueError: true}]) {
    const f = fixture(t, opt);
    assert.equal(await f.run(), true); assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.includes('destroy'), true);
  }
});

test('RR05: explicit force exits only app, preserving unconfirmed active task and backend; maintenance still blocks it', async t => {
  const active = [{id: 't', state: 'submitting'}]; const f = fixture(t, {active, answers: [1, 1]});
  assert.equal(await f.run(), true);
  assert.deepEqual(active, [{id: 't', state: 'submitting'}]);
  assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.includes('backend-queue'), false);
  assert.equal(f.calls.includes('destroy'), true); assert.equal(f.holds.size, 0);
  const g = fixture(t, {active, answers: [1, 1]}); const release = g.locks.environment.tryAcquire('maintenance:restore');
  assert.equal(await g.run(), false); assert.equal(g.errors[0].error.code, 'LOCKED');
  assert.equal(g.calls.includes('destroy'), false); assert.equal(g.queue.stopped, false); release();
});

test('RR05: queued start and API edits cannot restart services or mutate config during finalization', async t => {
  const f = fixture(t); const release = f.locks.environment.tryAcquire('quit-services');
  const start = f.api.methods['services.startComfy'](); f.editor.quitting = true; release();
  await assert.rejects(start, e => e.code === 'INVALID_STATE'); assert.equal(f.calls.includes('start'), false);
  const response = await f.api.dispatch({requestId: 'quit-settings', method: 'settings.update', args: [{queue: {maxBatch: 2}}]});
  assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_STATE');
});

test('RR05: starting timeout explicitly offers return without falsely reporting cancellation', async () => {
  let released = 0, seen;
  const r = await prepareQuit({hooks: {activeTasks: () => [], pauseSubmissions: () => () => { released++; }, waitForIdle: async () => { throw timeout(); }}, showMessageBox: async o => { seen = o; return {response: 2}; }});
  assert.equal(r.decision, 'return'); assert.equal(released, 1);
  assert.match(seen.message, /启动/); assert.doesNotMatch(seen.message, /取消请求已发出/);
});
