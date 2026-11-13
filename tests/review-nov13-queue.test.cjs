'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {Database} = require('../desktop/repositories/database.cjs');
const {TaskRepository, SnapshotStore} = require('../desktop/repositories/task-repo.cjs');
const {QueueService} = require('../desktop/services/queue-service.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {ConfigRepository} = require('../desktop/repositories/config-repo.cjs');
const {createApi} = require('../desktop/services/api.cjs');
const snapshot = {apiPrompt: {1: {class_type: 'Test', inputs: {}}}};
const success = () => ({outputs: {9: {images: [{filename: 'done.png', type: 'output'}]}}, status: {status_str: 'success', completed: true}});
const tick = () => new Promise(r => setImmediate(r));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-nov13-queue-')), layout = ensureLayout(dir);
  const db = Database.open(layout.database), locks = createLocks();
  const tasks = new TaskRepository(db, new SnapshotStore(layout['task-snapshots']));
  const pending = [], history = {}, terminals = [];
  const client = {queue: async () => ({queue_running: pending.map(id => [0, id, {}, {}, []]), queue_pending: []}), history: async id => id ? history[id] ? {[id]: history[id]} : {} : history};
  const queue = new QueueService({tasks, client: () => client, gpuLock: locks.gpu, onTerminal: t => terminals.push(t.id), sleep: tick});
  const create = (state = 'unknown') => {
    const task = tasks.create({workflowId: 'w', snapshot, clientId: 'test'});
    if (state === 'paused') tasks.transition(task.id, 'paused');
    else if (state !== 'queued') {
      tasks.transition(task.id, 'preparing'); tasks.transition(task.id, 'submitting');
      tasks.transition(task.id, 'submitted', {patch: {comfyPromptId: task.requestId}});
      if (state === 'unknown') { tasks.transition(task.id, 'reconciling'); tasks.transition(task.id, 'unknown'); }
    }
    return task;
  };
  t.after(async () => { queue.stop(); pending.length = 0; for (const task of tasks.list()) history[task.requestId] = success(); for (let i = 0; i < 100 && (queue.followers.size || queue.pumping); i++) await tick(); db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {dir, layout, db, locks, tasks, queue, create, pending, history, terminals};
}
test('rechecking an unknown running job resumes polling even while user queue is paused', async t => {
  const s = fixture(t), job = s.create(); s.queue.pause(); s.pending.push(job.requestId);
  assert.equal((await s.queue.recheck(job.id)).state, 'running');
  const idle = s.queue.waitForIdle({timeoutMs: 500});
  s.pending.length = 0; s.history[job.requestId] = success();
  await idle;
  assert.equal(s.tasks.get(job.id).state, 'succeeded');
  assert.deepEqual(s.terminals, [job.id]);
  assert.equal(s.queue.paused, true);
});
test('direct recheck and startup history recovery deliver terminal side effects exactly once', async t => {
  const s = fixture(t), rechecked = s.create(), startup = s.create('submitted');
  s.queue.pause();
  s.history[rechecked.requestId] = success(); s.history[startup.requestId] = success();
  await s.queue.recheck(rechecked.id); await s.queue.recoverOnStartup();
  assert.deepEqual(s.terminals.slice().sort(), [rechecked.id, startup.id].sort());
  await s.queue.follow(rechecked.id); await s.queue.follow(startup.id);
  assert.deepEqual(s.terminals.sort(), [rechecked.id, startup.id].sort());
});
function apiFixture(t) {
  const s = fixture(t);
  const configRepo = new ConfigRepository(path.join(s.dir, 'config.json'), {platform: 'linux'}); configRepo.load();
  const events = [], selected = path.join(s.dir, 'selected'); fs.mkdirSync(selected);
  let waits = 0;
  const api = createApi({electron: {safeStorage: {isEncryptionAvailable: () => false}, shell: {}, dialog: {showOpenDialog: async () => ({canceled: false, filePaths: [selected]})}}, app: {getVersion: () => 'test'}, layout: s.layout, dataRoot: {root: s.dir, mode: 'test'}, configRepo, logger: {info() {}, warn() {}, error() {}, tail: () => []}, events: {emit: (...args) => events.push(args)}, locks: s.locks, editor: {connected: false}, migration: null, getWindow: () => null, fetch: async () => { throw new Error('No network in fixture'); }, root: s.dir,
    taskService: {tasks: s.tasks, hooks: {activeTasks: () => s.queue.activeTasks(), pauseSubmissions: r => s.queue.acquirePause(r), waitForIdle: async o => { waits++; await s.queue.waitForIdle(o); }}}});
  s.queue.stop();
  return {...s, api, configRepo, events, selected, waits: () => waits};
}
test('ComfyUI settings cannot redirect outstanding tasks; unrelated preferences still save', async t => {
  const s = apiFixture(t);
  for (const state of ['queued', 'paused', 'unknown', 'submitted']) {
    const task = s.create(state), old = s.configRepo.config.comfy.url;
    await assert.rejects(s.api.methods['settings.update']({comfy: {url: 'http://127.0.0.1:8190/'}}), e => e.code === 'INVALID_STATE');
    assert.equal(s.configRepo.config.comfy.url, old);
    await s.api.methods['settings.update']({comfy: {...s.configRepo.config.comfy}, ui: {theme: 'light'}});
    assert.equal(s.configRepo.config.ui.theme, 'light');
    s.tasks.transition(task.id, 'cancelled');
  }
  await s.api.methods['settings.update']({comfy: {url: 'http://127.0.0.1:8190/'}});
  assert.equal(s.configRepo.config.comfy.url, 'http://127.0.0.1:8190/');
  assert.equal(s.locks.environment.locked, false); assert.equal(s.queue.leases.size, 0);
});
test('path picker and direct settings share environment lock and starting admission protection', async t => {
  const s = apiFixture(t), old = s.configRepo.config.comfy.root;
  const release = s.locks.environment.tryAcquire('maintenance');
  await assert.rejects(s.api.methods['settings.pickPath']('comfy.root'), e => e.code === 'LOCKED');
  assert.equal(s.configRepo.config.comfy.root, old); release();
  s.queue.starting = 1;
  const change = s.api.methods['settings.update']({comfy: {url: 'http://127.0.0.1:8190/'}});
  await tick(); assert.equal(s.configRepo.config.comfy.url, 'http://127.0.0.1:8188/');
  const job = s.create('queued'); s.queue.starting = 0; s.queue.settleIdle();
  await assert.rejects(change, e => e.code === 'INVALID_STATE');
  s.tasks.transition(job.id, 'cancelled');
  await s.api.methods['settings.pickPath']('comfy.root');
  assert.equal(s.configRepo.config.comfy.root, s.selected);
  assert.ok(s.events.some(e => e[0] === 'settings.changed'));
  assert.equal(s.locks.environment.locked, false); assert.equal(s.queue.leases.size, 0);
});
test('queue retry and global cancellation ask confirmation before the backend operation', async () => {
  const nodes = new Map(), errors = [], calls = [], answers = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, {addEventListener(type, fn) { this[type] = fn; }, classList: {toggle() {}}}); return nodes.get(selector); };
  const methods = {list: async () => ({tasks: [], queue: {}}), cancel: async (id, options) => { calls.push(['cancel', id, options?.globalInterrupt ?? false]); if (!options?.globalInterrupt) throw Object.assign(new Error('unsupported'), {details: {needsGlobalInterrupt: true}}); }, retry: async (id, options) => calls.push(['retry', id, options?.confirmDuplicate])};
  const context = {window: {yingzuo: {tasks: methods, events: {subscribe() {}}}, yzShell: {esc: s => String(s ?? ''), toast() {}, call: async p => p, swallow: e => errors.push(e.message), modal: async () => { calls.push(['confirmation']); return answers.shift(); }}}, document: {querySelector: node, addEventListener() {}}, setInterval() {}, setTimeout() {}, clearTimeout() {}, current: {activeId: 'tab', connected: true}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../desktop/ui/tasks.js'), 'utf8'), context);
  const click = (selector, dataset) => nodes.get('#queue-list').click({target: {closest: s => s === selector ? {dataset} : null}});
  answers.push(false); await click('[data-retry]', {retry: 'unknown', unknown: '1'});
  answers.push(true); await click('[data-retry]', {retry: 'unknown', unknown: '1'});
  answers.push(false); await click('[data-cancel]', {cancel: 'running'});
  answers.push(true); await click('[data-cancel]', {cancel: 'running'});
  assert.deepEqual(errors, []);
  assert.deepEqual(calls.filter(c => c[0] === 'retry'), [['retry', 'unknown', true]]);
  assert.deepEqual(calls.filter(c => c[0] === 'cancel'), [['cancel', 'running', false], ['cancel', 'running', false], ['cancel', 'running', true]]);
  assert.equal(calls.filter(c => c[0] === 'confirmation').length, 4);
});
