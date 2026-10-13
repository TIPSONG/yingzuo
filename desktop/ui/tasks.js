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
  for (const id of ['#run-task', '#run-batch', '#run-enhance', '#run-refs']) q(id).disabled = !ok;
  q('#run-hint').textContent = ok ? (queueState.waiting === 'external' ? '后端有其他任务，本应用任务会在其后提交' : queueState.paused ? '队列已暂停' : '') : '打开工作流并连接 ComfyUI 后可运行';
}
setInterval(syncRunBar, 1000);

/* ---------- E08 参考图：按标签保存选择（内容寻址编号），每次运行前由主进程上传 ---------- */
// R11：关系保存在主进程应用数据中；旧版 localStorage 记录首次读取时迁移
const refKey = tabId => `yingzuo.refs.${tabId}`;
async function loadRefs(tabId) {
  let items = await call(yz.tasks.refs(tabId));
  let legacy = null; try { legacy = JSON.parse(localStorage.getItem(refKey(tabId)) || 'null'); } catch { legacy = null; }
  if (!items.length && Array.isArray(legacy) && legacy.length) { items = await call(yz.tasks.setRefs(tabId, legacy)); }
  if (legacy) try { localStorage.removeItem(refKey(tabId)); } catch { /* 忽略 */ }
  return items;
}
const saveRefs = (tabId, refs) => call(yz.tasks.setRefs(tabId, refs.map(({missing, ...r}) => r)));
q('#run-refs').addEventListener('click', async () => {
  const tabId = current.activeId; // PR11-R09：先固定发起标签，之后不再读取 current
  let preview;
  try { preview = await call(yz.tasks.preview(tabId)); } catch (e) { swallow(e); return; }
  const slots = (preview.bindings.references ?? []).filter(r => r && !r.readonly);
  if (!slots.length) { toast('此工作流没有可替换的 LoadImage 参考图节点。'); return; }
  let refs; try { refs = (await loadRefs(tabId)).filter(r => slots.some(s => s.nodeId === r.nodeId)); } catch (e) { swallow(e); return; }
  const enh = preview.bindings.enhancer;
  const render = back => { back.querySelector('#r-list').innerHTML = slots.map((s, i) => { const r = refs.find(x => x.nodeId === s.nodeId); return `<div class="row"><span>图 ${i + 1} · 节点 #${esc(s.nodeId)}：${r ? `${esc(r.name)}${r.missing ? ' <span class="err">（文件已丢失，请重新选择）</span>' : ''}` : `沿用工作流中的 ${esc(s.value)}`}</span><span><button data-pick="${esc(s.nodeId)}">选择…</button>${r ? `<button data-clear="${esc(s.nodeId)}">移除</button>` : ''}</span></div>`; }).join(''); };
  await modal(`<h3>参考图</h3><p class="muted">图片复制到本机数据目录保存，运行时上传到 ComfyUI。${enh ? `Gemma 润色节点最多读取 ${enh.imageInputs.length > 2 ? 2 : '前 2'} 张，之后的参考图仍交给 Qwen。` : ''}</p><div id="r-list" class="list"></div><div class="actions"><button data-x="done" class="primary">完成</button></div>`, (back, done) => {
    render(back);
    back.addEventListener('click', async e => {
      const pick = e.target.closest('[data-pick]'), clear = e.target.closest('[data-clear]'), x = e.target.closest('[data-x]');
      if (pick) { try { const r = await call(yz.tasks.pickReference()); if (!r.cancelled) { refs = [...refs.filter(v => v.nodeId !== pick.dataset.pick), {nodeId: pick.dataset.pick, input: 'image', refId: r.id, name: r.name}]; await saveRefs(tabId, refs); render(back); } } catch (err) { swallow(err); } }
      if (clear) { refs = refs.filter(v => v.nodeId !== clear.dataset.clear); saveRefs(tabId, refs).then(() => render(back), swallow); }
      if (x) done();
    });
  });
});
/** PR11-R09：所有异步流程在开始时固定 {tabId, revision}，之后只对该标签提交。 */
const tabTitle = tabId => current?.tabs?.find(t => t.id === tabId)?.title ?? '原标签';
async function confirmStale(origin, err) {
  if (err.code === 'NOT_FOUND') { toast(`「${origin.title ?? tabTitle(origin.tabId)}」已关闭，本次结果未提交到其他标签。`, true); return false; }
  if (err.code !== 'REVISION_MISMATCH') return false;
  return modal(`<h3>原标签已被修改</h3><p>「${esc(origin.title ?? tabTitle(origin.tabId))}」在等待期间被修改。可以用它的最新内容继续，或取消。结果不会用于其他标签。</p><div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">用该标签最新内容继续</button></div>`, (back, done) => back.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes'); }));
}
async function runFor(origin, options = {}) {
  try {
    const t = await call(yz.tasks.run(origin.tabId, {expectedRevision: origin.revision ?? null, ...options}), '已加入队列。');
    scheduleRefresh(); return t;
  } catch (e) {
    if (origin.revision != null && await confirmStale(origin, e)) return runFor({...origin, revision: null}, options);
    if (!e.handled) swallow(e); return null;
  }
}
function runCurrent(options = {}) { return runFor({tabId: current.activeId, revision: null}, options); }
q('#run-task').addEventListener('click', () => runCurrent()); // S07：按钮与 Ctrl+Enter 同一入口；表单参数已在左侧面板写入画布
// E10：焦点在原生 ComfyUI 视图时，主进程转发 Ctrl+Enter
window.yingzuoDesktop?.onStatus?.(d => { if (d?.shortcut === 'run' && S.page === 'create') { if (canRun()) runCurrent(); else toast('请先连接 ComfyUI 并打开工作流。', true); } });
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.page === 'create' && canRun()) { e.preventDefault(); runCurrent(); } });

