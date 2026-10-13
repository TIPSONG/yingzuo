'use strict';
// R01–R08、U01–U07 界面：本地模型、引用、插件、备份/更新/恢复。所有改动环境的操作都由主进程维护事务执行。
(() => {
const yz = window.yingzuo, S = window.yzShell;
const q = s => document.querySelector(s);
const {esc, toast, call, swallow, modal} = S;
const size = b => b == null ? '' : b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;
const STATUS = {done: '完成', restored: '失败，已自动恢复到操作前', 'restore-failed': '失败且自动恢复也失败（请查看待处理恢复）', blocked: '未执行'};
const report = r => { const ok = r.status === 'done'; toast(`${STATUS[r.status] ?? r.status}${r.error ? `：${r.error.message}` : ''}${r.result?.pending ? '；本地补丁冲突，已列入待处理' : ''}${ok && r.result?.needsRestart ? '；需重启 ComfyUI 生效' : ''}`, !ok); return r; };
const confirmBox = (title, body) => modal(`<h3>${esc(title)}</h3>${body}<div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">确认执行</button></div>`, (back, done) => back.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) done(b.dataset.x === 'yes'); }));
let scan = null;

async function doScan() {
  q('#rs-models').innerHTML = '<p class="muted">扫描中…</p>';
  try {
    scan = await call(yz.resources.scan());
    const byFolder = {}; for (const i of scan.items) (byFolder[i.folder] ??= []).push(i);
    q('#rs-models').innerHTML = `<p class="muted">共 ${scan.count} 个模型文件${scan.duplicates?.length ? ` · ${scan.duplicates.length} 组同名重复` : ''}</p>` + Object.entries(byFolder).map(([f, list]) => `<details><summary>${esc(f)}（${list.length}）</summary>${list.map(i => `<div class="row"><span>${esc(i.name)} <small class="muted">${size(i.size)} · ${esc(i.format ?? '')}${i.symlink ? ' · 链接' : ''}</small></span><button data-detail="${esc(i.id)}">详情</button></div>`).join('')}</details>`).join('');
  } catch (e) { q('#rs-models').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function openDetail(id) {
  const d = await call(yz.resources.detail(id));
  const refs = [...d.references.exact.map(r => ({...r, m: '精确'})), ...d.references.possible.map(r => ({...r, m: '仅文件名相同'}))];
  const roots = (await call(yz.resources.modelRoots()))[d.folder] ?? [];
  const act = await modal(`<h3>${esc(d.name)}</h3><p class="muted">${esc(d.path)} · ${size(d.size)}</p>
    <p>用途：${esc(d.folder)} · 架构：${esc(d.architecture ?? '未知')} · 量化/精度：${esc(d.quantization ?? '未知')}</p>
    ${d.triggerWords?.length ? `<p>触发词：${d.triggerWords.map(esc).join('，')}</p>` : ''}${d.recommendedWeight != null ? `<p>推荐权重：${esc(String(d.recommendedWeight))}</p>` : ''}${d.description ? `<p class="muted">${esc(String(d.description).slice(0, 400))}</p>` : ''}
    <label>说明（手动补充）</label><input id="rd-note" value="${esc(d.manual?.includes('description') ? d.description ?? '' : '')}"><label>架构（手动更正）</label><input id="rd-arch" value="${esc(d.manual?.includes('architecture') ? d.architecture : '')}" placeholder="如 flux / sdxl / qwen-image">
    <h4>引用（草稿、模板、最近任务）</h4>${refs.map(r => `<p class="muted">${esc(r.title)} · 节点 ${esc(r.nodeId)} ${esc(r.nodeType ?? '')} · ${r.m}</p>`).join('') || '<p class="muted">没有找到引用。</p>'}
    <h4>移动到同用途的其他已登记目录</h4><select id="rd-root">${roots.filter(r => r.exists && !d.path.startsWith(r.dir)).map(r => `<option>${esc(r.dir)}</option>`).join('') || '<option value="">（没有其他已登记目录，可在 extra_model_paths.yaml 中添加）</option>'}</select>
    <div class="actions"><button data-x="hash">计算 sha256</button><button data-x="quick">用于当前工作流…</button><button data-x="move">移动</button><button data-x="save" class="primary">保存备注</button><button data-x="close">关闭</button></div>`,
    (back, done) => back.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) done({x: b.dataset.x, note: back.querySelector('#rd-note').value, arch: back.querySelector('#rd-arch').value.trim(), root: back.querySelector('#rd-root').value}); }));
  if (!act || act.x === 'close') return;
  if (act.x === 'save') { await call(yz.resources.setNote(id, {description: act.note || null, ...(act.arch ? {architecture: act.arch} : {})}), '已保存。'); return openDetail(id); }
  if (act.x === 'hash') { const h = await call(yz.resources.hash(id)); toast(`sha256：${h.sha256}`); return; }
  if (act.x === 'move') {
    if (!act.root) return toast('没有可选的目标目录。', true);
    const imp = await call(yz.resources.impact(id, 'move'));
    if (!await confirmBox('移动模型', `<p>移动到 ${esc(act.root)}。ComfyUI 中的相对名称不变，${imp.affected.length} 个来源的引用无需修改。跨磁盘时先复制并校验 sha256 再删除原文件。</p>`)) return;
    const r = await call(yz.resources.moveModel(id, act.root)); toast(`已移动到 ${r.moved}`); return doScan();
  }
  if (act.x === 'quick') {
    if (!current?.activeId) return toast('请先在创作页打开一个工作流。', true);
    const plan = await call(yz.resources.quickUse(id, current.activeId, {workflowArchitecture: null}));
    if (!plan.available) return toast(plan.reason, true);
    if (!await confirmBox('一键使用', `<p>将修改以下节点后提交运行（不改动原工作流）：</p>${(plan.changes ?? []).map(c => `<p class="muted">${esc(JSON.stringify(c))}</p>`).join('')}`)) return;
    await call(yz.resources.quickUse(id, current.activeId, {run: true}), '已加入任务队列。');
  }
}
async function plugins() {
  try {
    const r = await call(yz.resources.plugins());
    q('#rs-plugin-list').innerHTML = `<p class="muted">${r.manager?.installed ? `检测到 ComfyUI-Manager：${esc(r.manager.path ?? '')}（插件操作仍走映作的受限 Git 事务，便于备份与回滚）` : '未检测到 ComfyUI-Manager（使用受限 Git 方式安装/更新）'}</p>` + r.plugins.map(p => `<div class="row"><span>${esc(p.name)} <small class="muted">${p.enabled ? '已启用' : '已禁用'} · ${esc(p.version ?? p.git?.head?.slice(0, 8) ?? '版本未知')}${p.localChanges ? ' · 有本地修改' : ''} · ${p.loaded === 'loaded' ? `已加载 ${p.nodeTypes.length} 个节点` : p.loaded === 'not-loaded' ? '未被 ComfyUI 加载' : 'ComfyUI 未运行'}</small></span>
      ${p.enabled ? `<button data-p="disable" data-n="${esc(p.name)}">禁用</button>` : `<button data-p="enable" data-n="${esc(p.name)}">启用</button>`}${p.git ? `<button data-p="update" data-n="${esc(p.name)}">更新…</button>` : ''}<button data-p="remove" data-n="${esc(p.name)}">移除…</button></div>`).join('');
  } catch (e) { q('#rs-plugin-list').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function askRevision(title, hint) {
  return modal(`<h3>${esc(title)}</h3><p class="muted">${esc(hint)}</p><input id="rv" placeholder="提交哈希或标签，例如 v0.3.60"><label><input type="checkbox" id="rv-deps" checked> requirements.txt 变化时安装依赖</label><div class="actions"><button data-x="no">取消</button><button data-x="go" class="primary">备份并更新</button></div>`, (back, done) => back.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) done(b.dataset.x === 'go' && back.querySelector('#rv').value.trim() ? {revision: back.querySelector('#rv').value.trim(), updateDeps: back.querySelector('#rv-deps').checked} : null); }));
}
q('#rs-plugin-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-p]'); if (!b) return; const n = b.dataset.n;
  try {
    if (b.dataset.p === 'disable') report(await call(yz.resources.disablePlugin(n, '用户在资源页禁用')));
    else if (b.dataset.p === 'enable') report(await call(yz.resources.enablePlugin(n)));
    else if (b.dataset.p === 'update') { const o = await askRevision(`更新插件 ${n}`, '会先备份，本地修改保存为补丁并在更新后重放；冲突时保留补丁并列入待处理。'); if (o) report(await call(yz.maintenance.updatePlugin(n, o))); }
    else if (b.dataset.p === 'remove') {
      const pre = await call(yz.resources.removePlugin(n));
      if (!await confirmBox(`移除插件 ${n}`, `<p>插件目录会移到回收区，可手动恢复。</p>${pre.usedBy?.length ? `<p class="err">仍被使用：${pre.usedBy.map(esc).join('、')}</p>` : ''}${pre.note ? `<p class="muted">${esc(pre.note)}</p>` : ''}`)) return;
      report(await call(yz.resources.removePlugin(n, {confirm: true})));
    }
    plugins();
  } catch (er) { swallow(er); }
});
q('#rs-install').addEventListener('click', async () => {
  const o = await modal(`<h3>从 Git 地址安装插件</h3><p class="muted">只接受 https 地址。安装前会备份 custom_nodes，失败自动恢复。</p><input id="gi-url" placeholder="https://github.com/作者/仓库"><input id="gi-rev" placeholder="版本（可选：提交或标签）"><label><input type="checkbox" id="gi-deps"> 安装 requirements.txt 依赖（使用设置中的 ComfyUI Python，并备份 Python 环境）</label><div class="actions"><button data-x="no">取消</button><button data-x="go" class="primary">安装</button></div>`, (back, done) => back.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) done(b.dataset.x === 'go' ? {url: back.querySelector('#gi-url').value.trim(), revision: back.querySelector('#gi-rev').value.trim() || null, installDeps: back.querySelector('#gi-deps').checked} : null); }));
  if (!o?.url) return;
  try { report(await call(yz.resources.installPlugin(o))); plugins(); } catch (e) { swallow(e); }
});
async function backups() {
  const r = await call(yz.maintenance.backups());
  q('#rs-maint').innerHTML = r.backups.map(b => `<div class="row"><span>${esc(b.createdAt)} <small class="muted">${size(b.sizeBytes)} · ${b.sources.map(esc).join('、')}${b.inUse ? ' · 使用中' : ''}${r.prunable.includes(b.dir) ? ' · 可清理' : ''}</small></span><button data-b="verify" data-d="${esc(b.dir)}">校验</button><button data-b="restore" data-d="${esc(b.dir)}">恢复到此备份…</button></div>`).join('') || '<p class="muted">还没有备份。</p>';
}
async function pending() {
  const p = await call(yz.maintenance.pendingRestores());
  const holds = await call(yz.maintenance.holds()).catch(() => []);
  // D06：恢复失败后任务保持暂停、服务不自动启动，直到在这里完成恢复
  q('#rs-pending').innerHTML = holds.map(h => `<div class="row"><span class="err">维护 ${esc(h.id)} 恢复失败：任务提交已暂停，ComfyUI 未自动启动${h.stopped?.length ? `（已停止：${h.stopped.map(esc).join('、')}）` : ''}。请继续下面未完成的恢复，或从备份恢复。</span></div>`).join('') + p.map(j => `<div class="row"><span class="err">未完成的恢复 ${esc(j.id)}（${esc(j.status)}）</span><button data-resume="${esc(j.id)}">继续恢复</button></div>`).join('');
}
q('#rs-maint').addEventListener('click', async e => {
  const b = e.target.closest('[data-b]'); if (!b) return;
  try {
    if (b.dataset.b === 'verify') { const v = await call(yz.maintenance.verifyBackup(b.dataset.d)); toast(v.ok ? '备份完整。' : `备份有问题：${v.problems.join('；')}`, !v.ok); }
    else if (await confirmBox('恢复备份', '<p>会暂停队列、停止本应用启动的 ComfyUI，并把备份内容恢复到原位置；当前内容会先保留为现场副本。外部启动的 ComfyUI 需先手动关闭。</p>')) { const r = await call(yz.maintenance.restoreBackup(b.dataset.d)); toast(`恢复${r.status === 'done' ? '完成' : `状态：${r.status}`}`); }
  } catch (er) { swallow(er); }
});
q('#rs-pending').addEventListener('click', e => { const b = e.target.closest('[data-resume]'); if (b) call(yz.maintenance.resumeRestore(b.dataset.resume), '恢复已继续完成。').then(pending, swallow); });
q('#rs-scan').addEventListener('click', () => doScan());
q('#rs-models').addEventListener('click', e => { const b = e.target.closest('[data-detail]'); if (b) openDetail(b.dataset.detail).catch(swallow); });
q('#rs-refs').addEventListener('click', async () => {
  try { const r = await call(yz.resources.references()); q('#rs-maint').innerHTML = r.note ? `<p class="muted">${esc(r.note)}</p>` : r.ok ? '<p>所有引用的模型都能找到。</p>' : [...r.missing.map(m => `<p class="err">缺失：${esc(m.value)} ← ${esc(m.title)}</p>`), ...r.relocated.map(m => `<p>位置变化：${esc(m.value)} → 可能是 ${m.candidates.map(esc).join('、')}（${esc(m.title)}）</p>`)].join(''); } catch (e) { swallow(e); }
});
q('#rs-plugins').addEventListener('click', plugins);
q('#rs-backup').addEventListener('click', async () => { try { report(await call(yz.maintenance.createBackup())); } catch (e) { swallow(e); } });
q('#rs-backups').addEventListener('click', () => backups().catch(swallow));
q('#rs-prune').addEventListener('click', async () => { try { const r = await call(yz.maintenance.pruneBackups()); toast(`已把 ${r.moved.length} 份旧备份移到回收区。`); backups(); } catch (e) { swallow(e); } });
q('#rs-update-comfy').addEventListener('click', async () => { const o = await askRevision('更新 ComfyUI', '先在“服务与日志”里检查可用版本。会备份 ComfyUI（不含模型权重）和 Python 环境，本地修改（如 Gemma 补丁）保存为补丁并重放。'); if (o) try { report(await call(yz.maintenance.updateComfy(o))); } catch (e) { swallow(e); } });
q('#rs-tx').addEventListener('click', async () => { try { const t = await call(yz.maintenance.transactions()); q('#rs-maint').innerHTML = t.map(x => `<div class="row"><span>${esc(x.createdAt)} · ${esc(x.target?.title ?? x.scope)} <small class="muted">${esc(x.phase)}${x.error ? ` · ${esc(x.error.message)}` : ''}</small></span></div>`).join('') || '<p class="muted">没有维护记录。</p>'; } catch (e) { swallow(e); } });
q('#nav').addEventListener('click', e => { if (e.target.closest('[data-page="resources"]')) pending().catch(() => {}); });
})();

