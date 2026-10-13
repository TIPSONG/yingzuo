'use strict';
// Q06/Q08/Q10/S07：tasks.* 接口端到端（编辑器与 ComfyUI 均为替身，HTTP 走真实 ComfyHttpClient + 假 fetch）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
const {EventBus} = require('../desktop/core/events.cjs');
const {createTaskService} = require('../desktop/services/task-service.cjs');

const prompt = () => ({
  3: {class_type: 'LMStudioPromptEnhancer', inputs: {prompt: '猫', enable_llm: true}},
  4: {class_type: 'CLIPTextEncode', inputs: {text: ['3', 0]}},
  6: {class_type: 'EmptySD3LatentImage', inputs: {width: 512, height: 512, batch_size: 1}},
  7: {class_type: 'KSampler', inputs: {seed: 1, steps: 20, positive: ['4', 0], negative: ['4', 0], latent_image: ['6', 0]}},
  12: {class_type: 'SaveImage', inputs: {images: ['7', 0]}},
});
const info = {LMStudioPromptEnhancer: {input: {required: {}}, output: ['STRING']}, CLIPTextEncode: {input: {required: {}}, output: ['C']}, EmptySD3LatentImage: {input: {required: {}}, output: ['L']}, KSampler: {input: {required: {}}, output: ['L']}, SaveImage: {input: {required: {}}, output: [], output_node: true}, PreviewAny: {input: {required: {}}, output: [], output_node: true}};

function setup(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ts-')); t.after(() => { try { db.close(); } catch { /* 已关闭 */ } fs.rmSync(d, {recursive: true, force: true}); }); // Windows：先关库再删目录
  const layout = ensureLayout(d);
  const db = Database.open(layout.database);
  const submitted = [], history = {};
  const json = v => new Response(JSON.stringify(v), {status: 200, headers: {'content-type': 'application/json'}});
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/object_info') return json(info);
    if (u.pathname === '/queue') return json({queue_running: [], queue_pending: []});
    if (u.pathname === '/prompt') { const body = JSON.parse(init.body); submitted.push(body); const out = Object.keys(body.prompt).includes('yz_enhance_out') ? {yz_enhance_out: {text: ['润色后：一只橘猫']}} : {12: {images: [{filename: 'a.png', type: 'output'}]}}; history[body.prompt_id] = {prompt: [0, body.prompt_id, body.prompt, body.extra_data], outputs: out, status: {completed: true, status_str: 'success', messages: [['execution_success', {}]]}}; return json({prompt_id: body.prompt_id, number: 1, node_errors: {}}); }
    if (u.pathname.startsWith('/history/')) { const id = decodeURIComponent(u.pathname.slice(9)); return json(history[id] ? {[id]: history[id]} : {}); }
    return new Response('', {status: 404});
  };
  const editor = {enqueue: f => f(), commands: {compileTab: async id => ({tabId: id ?? 'tab1', title: 'T', revision: 3, uiGraph: {nodes: []}, apiPrompt: prompt()})}};
  const configRepo = {config: {comfy: {url: 'http://127.0.0.1:8188'}, gemma: {contextLength: 8192, maxReferenceImages: 2}}};
  const svc = createTaskService({db, layout, configRepo, events: new EventBus(), locks: createLocks(), editor, fetchImpl, WebSocketImpl: null});
  svc.queue.pollMs = 1; svc.queue.sleep = () => new Promise(r => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 300 && (svc.queue.pumping || svc.queue.running); i++) await new Promise(r => setTimeout(r, 1)); };
  return {svc, submitted, settle};
}

test('Q06：运行当前标签——编译、检查、按绑定覆盖参数、入队、history 成功', async t => {
  const {svc, submitted, settle} = setup(t);
  const task = await svc.methods['tasks.run'](null, {values: {seed: 99}});
  await settle();
  assert.equal(svc.tasks.get(task.id).state, 'succeeded');
  assert.equal(submitted[0].prompt[7].inputs.seed, 99);
  assert.equal(submitted[0].prompt[3].inputs.enable_llm, true, '自动润色：执行包含 Gemma 的原图');
  const list = await svc.methods['tasks.list']();
  assert.equal(list.tasks.length, 1);
});
test('Q08：仅润色只提交润色子图；读取文本；采用后再生成时关闭 enable_llm', async t => {
  const {svc, submitted, settle} = setup(t);
  const e = await svc.methods['tasks.enhance'](null, {text: '一只猫在窗边'});
  await settle();
  assert.deepEqual(Object.keys(submitted[0].prompt).sort(), ['3', 'yz_enhance_out']);
  assert.equal(submitted[0].prompt[3].inputs.prompt, '一只猫在窗边');
  const r = await svc.methods['tasks.enhanceResult'](e.id);
  assert.equal(r.text, '润色后：一只橘猫'); assert.equal(r.original, '一只猫在窗边');
  await svc.methods['tasks.run'](null, {adoptedText: r.text}); await settle();
  assert.equal(submitted[1].prompt[3].inputs.prompt, '润色后：一只橘猫'); assert.equal(submitted[1].prompt[3].inputs.enable_llm, false);
});
test('Q10：批量展开为同组任务并按顺序提交', async t => {
  const {svc, submitted, settle} = setup(t);
  assert.equal((await svc.methods['tasks.previewBatch'](null, {prompts: ['a', 'b'], count: 2, seedStart: 10})).count, 4);
  const r = await svc.methods['tasks.runBatch'](null, {prompts: ['a', 'b'], count: 2, seedStart: 10});
  await settle();
  assert.equal(r.tasks.length, 4);
  assert.deepEqual(submitted.map(s => [s.prompt[3].inputs.prompt, s.prompt[7].inputs.seed]), [['a', 10], ['a', 11], ['b', 10], ['b', 11]]);
});
test('S07：退出钩子——暂停后不再提交，等待空闲立即返回', async t => {
  const {svc, submitted, settle} = setup(t);
  svc.hooks.pauseSubmissions();
  await svc.methods['tasks.run'](null, {}); await settle();
  assert.equal(submitted.length, 0);
  assert.deepEqual(svc.hooks.activeTasks(), []);
  await svc.hooks.waitForIdle();
  svc.hooks.resumeSubmissions(); await settle();
  assert.equal(submitted.length, 1);
});
