'use strict';
// Q06/Q07/Q08/Q10：运行入口、任务队列、仅润色与批量界面。所有结果来自 tasks.* 接口与事件，不做本地模拟。
(() => {
const yz = window.yingzuo, S = window.yzShell;
const q = s => document.querySelector(s);
const {esc, toast, call, swallow, modal} = S;
const STATE = {draft: '草稿', queued: '排队中', preparing: '准备中', submitting: '提交中', submitted: '已提交', running: '运行中', reconciling: '核对中', succeeded: '已完成', failed: '失败', cancelled: '已取消', paused: '已暂停', unknown: '状态未知'};
let tasks = [], queueState = {}, refreshTimer = null;
const waiters = new Map(); // taskId → resolve（等待终态）
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

function canRun() { return typeof current === 'object' && current && current.activeId && current.connected; }
function syncRunBar() {
  const ok = canRun();
  for (const id of ['#run-task', '#run-batch', '#run-enhance']) q(id).disabled = !ok;
  q('#run-hint').textContent = ok ? (queueState.waiting === 'external' ? '后端有其他任务，本应用任务会在其后提交' : queueState.paused ? '队列已暂停' : '') : '打开工作流并连接 ComfyUI 后可运行';
}
setInterval(syncRunBar, 1000);

async function runCurrent(options = {}) {
  try {
    const t = await call(yz.tasks.run(current.activeId, options), '已加入队列。');
    scheduleRefresh(); return t;
  } catch (e) { const issues = e.details?.issues; swallow(e); return null; }
}
q('#run-task').addEventListener('click', () => runCurrent());
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.page === 'create' && canRun()) { e.preventDefault(); runCurrent(); } });

/* ---------- Q10 批量 ---------- */
q('#run-batch').addEventListener('click', async () => {
  let preview;
  try { preview = await call(yz.tasks.preview(current.activeId)); } catch (e) { swallow(e); return; }
  const b = preview.bindings;
  const spec = await modal(`<h3>批量运行</h3>
    <p class="muted">提示词输入：${b.prompt ? esc(`${b.prompt.nodeType} #${b.prompt.nodeId}`) : '未识别（不能批量替换提示词）'}；seed：${b.seed ? esc(`#${(b.seed.readonly ? b.seedSource : b.seed)?.nodeId ?? '—'}`) : '未识别'}</p>
    <label>提示词（每行一个，留空则使用当前提示词）</label><textarea id="b-prompts" ${b.prompt ? '' : 'disabled'}></textarea>
    <label>每个提示词运行次数</label><input id="b-count" type="number" min="1" max="100" value="2">
    <label>起始 seed（留空则不改 seed）</label><input id="b-seed" type="number" ${b.seed ? '' : 'disabled'}>
    <p id="b-total" class="muted"></p>
    <div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">加入队列</button></div>`, (back, done) => {
    const read = () => { const prompts = back.querySelector('#b-prompts').value.split('\n').map(s => s.trim()).filter(Boolean); const seed = back.querySelector('#b-seed').value; return {prompts, count: Math.max(1, Number(back.querySelector('#b-count').value) || 1), seedStart: seed === '' ? null : Number(seed)}; };
    const update = () => { const s = read(); const n = Math.max(1, s.prompts.length) * s.count; back.querySelector('#b-total').textContent = `共 ${n} 个任务（上限 100）${s.seedStart === null && s.count > 1 ? '；未设置起始 seed 时每次使用工作流当前 seed 设置' : ''}`; };
    back.addEventListener('input', update); update();
    back.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes' ? read() : null); });
  });
  if (!spec) return;
  try { const r = await call(yz.tasks.runBatch(current.activeId, spec), d => `已加入 ${d.tasks.length} 个任务。`); scheduleRefresh(); return r; } catch (e) { swallow(e); }
});

/* ---------- Q08 仅润色 ---------- */
function waitTerminal(id) { return new Promise(resolve => { const t = tasks.find(x => x.id === id); if (t && TERMINAL.has(t.state)) resolve(t); else waiters.set(id, resolve); }); }
q('#run-enhance').addEventListener('click', async () => {
  let preview;
  try { preview = await call(yz.tasks.preview(current.activeId)); } catch (e) { swallow(e); return; }
  if (!preview.bindings.enhancer) { toast('此工作流没有 Gemma 润色节点。', true); return; }
  const original = preview.bindings.prompt?.value ?? '';
  let text = original;
  for (;;) {
    const input = await modal(`<h3>仅润色（不出图）</h3><p class="muted">只运行润色节点及其上游，结果可编辑后再决定是否采用。</p><textarea id="e-in">${esc(text)}</textarea><div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">开始润色</button></div>`, (back, done) => back.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes' ? back.querySelector('#e-in').value : null); }));
    if (input === null) return;
    text = input;
    let task;
    try { task = await call(yz.tasks.enhance(current.activeId, {text})); } catch (e) { swallow(e); return; }
    toast('润色任务已加入队列…'); scheduleRefresh();
    await waitTerminal(task.id);
    let result;
    try { result = await call(yz.tasks.enhanceResult(task.id)); } catch (e) { swallow(e); return; }
    const choice = await modal(`<h3>润色结果</h3>${result.text ? `<label>可编辑</label><textarea id="e-out">${esc(result.text)}</textarea>` : `<p class="err">${esc(result.error?.message ?? STATE[result.state])}</p>`}<p class="muted">原文：${esc(result.original ?? text)}</p>
      <div class="actions"><button data-x="no">保留原文</button><button data-x="retry">重新润色</button>${result.text ? '<button data-x="adopt" class="primary">采用并生成</button>' : ''}</div>`, (back, done) => back.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done({action: x.dataset.x, text: back.querySelector('#e-out')?.value}); }));
    if (choice.action === 'retry') continue;
    if (choice.action === 'adopt') await runCurrent({adoptedText: choice.text});
    return;
  }
});

