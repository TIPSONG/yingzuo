'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {QueueService} = require('../desktop/services/queue-service.cjs');
const {TaskRepository, SnapshotStore} = require('../desktop/repositories/task-repo.cjs');
const {Database} = require('../desktop/repositories/database.cjs');
const {Mutex} = require('../desktop/core/locks.cjs');
const {skip, browserFixture} = require('./browser-helpers.cjs');

test('a second restart preserves paused submissions and FIFO until the user resumes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-queue-restart-'));
  const db = Database.open(path.join(dir, 'queue.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const tasks = new TaskRepository(db, new SnapshotStore(path.join(dir, 'task-snapshots')));
  const sent = [], success = {status: {completed: true, status_str: 'success'}};
  const client = {
    queue: async () => ({queue_running: [], queue_pending: []}),
    submit: async ({promptId}) => { sent.push(promptId); return {prompt_id: promptId}; },
    history: async id => ({[id]: success}),
  };
  const start = () => new QueueService({tasks, clientId: 'app', client: () => client, gpuLock: new Mutex('GPU')});
  const spec = {workflowId: 'w', snapshot: {apiPrompt: {1: {class_type: 'Fixture', inputs: {}}}}, clientId: 'app'};
  const old = tasks.create(spec);
  await start().recoverOnStartup();
  assert.equal(tasks.get(old.id).state, 'paused');
  const restarted = start();
  await restarted.recoverOnStartup();
  assert.equal(restarted.state().paused, true);
  const added = restarted.enqueue(spec);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
  restarted.resume();
  for (let i = 0; restarted.pumping && i < 1000; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarted.pumping, false);
  assert.deepEqual(sent, [old.requestId, added.requestId]);
  assert.equal(tasks.get(added.id).state, 'succeeded');
});

async function editorPage(t) {
  const {page} = await browserFixture(t);
  await page.evaluateOnNewDocument(() => {
    const shellApi = window.yingzuo, desktop = window.yingzuoDesktop;
    const submitted = window.submitted = [], listeners = [];
    const state = {activeId: 'w', connected: true, currentView: 'editor', tabs: [{id: 'w', title: '编辑测试', mode: 'parameters', revision: 1}]};
    let saved = 'Original';
    const snapshot = () => ({graph: {nodes: []}, nodes: [{nodeId: '1', type: 'Text', title: 'Prompt', widgets: [{name: 'text', type: 'customtext', editable: true, value: saved}]}]});
    desktop.boot = async () => ({ok: true, state, snapshot: snapshot(), templates: []});
    desktop.showEditor = desktop.boot;
    desktop.applyParameters = async ([field]) => {
      await new Promise(resolve => { window.finishWrite = resolve; });
      saved = field.value; state.tabs[0].revision++; return {ok: true, state, snapshot: snapshot()};
    };
    const result = data => ({ok: true, data});
    let done = false;
    window.emitProgress = () => {
      for (const notify of listeners) notify({type: 'tasks.progress', resourceId: 'g', data: {progress: {value: 1, max: 20}}});
    };
    window.finishEnhancement = () => {
      done = true;
      for (const notify of listeners) notify({type: 'tasks.changed', resourceId: 'old-job', data: {id: 'old-job', state: 'succeeded'}});
    };
    const tasks = {
      run: async () => { submitted.push(saved); return result({id: 'g'}); },
      preview: async () => result({title: '编辑测试', revision: 1, bindings: {enhancer: {}, prompt: {value: 'Original'}}}),
      enhance: async () => { if (window.finishBeforeEnqueueReply) window.finishEnhancement(); return result({id: 'old-job'}); },
      enhanceResult: async () => result(done ? {state: 'succeeded', text: 'Finished', original: 'Original'} : {state: 'queued'}),
    };
    window.yingzuo = new Proxy(shellApi, {get(base, group) {
      if (group === 'tasks') return new Proxy(base.tasks, {get: (original, name) => tasks[name] ?? original[name]});
      if (group === 'events') return {subscribe: callback => listeners.push(callback)};
      return base[group];
    }});
  });
  await page.reload();
  await page.click('#nav [data-page="create"]');
  await page.waitForSelector('#fields textarea', {visible: true});
  return page;
}
async function shortcut(page, repeat = false) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Enter');
  if (repeat) await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await page.keyboard.up('Control');
}

test('Ctrl+Enter waits for the edited prompt, ignores key repeats and respects new-workflow and modal overlays', {skip}, async t => {
  const page = await editorPage(t);
  await page.click('#fields textarea');
  await page.keyboard.press('End'); await page.keyboard.type(' edited');
  await shortcut(page, true);
  await page.waitForFunction(() => typeof window.finishWrite === 'function');
  assert.deepEqual(await page.evaluate(() => window.submitted), []);
  await page.evaluate(() => window.finishWrite());
  await page.waitForFunction(() => window.submitted.length === 1);
  await page.click('#new-tab'); await shortcut(page); await page.click('#start-close');
  await page.click('#run-enhance'); await page.waitForSelector('#e-in');
  await page.click('#e-in'); await shortcut(page);
  await page.click('.modal [data-x="no"]');
  assert.deepEqual(await page.evaluate(() => window.submitted), ['Original edited']);
  assert.deepEqual(page.captureErrors, []);
});

test('enhance-only result opens for an off-page job, including completion before the enqueue reply', {skip}, async t => {
  const page = await editorPage(t);
  for (const early of [false, true]) {
    if (early) { await page.reload(); await page.click('#nav [data-page="create"]'); }
    await page.evaluate(value => { window.finishBeforeEnqueueReply = value; }, early);
    await page.click('#run-enhance');
    await page.click('.modal [data-x="yes"]');
    if (!early) await page.evaluate(() => window.finishEnhancement());
    await page.waitForSelector('#e-out', {visible: true});
    assert.equal(await page.$eval('#e-out', n => n.value), 'Finished');
    await page.click('.modal [data-x="no"]');
  }
  await page.click('#nav [data-page="queue"]');
  const stamp = await page.$eval('#queue-list .meta', n => n.textContent);
  assert.match(stamp, /2026/);
  assert.deepEqual(page.captureErrors, []);
});

test('queue refreshes while progress events are still arriving', {skip}, async t => {
  const page = await editorPage(t);
  await page.click('#nav [data-page="queue"]');
  await page.waitForSelector('#queue-list .task');
  await page.evaluate(() => {
    window.readCount = () => __yzFixture.completed.filter(c => c === 'tasks.list').length;
    window.initialReads = window.readCount();
    window.progressTimer = setInterval(window.emitProgress, 30);
  });
  try {
    await page.waitForFunction(() => window.readCount() >= window.initialReads + 2, {timeout: 5000});
  } finally { await page.evaluate(() => clearInterval(window.progressTimer)); }
  assert.deepEqual(page.captureErrors, []);
});
