'use strict';
// PR11-R09：异步创作流程固定发起标签。用最小 DOM 运行真实 desktop/ui/tasks.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../desktop/ui/tasks.js'), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 5));

function el() { const ls = {}; return {disabled: false, hidden: false, textContent: '', innerHTML: '', addEventListener(n, f) { ls[n] = f; }, fire(n, e = {}) { return ls[n]?.(e); }}; }
function setup({modalAnswers, enhanceResult = {state: 'succeeded', text: '润色后', original: '原文'}, runImpl} = {}) {
  const els = new Map(); const q = s => { if (!els.has(s)) els.set(s, el()); return els.get(s); };
  const calls = []; let subscriber = null; const tasksList = [];
  const ok = data => Promise.resolve({ok: true, data});
  const yz = {
    tasks: {
      preview: tabId => { calls.push(['preview', tabId]); return ok({tabId, title: tabId === 'A' ? 'A图' : 'B图', revision: 5, bindings: {enhancer: {nodeId: '3'}, prompt: {value: '原文'}, seed: {}, references: []}}); },
      enhance: (tabId, opts) => { calls.push(['enhance', tabId, opts]); return ok({id: 'e1'}); },
      enhanceResult: () => ok(enhanceResult),
      run: (tabId, opts) => { calls.push(['run', tabId, opts]); return runImpl ? runImpl(tabId, opts) : ok({id: 't1'}); },
      runBatch: (tabId, spec) => { calls.push(['runBatch', tabId, spec]); return ok({tasks: []}); },
      list: () => ok({tasks: tasksList, queue: {}}),
    },
    events: {subscribe: f => { subscriber = f; }},
  };
  const answers = [...modalAnswers];
  const ctx = {
    window: {yingzuo: yz, yzShell: {esc: s => String(s), toast: (m, err) => calls.push(['toast', m, !!err]), swallow: () => {}, page: 'create',
      call: async (p, okMsg) => { const r = await p; if (!r.ok) throw Object.assign(new Error(r.error.message), {handled: true, code: r.error.code}); return r.data; },
      modal: async () => { const a = answers.shift(); return typeof a === 'function' ? a() : a; }}},
    document: {querySelector: q, addEventListener() {}}, localStorage: {getItem: () => null, setItem() {}},
    setInterval: () => 0, setTimeout, clearTimeout, current: {activeId: 'A', connected: true, tabs: [{id: 'A', title: 'A图'}, {id: 'B', title: 'B图'}]},
  };
  vm.runInNewContext(`var current = this.current;\n${source}`, ctx);
  return {q, calls, ctx, finish: () => { tasksList.push({id: 'e1', state: 'succeeded'}); subscriber({type: 'tasks.changed', data: {}}); }};
}

test('等待润色期间切到 B：采用结果仍提交到 A，且带原 revision', async () => {
  const s = setup({modalAnswers: ['原文', {action: 'adopt', text: '润色后'}]});
  s.q('#run-enhance').fire('click');
  await tick();
  s.ctx.current.activeId = 'B'; // 用户切到另一张图
  s.finish(); await new Promise(r => setTimeout(r, 200));
  const run = s.calls.find(c => c[0] === 'run');
  assert.ok(run, JSON.stringify(s.calls));
  assert.equal(run[1], 'A');
  assert.equal(run[2].expectedRevision, 5);
  assert.equal(run[2].adoptedText, '润色后');
  assert.ok(!s.calls.some(c => c[1] === 'B'));
  assert.equal(s.calls.find(c => c[0] === 'enhance')[1], 'A');
});

test('A 被修改：提示确认，取消则不提交；A 已关闭则不提交到任何标签', async () => {
  for (const code of ['REVISION_MISMATCH', 'NOT_FOUND']) {
    const s = setup({modalAnswers: ['原文', {action: 'adopt', text: 'x'}, false], runImpl: () => Promise.resolve({ok: false, error: {code, message: code}})});
    s.q('#run-enhance').fire('click'); await tick();
    s.ctx.current.activeId = 'B';
    s.finish(); await new Promise(r => setTimeout(r, 200));
    const runs = s.calls.filter(c => c[0] === 'run');
    assert.equal(runs.length, 1); assert.equal(runs[0][1], 'A');
  }
});

test('A 被修改且用户确认：仍只对 A 以最新内容提交', async () => {
  let n = 0;
  const s = setup({modalAnswers: ['原文', {action: 'adopt', text: 'x'}, true], runImpl: () => Promise.resolve(n++ ? {ok: true, data: {id: 't'}} : {ok: false, error: {code: 'REVISION_MISMATCH', message: 'm'}})});
  s.q('#run-enhance').fire('click'); await tick();
  s.ctx.current.activeId = 'B';
  s.finish(); await new Promise(r => setTimeout(r, 200));
  const runs = s.calls.filter(c => c[0] === 'run');
  assert.deepEqual(runs.map(r => [r[1], r[2].expectedRevision]), [['A', 5], ['A', null]]);
});

test('批量弹窗打开后切图：仍提交到发起标签', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = setup({modalAnswers: [() => gate.then(() => ({prompts: [], count: 2, seedStart: null}))]});
  s.q('#run-batch').fire('click'); await tick();
  s.ctx.current.activeId = 'B'; release(); await tick();
  const b = s.calls.find(c => c[0] === 'runBatch');
  assert.equal(b[1], 'A'); assert.equal(b[2].expectedRevision, 5);
});
