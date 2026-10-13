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
  12: {class_type: 'SaveImage', inputs: {images: ['7', 0], filename_prefix: 'ComfyUI'}},
});
const info = {LMStudioPromptEnhancer: {input: {required: {}}, output: ['STRING']}, CLIPTextEncode: {input: {required: {}}, output: ['C']}, EmptySD3LatentImage: {input: {required: {}}, output: ['L']}, KSampler: {input: {required: {}}, output: ['L']}, SaveImage: {input: {required: {}}, output: [], output_node: true}, PreviewAny: {input: {required: {}}, output: [], output_node: true}};

function setup(t, extra = {}) {
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
  Object.assign(configRepo.config, extra.config ?? {});
  const svc = createTaskService({credentials: extra.credentials ?? null, db, layout, configRepo, events: new EventBus(), locks: createLocks(), editor, fetchImpl, WebSocketImpl: null, onTerminal: extra.onTerminal});
  svc.queue.pollMs = 1; svc.queue.sleep = () => new Promise(r => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 300 && (svc.queue.pumping || svc.queue.running); i++) await new Promise(r => setTimeout(r, 1)); };
  return {svc, submitted, settle, editor, db, layout};
}

test('Q06：运行当前标签——编译、检查、按绑定覆盖参数、入队、history 成功', async t => {
  const {svc, submitted, settle} = setup(t);
  const task = await svc.methods['tasks.run']('tab1', {values: {seed: 99}});
  await settle();
  assert.equal(svc.tasks.get(task.id).state, 'succeeded');
  assert.equal(submitted[0].prompt[7].inputs.seed, 99);
  assert.equal(submitted[0].prompt[3].inputs.enable_llm, true, '自动润色：执行包含 Gemma 的原图');
  const list = await svc.methods['tasks.list']();
  assert.equal(list.tasks.length, 1);
});
test('Q08：仅润色只提交润色子图；读取文本；采用后再生成时关闭 enable_llm', async t => {
  const {svc, submitted, settle} = setup(t);
  const e = await svc.methods['tasks.enhance']('tab1', {text: '一只猫在窗边'});
  await settle();
  assert.deepEqual(Object.keys(submitted[0].prompt).sort(), ['3', 'yz_enhance_out']);
  assert.equal(submitted[0].prompt[3].inputs.prompt, '一只猫在窗边');
  const r = await svc.methods['tasks.enhanceResult'](e.id);
  assert.equal(r.text, '润色后：一只橘猫'); assert.equal(r.original, '一只猫在窗边');
  await svc.methods['tasks.run']('tab1', {adoptedText: r.text}); await settle();
  assert.equal(submitted[1].prompt[3].inputs.prompt, '润色后：一只橘猫'); assert.equal(submitted[1].prompt[3].inputs.enable_llm, false);
});
test('Q10：批量展开为同组任务并按顺序提交', async t => {
  const {svc, submitted, settle} = setup(t);
  assert.equal((await svc.methods['tasks.previewBatch']('tab1', {prompts: ['a', 'b'], count: 2, seedStart: 10})).count, 4);
  const r = await svc.methods['tasks.runBatch']('tab1', {prompts: ['a', 'b'], count: 2, seedStart: 10});
  await settle();
  assert.equal(r.tasks.length, 4);
  assert.deepEqual(submitted.map(s => [s.prompt[3].inputs.prompt, s.prompt[7].inputs.seed]), [['a', 10], ['a', 11], ['b', 10], ['b', 11]]);
});
test('S07：退出钩子——暂停后不再提交，等待空闲立即返回', async t => {
  const {svc, submitted, settle} = setup(t);
  svc.hooks.pauseSubmissions();
  await svc.methods['tasks.run']('tab1', {}); await settle();
  assert.equal(submitted.length, 0);
  assert.deepEqual(svc.hooks.activeTasks(), []);
  await svc.hooks.waitForIdle();
  svc.hooks.resumeSubmissions(); await settle();
  assert.equal(submitted.length, 1);
});