/* ---------- S08：图包与关闭归档 ---------- */
const missingNote = d => (d.missing?.length ? `；${d.missing.length} 张参考图缺失：${d.missing.join('、')}` : '');
q('#pkg-export')?.addEventListener('click', () => { if (!current.activeId) return toast('请先打开工作流。', true); call(yz.tasks.exportPackage(current.activeId), d => (d.cancelled ? '已取消。' : `已导出（${d.references} 张参考图${missingNote(d)}）。`)).catch(swallow); });
q('#pkg-import')?.addEventListener('click', () => call(yz.tasks.importPackage(), d => (d.cancelled ? '已取消。' : `已导入为新的工作副本（${d.references} 张参考图${missingNote(d)}）。`)).catch(swallow));
q('#closed-list')?.addEventListener('click', async () => {
  let list; try { list = await call(yz.tasks.closedList()); } catch (e) { swallow(e); return; }
  const id = await modal(`<h3>最近关闭</h3><div class="list">${list.map(c => `<div class="row"><span>${esc(c.title)} <small class="muted">${esc(c.closedAt)}${c.references ? ` · ${c.references} 张参考图` : ''}</small></span><button data-open="${esc(c.id)}">重新打开</button></div>`).join('') || '<div class="empty-state"><h3>没有已关闭的标签</h3><p>关闭标签后可在这里重新打开。</p></div>'}</div><div class="actions"><button data-x="no">关闭</button></div>`, (back, done) => back.addEventListener('click', e => { const o = e.target.closest('[data-open]'), x = e.target.closest('[data-x]'); if (o) done(o.dataset.open); else if (x) done(null); }));
  if (id) call(yz.tasks.reopenClosed(id), d => `已重新打开${missingNote(d)}。`).catch(swallow);
});