/* ---------- 队列页 ---------- */
function describeError(t) {
  if (!t.error) return '';
  const nodes = (t.error.nodeErrors ?? []).map(n => `节点 ${n.nodeId}${n.nodeType ? `（${n.nodeType}）` : ''}${n.input ? ` · ${n.input}` : ''}：${n.message}`);
  return [t.error.message, t.error.nodeId ? `出错节点 ${t.error.nodeId}${t.error.nodeType ? `（${t.error.nodeType}）` : ''}` : '', ...nodes].filter(Boolean).join('\n');
}
function renderQueue() {
  const active = tasks.filter(t => !TERMINAL.has(t.state) && t.state !== 'paused').length;
  const badge = q('#queue-badge'); badge.hidden = !active; badge.textContent = active;
  const ext = queueState.external?.length ? `后端有 ${queueState.external.length} 个其他来源的任务（ComfyUI 原生或其他客户端），本应用会等待它们结束再提交，不会接管或取消。` : '';
  q('#queue-state').textContent = [queueState.paused ? '提交已暂停（重启后未提交的任务默认暂停，确认后点“继续”）。' : '按加入顺序逐个提交。', ext].filter(Boolean).join(' ');
  q('#queue-list').innerHTML = tasks.length ? tasks.map(t => {
    const p = t.progress ?? {};
    const prog = t.state === 'running' && p.max ? `<progress value="${Number(p.value) || 0}" max="${Number(p.max)}"></progress> 节点 ${esc(p.node ?? '')}` : '';
    const btns = [
      ['queued', 'paused', 'preparing', 'submitted', 'running', 'unknown'].includes(t.state) ? `<button data-cancel="${t.id}">${t.state === 'unknown' ? '放弃' : '取消'}</button>` : '',
      ['failed', 'cancelled'].includes(t.state) ? `<button data-retry="${t.id}">重试（原参数）</button>` : '',
      t.state === 'unknown' ? `<button data-recheck="${t.id}">重新核对</button>` : '',
    ].join('');
    const outs = (t.outputs ?? []).filter(o => o.kind === 'image').length;
    return `<div class="task"><span class="badge ${t.state === 'succeeded' ? 'ok' : t.state === 'failed' || t.state === 'unknown' ? 'bad' : 'warn'}">${STATE[t.state] ?? t.state}</span>
      <div><div>${t.kind === 'enhance' ? '润色 · ' : ''}${esc(t.workflowId)} <span class="meta">#${t.seq} · ${esc(new Date(t.createdAt).toLocaleString())}${t.retryOf ? ' · 重试' : ''}${t.groupId ? ' · 批量' : ''}${outs ? ` · ${outs} 张图` : ''}</span></div>${prog}${t.state === 'unknown' ? '<div class="err">提交后与 ComfyUI 失去联系，无法确认是否已执行。不会自动重发；可重新核对或放弃。</div>' : ''}<div class="err">${esc(describeError(t))}</div></div>
      <div class="actions">${btns}</div></div>`;
  }).join('') : '<p class="muted">还没有任务。</p>';
}
async function refresh() {
  try { const r = await call(yz.tasks.list({limit: 200})); tasks = r.tasks; queueState = r.queue; renderQueue(); syncRunBar(); }
  catch (e) { /* 数据库不可用时 call 已提示 */ }
  for (const [id, resolve] of waiters) { const t = tasks.find(x => x.id === id); if (t && TERMINAL.has(t.state)) { waiters.delete(id); resolve(t); } }
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }
q('#queue-list').addEventListener('click', async e => {
  const c = e.target.closest('[data-cancel]'), r = e.target.closest('[data-retry]'), k = e.target.closest('[data-recheck]');
  try {
    if (c) await call(yz.tasks.cancel(c.dataset.cancel), '已请求取消。');
    if (r) await call(yz.tasks.retry(r.dataset.retry), '已按原参数重新加入队列。');
    if (k) await call(yz.tasks.recheck(k.dataset.recheck), d => `核对结果：${STATE[d.state] ?? d.state}`);
  } catch (err) { swallow(err); }
  scheduleRefresh();
});
q('#queue-pause').addEventListener('click', () => call(yz.tasks.pause(), '已暂停提交（正在运行的任务不受影响）。').then(scheduleRefresh, swallow));
q('#queue-resume').addEventListener('click', () => call(yz.tasks.resume(), '已继续。').then(scheduleRefresh, swallow));
q('#queue-refresh').addEventListener('click', refresh);
yz.events.subscribe(event => {
  if (event.type === 'tasks.changed' || event.type === 'tasks.progress') {
    if (event.type === 'tasks.changed' && event.data?.state === 'failed') toast(`任务失败：${event.data.error?.message ?? ''}`, true);
    scheduleRefresh();
  }
  if (event.type === 'queue.state') { queueState = {...queueState, ...event.data}; renderQueue(); syncRunBar(); }
});
refresh();
})();