test('A03 输出前缀进入运行路径；A01 成功终态回调作品关联', async t => {
  const linked = [];
  const {svc, submitted, settle} = setup(t, {config: {output: {prefixMode: 'workflow'}}, onTerminal: task => linked.push(task.id)});
  const task = await svc.methods['tasks.run']('tab1', {});
  await settle(); await new Promise(r => setTimeout(r, 5));
  const save = Object.values(submitted[0].prompt).find(n => n.class_type === 'SaveImage');
  assert.match(save.inputs.filename_prefix, /^映作\/T_fp[0-9a-f]{6}\//, 'R20：目录用稳定结构指纹而非 tabId');
  assert.match(svc.tasks.get(task.id).workflowId, /^fp_/);
  assert.deepEqual(linked, [task.id]);
  const none = await svc.methods['tasks.run']('tab1', {prefixMode: 'none'});
  await settle();
  assert.ok(none);
  assert.doesNotMatch(Object.values(submitted[1].prompt).find(n => n.class_type === 'SaveImage').inputs.filename_prefix, /映作/);
});

test('PR11-R09：必须给出发起标签；版本不一致或标签已关闭时拒绝，不回退到当前标签', async t => {
  const {svc, submitted} = setup(t);
  await assert.rejects(svc.methods['tasks.run'](null, {}), /缺少发起任务的标签/);
  await assert.rejects(svc.methods['tasks.run']('tab1', {expectedRevision: 2}), e => e.code === 'REVISION_MISMATCH');
  await assert.rejects(svc.methods['tasks.enhance']('tab1', {expectedRevision: 9}), e => e.code === 'REVISION_MISMATCH');
  assert.equal(submitted.length, 0);
  assert.ok(await svc.methods['tasks.run']('tab1', {expectedRevision: 3}));
});

test('PR11-R01：系统暂停租约与用户暂停分开；waitForIdle 超时报 TIMEOUT', async t => {
  const {svc, submitted, settle} = setup(t);
  await svc.methods['tasks.pause']();
  const lease = svc.hooks.pauseSubmissions('maintenance');
  await svc.methods['tasks.run']('tab1', {}); await settle();
  lease(); await settle();
  assert.equal(submitted.length, 0, '释放维护租约不得解除用户暂停');
  const l2 = svc.hooks.pauseSubmissions('maintenance');
  await svc.methods['tasks.resume'](); await settle();
  assert.equal(submitted.length, 0, '用户继续时维护租约仍阻止提交');
  assert.deepEqual(svc.queue.state().holds, ['maintenance']);
  l2(); await settle();
  assert.equal(submitted.length, 1);
  svc.queue.activeTasks = () => [{id: 'x'}];
  await assert.rejects(svc.hooks.waitForIdle({timeoutMs: 20}), e => e.code === 'TIMEOUT');
});

test('D04/PR11-R10：模板自定义表单进入正式运行——按表单映射写入、记录到快照、失效字段拒绝', async t => {
  const {svc, submitted, settle, editor} = setup(t);
  editor.commands.compileTab = async id => ({tabId: id, templateId: 'tpl1', title: 'T', revision: 3, uiGraph: {nodes: []}, apiPrompt: prompt()});
  const fields = [{scopePath: [], nodeId: '7', nodeType: 'KSampler', fieldName: 'steps', widgetType: 'int', constraints: {min: 1, max: 50}, label: '步数', group: '采样', order: 1, defaultValue: 20},
    {scopePath: [], nodeId: '9', nodeType: 'KSampler', fieldName: 'cfg', widgetType: 'float', constraints: {}, label: '已删节点', group: '采样', order: 0, defaultValue: 1}];
  svc.setFormProvider(id => id === 'tpl1' ? {versionId: 'v2', fields} : null);
  const f = await svc.methods['tasks.form']('tab1');
  assert.deepEqual(f.fields.map(x => [x.label, x.status, x.value]), [['已删节点', 'missing-node', null], ['步数', 'ok', 20]]);
  const task = await svc.methods['tasks.run']('tab1', {formValues: {0: 33}, expectedRevision: 3}); await settle();
  assert.equal(submitted[0].prompt[7].inputs.steps, 33);
  assert.equal(svc.tasks.snapshotOf(svc.tasks.get(task.id)).form.versionId, 'v2');
  await assert.rejects(svc.methods['tasks.run']('tab1', {formValues: {0: 99}}), /超出范围/);
  await assert.rejects(svc.methods['tasks.run']('tab1', {formValues: {1: 2}}), /映射失效/);
  const b = await svc.methods['tasks.runBatch']('tab1', {seeds: [5, 6], formValues: {0: 41}}); await settle();
  assert.deepEqual(submitted.slice(-2).map(x => [x.prompt[7].inputs.steps, x.prompt[7].inputs.seed]), [[41, 5], [41, 6]]);
  assert.equal(b.tasks.length, 2);
  svc.setFormProvider(() => null);
  await assert.rejects(svc.methods['tasks.run']('tab1', {formValues: {0: 3}}), e => e.code === 'INVALID_STATE');
});

test('R18/D15：敏感输入不以明文写入任务快照；提交时从凭据存储还原；凭据缺失时不提交', async t => {
  const store = new Map();
  const credentials = {available: () => true, set: (n, v) => store.set(n, v), get: n => store.get(n) ?? null};
  const {svc, submitted, settle, editor} = setup(t, {credentials});
  const KEY = 'sk-fictional-test-0000';
  editor.commands.compileTab = async id => { const p = prompt(); p[3].inputs.lmstudio_api_key = KEY; return {tabId: id, title: 'T', revision: 3, uiGraph: {nodes: [{id: 3, widgets_values: ['猫', KEY]}]}, apiPrompt: p}; };
  const task = await svc.methods['tasks.run']('tab1', {}); await settle();
  const snap = svc.tasks.snapshotOf(svc.tasks.get(task.id));
  assert.ok(!JSON.stringify(snap).includes(KEY), '快照不含明文');
  assert.match(snap.apiPrompt[3].inputs.lmstudio_api_key, /^__yz_credential__:node-secret:[0-9a-f]{16}$/);
  assert.equal(submitted[0].prompt[3].inputs.lmstudio_api_key, KEY, '提交时还原');
  store.clear();
  const t2 = svc.queue.enqueue({workflowId: 'tab1', snapshot: snap}); await settle();
  assert.equal(submitted.length, 1, '凭据缺失不提交');
  assert.equal(svc.tasks.get(t2.id).state, 'failed');
});
test('S05：快捷使用 / 批量 / 统一入口都经同一脱敏政策；生产代码不直接调用 queue.enqueue', async t => {
  const store = new Map();
  const credentials = {available: () => true, set: (n, v) => store.set(n, v), get: n => store.get(n) ?? null};
  const {svc, submitted, settle, editor} = setup(t, {credentials});
  const KEY = 'sk-fictional-quickuse-1111';
  editor.commands.compileTab = async id => { const p = prompt(); p[3].inputs.lmstudio_api_key = KEY; return {tabId: id, title: 'T', revision: 3, uiGraph: {nodes: [{id: 3, widgets_values: ['猫', KEY]}]}, apiPrompt: p}; };
  const c = await svc.compile('tab1');
  const t1 = svc.submissions.enqueueCompiled(c, c.apiPrompt, {params: {quickUse: 'x.safetensors'}, references: []});
  const b = await svc.methods['tasks.runBatch']('tab1', {seeds: [1, 2]});
  await settle();
  for (const id of [t1.id, ...b.tasks.map(x => x.id)]) assert.ok(!JSON.stringify(svc.tasks.snapshotOf(svc.tasks.get(id))).includes(KEY));
  assert.ok(submitted.length >= 3 && submitted.every(x => x.prompt[3].inputs.lmstudio_api_key === KEY), '提交时仍可还原');
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(__dirname, '..', 'desktop');
  const offenders = [];
  const walk = d => { for (const n of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (/\.c?js$/.test(n.name) && !/queue-service\.cjs$|task-service\.cjs$/.test(n.name) && /\bqueue\.enqueue(Group)?\(|tasks\.create\(/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(dir, p)); } };
  walk(dir);
  assert.deepEqual(offenders, [], '生产代码只能经 submissions 提交');
});
test('S05：存为模板时敏感值转入凭据存储，模板图只留占位；导出时清空占位', async t => {
  const store = new Map();
  const credentials = {available: () => true, set: (n, v) => store.set(n, v), get: n => store.get(n) ?? null};
  const {svc, editor, db, layout} = setup(t, {credentials});
  const KEY = 'sk-fictional-template-2222';
  const ui = {nodes: [{id: 3, type: 'LMStudioPromptEnhancer', widgets_values: ['猫', KEY]}], links: []};
  editor.commands.compileTab = async id => { const p = prompt(); p[3].inputs.lmstudio_api_key = KEY; return {tabId: id, title: 'T', revision: 3, uiGraph: ui, apiPrompt: p}; };
  editor.commands.tabGraph = async id => ({tabId: id, title: 'T', graph: ui, templateId: null});
  const {createTemplateService} = require('../desktop/services/template-service.cjs');
  const out = path.join(layout.root, 'exported.json');
  const ts = createTemplateService({db, layout, editor, taskService: svc, dialog: {showSaveDialog: async () => ({filePath: out})}, getWindow: () => null});
  const r = await ts.methods['templates.saveFromTab']('tab1', {name: '含密钥'});
  const saved = ts.repo.current(r.template.id).graph;
  assert.ok(!JSON.stringify(saved).includes(KEY));
  assert.match(saved.nodes[0].widgets_values[1], /^__yz_credential__:node-secret:/);
  assert.equal([...store.values()][0], KEY);
  await ts.methods['templates.export'](r.template.id);
  const exported = fs.readFileSync(out, 'utf8');
  assert.ok(!exported.includes(KEY) && !exported.includes('__yz_credential__'));
});
test('R18/D15：系统加密不可用时拒绝创建含敏感输入的任务', async t => {
  const {svc, editor} = setup(t, {credentials: {available: () => false}});
  editor.commands.compileTab = async id => { const p = prompt(); p[3].inputs.lmstudio_api_key = 'sk-fictional'; return {tabId: id, title: 'T', revision: 3, uiGraph: {}, apiPrompt: p}; };
  await assert.rejects(svc.methods['tasks.run']('tab1', {}), e => e.code === 'CREDENTIAL_UNAVAILABLE');
});

test('R19：批量任一项无效时整组不登记；R20：模板来源用稳定 workflowId', async t => {
  const {svc, submitted, settle, editor} = setup(t);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {count: 2, seedStart: 1, variations: {steps: [10, 'x']}}), /批量计划无效/);
  await assert.rejects(svc.methods['tasks.runBatch']('tab1', {seeds: [1, -5]}), /seed 无效/);
  assert.equal(svc.tasks.list({limit: 50}).length, 0); await settle(); assert.equal(submitted.length, 0);
  const r = await svc.methods['tasks.runBatch']('tab1', {seeds: [1, 2], variations: {steps: [10, 20]}}); await settle();
  assert.equal(r.tasks.length, 4);
  assert.deepEqual(submitted.map(x => x.prompt[7].inputs.steps), [10, 20, 10, 20]);
  editor.commands.compileTab = async id => ({tabId: id, templateId: 'tplA', title: 'T', revision: 3, uiGraph: {nodes: []}, apiPrompt: prompt()});
  const t1 = await svc.methods['tasks.run']('tab1', {});
  assert.equal(svc.tasks.get(t1.id).workflowId, 'tpl_tplA');
});

test('R12：状态未知的任务重试需要显式确认', async t => {
  const {svc} = setup(t);
  const x = svc.tasks.create({workflowId: 'w', snapshot: {apiPrompt: prompt()}, clientId: 'c'});
  for (const st of ['preparing', 'submitting', 'unknown']) svc.tasks.transition(x.id, st);
  await assert.rejects(svc.methods['tasks.retry'](x.id), e => e.details?.needsConfirm);
  assert.ok(await svc.methods['tasks.retry'](x.id, {confirmDuplicate: true}));
});

test('R11：参考图关系保存在应用数据中（不依赖 localStorage），运行时自动使用；文件丢失时标记且不提交该项；可复制到新标签', async t => {
  const {svc, submitted, settle} = setup(t);
  const id = 'a'.repeat(64) + '.png';
  await assert.rejects(svc.methods['tasks.setRefs']('tab1', [{nodeId: '9', refId: '../x'}]), /编号无效/);
  await svc.methods['tasks.setRefs']('tab1', [{nodeId: '9', input: 'image', refId: id, name: 'x.png'}]);
  const got = await svc.methods['tasks.refs']('tab1');
  assert.deepEqual(got.map(r => [r.refId, r.missing]), [[id, true]]);
  await svc.methods['tasks.copyRefs']('tab1', 'tab2');
  assert.equal((await svc.methods['tasks.refs']('tab2')).length, 1);
  await assert.rejects(svc.methods['tasks.run']('tab1', {}), /参考图文件已丢失/);
  await svc.methods['tasks.setRefs']('tab1', []);
  await svc.methods['tasks.run']('tab1', {}); await settle();
  assert.equal(submitted.length, 1);
});

test('R12：实际提交记录与意图快照分开保存', async t => {
  const {svc, settle} = setup(t);
  const task = await svc.methods['tasks.run']('tab1', {values: {seed: 7}}); await settle();
  const g = await svc.methods['tasks.get'](task.id);
  assert.equal(g.submission.attempts.length, 1);
  assert.match(g.submission.attempts[0].promptSha256, /^[0-9a-f]{64}$/);
  assert.equal(g.submission.attempts[0].requestId, g.requestId);
});
test('S07：表单按标签固定的模板版本读取；运行快照记录版本；面板目标来自 UI 根图', async t => {
  const {svc, settle, editor} = setup(t);
  const ui = {nodes: [{id: 7, type: 'KSampler'}]};
  editor.commands.compileTab = async id => ({tabId: id, templateId: 'tpl1', templateVersionId: 'v-old', title: 'T', revision: 3, uiGraph: ui, apiPrompt: prompt()});
  const asked = [];
  svc.setFormProvider((id, vid) => { asked.push([id, vid]); return {versionId: vid, pinned: true, fields: [{scopePath: [], nodeId: '7', nodeType: 'KSampler', fieldName: 'steps', widgetType: 'int', constraints: {}, label: '步数', group: '采样', order: 0, defaultValue: 20}]}; });
  const f = await svc.methods['tasks.form']('tab1');
  assert.deepEqual(asked[0], ['tpl1', 'v-old'], '不用模板最新版');
  assert.deepEqual(f.fields[0].target, {graphId: null, nodeId: 7, widgetName: 'steps'});
  const task = await svc.methods['tasks.run']('tab1', {}); await settle();
  assert.equal(svc.tasks.snapshotOf(svc.tasks.get(task.id)).form.versionId, 'v-old');
});
test('S08：导出图包→导入为新标签并恢复参考关系；关闭归档重新打开带回模板版本与关系', async t => {
  const {svc, editor, layout} = setup(t);
  const src = path.join(layout.root, '参考.png'); fs.writeFileSync(src, Buffer.from('fictional-image'));
  const ref = svc.refs.importFile(src);
  await svc.methods['tasks.setRefs']('tab1', [{nodeId: '5', input: 'image', refId: ref.id, name: '参考.png'}]);
  const opened = [];
  editor.commands.tabGraph = async id => ({tabId: id, title: '原图', templateId: null, graph: {nodes: [{id: 5, type: 'LoadImage'}]}});
  editor.commands.reopenArchived = async (title, graph, tpl, ver) => { opened.push({title, tpl, ver}); return {state: {activeId: `new${opened.length}`}}; };
  const file = path.join(layout.root, 'pkg.yingzuo.json');
  const ex = await svc.methods['tasks.exportPackage']('tab1', {filePath: file});
  assert.equal(ex.references, 1);
  const im = await svc.methods['tasks.importPackage']({filePath: file});
  assert.equal(im.tabId, 'new1');
  assert.deepEqual((await svc.methods['tasks.refs']('new1')).map(r => [r.refId, r.missing]), [[ref.id, false]]);
  // 关闭归档
  const dir = path.join(layout.root, 'closed-workflows'); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'tab1.json'), JSON.stringify({nodes: []}));
  fs.writeFileSync(path.join(dir, 'tab1.meta.json'), JSON.stringify({title: '已关闭', templateId: 'tpl', templateVersionId: 'v3', closedAt: '2026-10-13T00:00:00Z'}));
  layout.closed = dir;
  const list = await svc.methods['tasks.closedList']();
  assert.equal(list[0].references, 1);
  const r = await svc.methods['tasks.reopenClosed']('tab1');
  assert.deepEqual(opened[1], {title: '已关闭', tpl: 'tpl', ver: 'v3'});
  assert.equal((await svc.methods['tasks.refs'](r.tabId)).length, 1);
  await assert.rejects(svc.methods['tasks.reopenClosed']('../x'), /无效/);
});