/* ---------- Q10 批量 ---------- */
q('#run-batch').addEventListener('click', async () => {
  const tabId = current.activeId;
  let preview;
  try { preview = await call(yz.tasks.preview(tabId)); } catch (e) { swallow(e); return; }
  const origin = {tabId, revision: preview.revision, title: preview.title};
  const b = preview.bindings;
  const varKeys = ['steps', 'cfg', 'denoise', 'width', 'height', 'sampler_name', 'scheduler'].filter(k => b[k] && !b[k].readonly && 'value' in b[k]);
  const spec = await modal(`<h3>批量运行</h3>
    <p class="muted">提示词输入：${b.prompt ? esc(`${b.prompt.nodeType} #${b.prompt.nodeId}`) : '未识别（不能批量替换提示词）'}；seed：${b.seed ? esc(`#${(b.seed.readonly ? b.seedSource : b.seed)?.nodeId ?? '—'}`) : '未识别'}</p>
    <label>提示词（每行一个，留空则使用当前提示词）</label><textarea id="b-prompts" ${b.prompt ? '' : 'disabled'}></textarea>
    <label>每个提示词运行次数</label><input id="b-count" type="number" min="1" max="100" value="2">
    <label>起始 seed（留空则不改 seed）</label><input id="b-seed" type="number" ${b.seed ? '' : 'disabled'}>
    ${varKeys.length ? `<label>参数变化（逗号分隔，留空不变化；全部校验通过才会加入任何任务）</label>${varKeys.map(k => `<label class="field"><span>${esc(k)}（当前 ${esc(b[k].value)}）</span><input data-var="${esc(k)}" placeholder="例如 ${esc(b[k].value)}, ${esc(b[k].value)}"></label>`).join('')}` : ''}
    <p id="b-total" class="muted"></p>
    <div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">加入队列</button></div>`, (back, done) => {
    // R19：参数变化。数字按数字解析，无法解析的原样交给主进程校验并整体拒绝
    const readVars = () => { const v = {}; for (const el of back.querySelectorAll('[data-var]')) { const list = el.value.split(/[,，]/).map(x => x.trim()).filter(Boolean); if (list.length) v[el.dataset.var] = list.map(x => (typeof b[el.dataset.var].value === 'number' && x !== '' && !Number.isNaN(Number(x))) ? Number(x) : x); } return v; };
    const read = () => { const prompts = back.querySelector('#b-prompts').value.split('\n').map(s => s.trim()).filter(Boolean); const seed = back.querySelector('#b-seed').value; const variations = readVars(); return {prompts, count: Math.max(1, Number(back.querySelector('#b-count').value) || 1), seedStart: seed === '' ? null : Number(seed), ...(Object.keys(variations).length ? {variations} : {})}; };
    const update = () => { const s = read(); const n = Math.max(1, s.prompts.length) * s.count * Object.values(s.variations ?? {}).reduce((m, l) => m * l.length, 1); back.querySelector('#b-total').textContent = `共 ${n} 个任务（上限 100）${s.seedStart === null && s.count > 1 ? '；未设置起始 seed 时每次使用工作流当前 seed 设置' : ''}`; };
    back.addEventListener('input', update); update();
    back.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes' ? read() : null); });
  });
  if (!spec) return;
  const submit = async rev => { const r = await call(yz.tasks.runBatch(origin.tabId, {...spec, expectedRevision: rev}), d => `已加入 ${d.tasks.length} 个任务。`); scheduleRefresh(); return r; };
  try { return await submit(origin.revision); } catch (e) { if (await confirmStale(origin, e)) { try { return await submit(null); } catch { /* 已提示 */ } } }
});