yz.events.subscribe(ev => { if (ev.type === 'maintenance.hold') { toast('维护恢复失败：任务已暂停、服务未启动。请到“资源与维护”完成恢复。', true); pending().catch(() => {}); } });
// R14：回收区（只显示本应用登记的条目；永久清理需确认，执行时再核对）
async function trashView() {
  const r = await call(yz.trash.list());
  q('#rs-maint').innerHTML = `<p class="muted">回收区共 ${size(r.bytes)}。永久清理不可撤销。</p><div class="actions"><button data-t="purge30">清理 30 天前的条目…</button></div>` + (r.items.map(e => `<div class="row"><span>${esc(e.kind)} · ${esc(e.origin)} <small class="muted">${size(e.bytes)}${e.exists ? '' : ' · 文件已不存在'}</small></span><button data-t="restore" data-id="${esc(e.id)}">恢复到原位置</button><button data-t="purge" data-id="${esc(e.id)}">永久删除…</button></div>`).join('') || '<p class="muted">回收区为空。</p>');
}
q('#rs-trash').addEventListener('click', () => trashView().catch(swallow));
q('#rs-maint').addEventListener('click', async e => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  try {
    if (b.dataset.t === 'restore') { await call(yz.trash.restore(b.dataset.id), '已恢复到原位置。'); return trashView(); }
    const opts = b.dataset.t === 'purge30' ? {olderThanDays: 30} : {ids: [b.dataset.id]};
    const plan = await call(yz.trash.planPurge(opts));
    if (!plan.items.length) { toast(plan.skipped.length ? `没有可清理的条目：${plan.skipped[0].reason}` : '没有可清理的条目。'); return; }
    if (!await confirmBox('永久清理', `<p>将永久删除 ${plan.items.length} 项，释放 ${size(plan.bytes)}。${plan.skipped.length ? `另有 ${plan.skipped.length} 项受保护被跳过。` : ''}</p>`)) return;
    const r = await call(yz.trash.purge({...opts, confirm: true}));
    toast(`已清理 ${r.purged.length} 项${r.skipped.length ? `，跳过 ${r.skipped.length} 项` : ''}。`); trashView();
  } catch (er) { swallow(er); }
});
