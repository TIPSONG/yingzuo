'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {TaskRepository, SnapshotStore} = require('../desktop/repositories/task-repo.cjs');
const {QueueService} = require('../desktop/services/queue-service.cjs');
const {Mutex} = require('../desktop/core/locks.cjs');
const {planBatch} = require('../shared/batch-plan.cjs');

const snapshot = text => ({apiPrompt: {1: {class_type: 'CLIPTextEncode', inputs: {text}}}});
const completed = () => ({outputs: {2: {images: [{filename: 'done.png', subfolder: '', type: 'output'}]}}, status: {status_str: 'success', completed: true, messages: [['execution_success', {}]]}});
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-queue-followup-'));
  const db = Database.open(path.join(dir, 'tasks.sqlite'));
  const snapshots = new SnapshotStore(path.join(dir, 'task-snapshots'));
  const tasks = new TaskRepository(db, snapshots);
  const history = {}, submissions = [], pending = [];
  const client = {
    queue: async () => ({queue_running: [], queue_pending: pending.map(id => [0, id, {}, {}, []])}),
    history: async id => id ? history[id] ? {[id]: history[id]} : {} : history,
    submit: async ({promptId}) => { submissions.push(promptId); history[promptId] = completed(); return {prompt_id: promptId}; },
    deleteQueued: async ids => { for (const id of ids) pending.splice(pending.indexOf(id), 1); },
  };
  const queue = new QueueService({tasks, client: () => client, gpuLock: new Mutex('GPU'), clientId: 'test', sleep: () => new Promise(r => setImmediate(r))});
  t.after(() => { queue.stop(); db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const settle = async () => { for (let i = 0; i < 1000 && queue.pumping; i++) await new Promise(r => setImmediate(r)); };
  return {dir, db, tasks, snapshots, client, history, submissions, pending, queue, settle};
}

test('batch bounds are checked before allocating count-sized seed arrays', () => {
  let result;
  assert.doesNotThrow(() => { result = planBatch({count: Number.MAX_SAFE_INTEGER}, {}, {max: 100}); });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /超过上限/.test(e.message)));
});

test('missing or corrupt queued snapshot fails that task and allows the next task to run', async t => {
  const s = setup(t); s.queue.pause();
  const bad = s.queue.enqueue({workflowId: 'w', snapshot: snapshot('bad')});
  const good = s.queue.enqueue({workflowId: 'w', snapshot: snapshot('good')});
  const file = path.join(s.dir, ...bad.snapshotRef.split('/'));
  fs.writeFileSync(file, '{broken');
  s.queue.resume(); await s.settle();
  assert.equal(s.tasks.get(bad.id).state, 'failed');
  assert.ok(s.tasks.get(bad.id).error.message);
  assert.equal(s.tasks.get(good.id).state, 'succeeded');
  assert.deepEqual(s.submissions, [good.requestId]);
});

test('startup pause and resume cover every queued task beyond a repository page', async t => {
  const s = setup(t); s.queue.stop();
  for (let i = 0; i < 1003; i++) s.tasks.create({workflowId: 'w', snapshot: snapshot('same'), clientId: 'test'});
  await s.queue.recoverOnStartup();
  assert.equal(s.db.get("SELECT count(*) n FROM tasks WHERE state = 'queued'").n, 0);
  assert.equal(s.db.get("SELECT count(*) n FROM tasks WHERE state = 'paused'").n, 1003);
  s.queue.resume();
  assert.equal(s.db.get("SELECT count(*) n FROM tasks WHERE state = 'paused'").n, 0);
  assert.equal(s.db.get("SELECT count(*) n FROM tasks WHERE state = 'queued'").n, 1003);
});

test('pending cancellation preserves a completed history result when execution wins the delete race', async t => {
  const s = setup(t); s.queue.stop();
  const task = s.tasks.create({workflowId: 'w', snapshot: snapshot('race'), clientId: 'test'});
  s.tasks.transition(task.id, 'preparing'); s.tasks.transition(task.id, 'submitting');
  s.tasks.transition(task.id, 'submitted', {patch: {comfyPromptId: task.requestId}});
  s.pending.push(task.requestId);
  s.client.deleteQueued = async () => { s.pending.length = 0; s.history[task.requestId] = completed(); };
  const result = await s.queue.cancel(task.id);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.outputs[0].filename, 'done.png');
});