/* ---------- Q08 仅润色 ---------- */
function waitTerminal(id) { return new Promise(resolve => { const t = tasks.find(x => x.id === id); if (t && TERMINAL.has(t.state)) resolve(t); else waiters.set(id, resolve); }); }
q('#run-enhance').addEventListener('click', async () => {
  const tabId = current.activeId;
  let preview;
  try { preview = await call(yz.tasks.preview(tabId)); } catch (e) { swallow(e); return; }
  if (!preview.bindings.enhancer) { toast('此工作流没有 Gemma 润色节点。', true); return; }
  const origin = {tabId, revision: preview.revision, title: preview.title};
  const original = preview.bindings.prompt?.value ?? '';
  let text = original, lastText = null;
  for (;;) {
    const input = await modal(`<h3>仅润色（不出图）</h3><p class="muted">只运行润色节点及其上游，结果可编辑后再决定是否采用。</p><textarea id="e-in">${esc(text)}</textarea><div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">开始润色</button></div>`, (back, done) => back.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes' ? back.querySelector('#e-in').value : null); }));
    if (input === null) return;
    text = input;
    let task;
    try { task = await call(yz.tasks.enhance(origin.tabId, {text, rerun: text === lastText, expectedRevision: origin.revision})); } catch (e) { if (await confirmStale(origin, e)) { origin.revision = null; continue; } return; }
    lastText = text;
    toast('润色任务已加入队列…'); scheduleRefresh();
    await waitTerminal(task.id);
    let result;
    try { result = await call(yz.tasks.enhanceResult(task.id)); } catch (e) { swallow(e); return; }
    const choice = await modal(`<h3>润色结果</h3>${result.text ? `<label>可编辑</label><textarea id="e-out">${esc(result.text)}</textarea>` : `<p class="err">${esc(result.error?.message ?? STATE[result.state])}</p>`}<p class="muted">原文：${esc(result.original ?? text)}</p>
      <div class="actions"><button data-x="no">保留原文</button><button data-x="retry">重新润色</button>${result.text ? '<button data-x="adopt" class="primary">采用并生成</button>' : ''}</div>`, (back, done) => back.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done({action: x.dataset.x, text: back.querySelector('#e-out')?.value}); }));
    if (choice.action === 'retry') continue;
    if (choice.action === 'adopt') await runFor(origin, {adoptedText: choice.text});
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
      t.state === 'unknown' ? `<button data-retry="${t.id}" data-unknown="1">仍要重试…</button>` : '',
      t.state === 'unknown' ? `<button data-recheck="${t.id}">重新核对</button>` : '',
    ].join('');
    const outs = (t.outputs ?? []).filter(o => o.kind === 'image').length;
    return `<div class="task"><span class="badge ${t.state === 'succeeded' ? 'ok' : t.state === 'failed' || t.state === 'unknown' ? 'bad' : 'warn'}">${STATE[t.state] ?? t.state}</span>
      <div><div>${t.kind === 'enhance' ? '润色 · ' : ''}${esc(t.workflowId)} <span class="meta">#${t.seq} · ${esc(new Date(t.createdAt).toLocaleString())}${t.retryOf ? ' · 重试' : ''}${t.groupId ? ' · 批量' : ''}${outs ? ` · ${outs} 张图` : ''}</span></div>${prog}${t.state === 'unknown' ? '<div class="err">提交后与 ComfyUI 失去联系，无法确认是否已执行。不会自动重发；可重新核对或放弃。</div>' : ''}<div class="err">${esc(describeError(t))}</div></div>
      <div class="actions">${btns}</div></div>`;
  }).join('') : '<div class="empty-state"><h3>还没有任务</h3><p>在创作页打开工作流并点击「运行」后，任务会出现在这里。</p></div>';
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
    if (c) {
      try { await call(yz.tasks.cancel(c.dataset.cancel), '已请求取消。'); }
      catch (err) {
        // S03：旧版 ComfyUI 无法只取消这个任务；全局中断必须由用户明确选择
        if (!err.details?.needsGlobalInterrupt) throw err;
        if (await confirmModal('中断后端当前执行？', '当前 ComfyUI 不支持只取消这个任务。继续将中断后端此刻正在执行的任何任务（包括原生画布或其他程序提交的任务）。')) await call(yz.tasks.cancel(c.dataset.cancel, {globalInterrupt: true}), '已发送全局中断。');
      }
    }
    if (r && r.dataset.unknown) { if (await confirmModal('可能重复出图', '这个任务提交后失去联系，ComfyUI 可能已经执行过。重试会再执行一次。')) await call(yz.tasks.retry(r.dataset.retry, {confirmDuplicate: true}), '已重新加入队列。'); }
    else if (r) await call(yz.tasks.retry(r.dataset.retry), '已按原参数重新加入队列。');
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
