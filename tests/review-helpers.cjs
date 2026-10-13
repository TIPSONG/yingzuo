'use strict';
// d5cca17 审阅回归共用：tasks.* 替身环境（编辑器与 ComfyUI 为替身，HTTP 走真实 ComfyHttpClient + 假 fetch）。
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
  7: {class_type: 'KSampler', inputs: {seed: 1, steps: 20, sampler_name: 'euler', positive: ['4', 0], negative: ['4', 0], latent_image: ['6', 0]}},
  12: {class_type: 'SaveImage', inputs: {images: ['7', 0], filename_prefix: 'ComfyUI'}},
});
const info = {LMStudioPromptEnhancer: {input: {required: {}}, output: ['STRING']}, CLIPTextEncode: {input: {required: {}}, output: ['C']}, EmptySD3LatentImage: {input: {required: {}}, output: ['L']}, KSampler: {input: {required: {}}, output: ['L']}, SaveImage: {input: {required: {}}, output: [], output_node: true}, PreviewAny: {input: {required: {}}, output: [], output_node: true}};

function setup(t, extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv-'));
  const layout = ensureLayout(d);
  const db = Database.open(layout.database);
  t.after(() => { try { db.close(); } catch { /* 已关闭 */ } fs.rmSync(d, {recursive: true, force: true}); });
  const submitted = [], history = {};
  const json = v => new Response(JSON.stringify(v), {status: 200, headers: {'content-type': 'application/json'}});
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/object_info') return json(info);
    if (u.pathname === '/queue') return json({queue_running: [], queue_pending: []});
    if (u.pathname === '/prompt') { const body = JSON.parse(init.body); submitted.push(body); history[body.prompt_id] = {prompt: [0, body.prompt_id, body.prompt, body.extra_data], outputs: {12: {images: [{filename: 'a.png', type: 'output'}]}}, status: {completed: true, status_str: 'success'}}; return json({prompt_id: body.prompt_id, number: 1, node_errors: {}}); }
    if (u.pathname.startsWith('/history/')) { const id = decodeURIComponent(u.pathname.slice(9)); return json(history[id] ? {[id]: history[id]} : {}); }
    return new Response('', {status: 404});
  };
  const editor = {enqueue: f => f(), workspace: {tabs: [{id: 'tab1', revision: 3}, {id: 'tab2', revision: 1}]}, commands: {compileTab: async id => ({tabId: id ?? 'tab1', title: 'T', revision: 3, uiGraph: {nodes: []}, apiPrompt: prompt()})}};
  const configRepo = {config: {comfy: {url: 'http://127.0.0.1:8188'}, gemma: {contextLength: 8192, maxReferenceImages: 2}, queue: {maxBatch: 100}, output: {prefixMode: 'none'}}};
  Object.assign(configRepo.config, extra.config ?? {});
  const svc = createTaskService({graphPolicy: extra.graphPolicy ?? null, credentials: extra.credentials ?? null, db, layout, configRepo, events: new EventBus(), locks: createLocks(), editor, fetchImpl, WebSocketImpl: null});
  svc.queue.pollMs = 1; svc.queue.sleep = () => new Promise(r => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 300 && (svc.queue.pumping || svc.queue.running); i++) await new Promise(r => setTimeout(r, 1)); };
  return {svc, submitted, settle, editor, db, layout, configRepo, dir: d};
}
const safeStorage = () => ({isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: s => Buffer.from(`enc:${s}`), decryptString: b => b.toString().slice(4)});
function grep(dir, needle) {
  const hits = [];
  const walk = d => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (fs.readFileSync(p).includes(needle)) hits.push(p); } };
  walk(dir); return hits;
}
module.exports = {setup, prompt, info, safeStorage, grep};
