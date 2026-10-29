'use strict';
// T01–T04：模板库页面、存为模板、表单设置（字段名称/分组/顺序/范围、映射失效与重新绑定）。
(() => {
const yz = window.yingzuo, S = window.yzShell;
const q = s => document.querySelector(s);
const {esc, toast, call, swallow, modal} = S;
const STATUS = {ok: '正常', 'missing-node': '节点已删除', 'type-changed': '节点类型变化', 'missing-field': '字段不存在', linked: '已改为连线'};
let list = [];
async function refresh() {
  try {
    const r = await call(yz.templates.list({search: q('#tpl-search').value, folder: q('#tpl-folder').value || null, favorite: q('#tpl-fav').checked}));
    list = r.templates;
    const sel = q('#tpl-folder'), cur = sel.value;
    sel.innerHTML = '<option value="">全部文件夹</option>' + r.folders.map(f => `<option ${f === cur ? 'selected' : ''}>${esc(f)}</option>`).join('');
    q('#tpl-list').innerHTML = list.length ? list.map(t => `<div class="task">${t.thumbnail ? `<img class="tpl-thumb" data-thumb="${t.id}" alt="" width="64" height="64">` : '<span class="tpl-thumb muted">无图</span>'}<span class="badge ${t.favorite ? 'ok' : ''}">${t.favorite ? '★ 收藏' : esc(t.folder || '未分组')}</span>
      <div><div>${esc(t.name)}</div><div class="meta">${esc(t.folder)} ${t.tags.map(x => `#${esc(x)}`).join(' ')} · 更新于 ${esc(new Date(t.updatedAt).toLocaleString())}${t.license ? ` · 许可 ${esc(t.license)}` : ''}</div></div>
      <div class="actions"><button data-open="${t.id}" class="primary">打开</button><button data-fav="${t.id}">${t.favorite ? '取消收藏' : '收藏'}</button><button data-edit="${t.id}">信息</button><button data-versions="${t.id}">版本</button><button data-export="${t.id}">导出</button><button data-thumbset="${t.id}">设缩略图</button></div></div>`).join('') : '<div class="empty-state"><h3>还没有模板</h3><p>可以导入 JSON、导入内置模板，或在创作页「存为模板」。</p></div>';
    // T01：缩略图按需读取（首个成功输出自动生成，或手动选择图片）
    for (const img of document.querySelectorAll('#tpl-list [data-thumb]')) yz.templates.thumbnail(img.dataset.thumb).then(r => { if (r?.ok && r.data.dataUrl) img.src = r.data.dataUrl; }, () => {});
  } catch (e) { /* call 已提示 */ }
}
q('#tpl-list')?.addEventListener('click', e => { const b = e.target.closest('[data-thumbset]'); if (b) call(yz.templates.setThumbnail(b.dataset.thumbset), d => (d?.cancelled ? '已取消。' : '缩略图已更新。')).then(refresh, () => {}); });
/* O07/S10：在线模板库浏览——搜索、分类、分页、缩略图、详情；导入后走同一诊断入口 */
q('#tpl-browse')?.addEventListener('click', async () => {
  let sources; try { sources = await call(yz.templates.onlineSources()); } catch { return; }
  const st = {source: sources[0]?.id, query: '', category: '', offset: 0, refresh: false};
  await modal('<h3>在线模板库</h3><div class="actions"><select id="ob-src"></select><input id="ob-q" placeholder="搜索标题、标签、模型"><select id="ob-cat"><option value="">全部分类</option></select><button id="ob-refresh" title="重新下载索引">刷新索引</button></div><p id="ob-info" class="muted"></p><div id="ob-list" class="list scroll"></div><div class="actions"><button id="ob-prev">上一页</button><button id="ob-next">下一页</button><button data-x="close" class="primary">关闭</button></div>', (back, done) => {
    const $ = s2 => back.querySelector(s2);
    $('#ob-src').innerHTML = sources.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    let page = null, seq = 0;
    const load = async () => {
      const my = ++seq; $('#ob-info').textContent = '正在读取模板源…';
      let r; try { r = await call(yz.templates.browseOnline(st.source, {query: st.query, category: st.category || null, offset: st.offset, limit: 24, refresh: st.refresh})); } catch { $('#ob-info').textContent = '读取失败。'; return; }
      st.refresh = false; if (my !== seq) return; page = r;
      const cur = $('#ob-cat').value; $('#ob-cat').innerHTML = '<option value="">全部分类</option>' + r.categories.map(c => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('');
      $('#ob-info').textContent = `${r.source.name}：共 ${r.total} 个（${r.offset + 1}–${Math.min(r.total, r.offset + r.limit)}）· 索引时间 ${new Date(r.cachedAt).toLocaleString()}${r.stale ? ` · 网络不可用，显示缓存（${r.error}）` : ''}`;
      $('#ob-list').innerHTML = r.items.map(it => `<div class="task"><img class="tpl-thumb" data-othumb="${esc(it.name)}" alt="" width="64" height="64"><div><div>${esc(it.title)}${it.openSource ? '' : ' <span class="badge">API/付费</span>'}</div><div class="meta">${esc(it.category)} · ${it.tags.map(esc).join(' · ')}${it.models.length ? ` · 模型：${it.models.map(esc).join('、')}` : ''}${it.minComfyUIVersion ? ` · 需 ComfyUI ≥ ${esc(it.minComfyUIVersion)}` : ''}</div><div class="meta">${esc(it.description)}</div></div><div class="actions"><button data-oimport="${esc(it.name)}" class="primary">导入</button></div></div>`).join('') || '<div class="empty-state"><h3>没有匹配的模板</h3><p>换个关键词，或刷新在线索引后再试。</p></div>';
      $('#ob-prev').disabled = r.offset === 0; $('#ob-next').disabled = r.nextOffset === null;
      for (const img of back.querySelectorAll('[data-othumb]')) yz.templates.onlineThumbnail(st.source, img.dataset.othumb).then(x => { if (my === seq && x?.ok && x.data.dataUrl) img.src = x.data.dataUrl; }, () => {});
    };
    let t2; $('#ob-q').addEventListener('input', () => { clearTimeout(t2); t2 = setTimeout(() => { st.query = $('#ob-q').value; st.offset = 0; load(); }, 300); });
    $('#ob-cat').addEventListener('change', () => { st.category = $('#ob-cat').value; st.offset = 0; load(); });
    $('#ob-src').addEventListener('change', () => { st.source = $('#ob-src').value; st.offset = 0; load(); });
    $('#ob-refresh').addEventListener('click', () => { st.refresh = true; load(); });
    $('#ob-prev').addEventListener('click', () => { st.offset = Math.max(0, st.offset - 24); load(); });
    $('#ob-next').addEventListener('click', () => { if (page?.nextOffset != null) { st.offset = page.nextOffset; load(); } });
    back.addEventListener('click', async e => {
      const imp = e.target.closest('[data-oimport]'); if (imp) { imp.disabled = true; try { const r = await call(yz.templates.importFromSource(st.source, imp.dataset.oimport), d => `已导入「${d.template.name}」。${d.notes.join(' ')}`); imp.textContent = '已导入'; refresh(); } catch { imp.disabled = false; } }
      if (e.target.closest('[data-x]')) done(null);
    });
    load();
  });
});
let timer; q('#tpl-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 200); });
q('#tpl-folder').addEventListener('change', refresh); q('#tpl-fav').addEventListener('change', refresh);
q('#nav').addEventListener('click', e => { if (e.target.closest('[data-page="templates"]')) refresh(); });
q('#tpl-import').addEventListener('click', () => call(yz.templates.import({}), d => d.cancelled ? '已取消。' : `导入 ${d.imported.length} 个${d.failed.length ? `，${d.failed.length} 个失败：${d.failed[0].error}` : ''}`).then(refresh, swallow));
q('#tpl-builtins').addEventListener('click', () => call(yz.templates.importBuiltins(), d => d.map(x => `${x.id}：${{imported: '已导入', exists: '已存在', missing: '找不到文件（请在设置中配置工作流目录）', failed: `失败 ${x.error}`}[x.status]}`).join('；')).then(refresh, swallow));
q('#tpl-list').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.dataset.open ?? b.dataset.fav ?? b.dataset.edit ?? b.dataset.versions ?? b.dataset.export;
  const t = list.find(x => x.id === id);
  try {
    if (b.dataset.open) { await call(yz.templates.open(id)); S.showPage('create'); }
    if (b.dataset.fav) { await call(yz.templates.update(id, {favorite: !t.favorite})); refresh(); }
    if (b.dataset.export) await call(yz.templates.export(id), d => d.cancelled ? '已取消。' : `已导出：${d.path}`);
    if (b.dataset.edit) {
      const patch = await modal(`<h3>模板信息</h3><label>名称</label><input id="m-name" value="${esc(t.name)}"><label>文件夹（用 / 分层）</label><input id="m-folder" value="${esc(t.folder)}"><label>标签（逗号分隔）</label><input id="m-tags" value="${esc(t.tags.join('，'))}"><div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">保存</button></div>`, (back, done) => back.addEventListener('click', ev => { const x = ev.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes' ? {name: back.querySelector('#m-name').value, folder: back.querySelector('#m-folder').value, tags: back.querySelector('#m-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean)} : null); }));
      if (patch) { await call(yz.templates.update(id, patch), '已保存。'); refresh(); }
    }
    if (b.dataset.versions) {
      const d = await call(yz.templates.get(id));
      await modal(`<h3>${esc(d.name)} · 版本</h3><div class="list">${d.versions.map((v, i) => `<div class="row"><span>${esc(new Date(v.savedAt).toLocaleString())} · ${esc(v.note ?? v.source)}${i === 0 ? '（当前）' : ''}${v.hasForm ? ' · 含表单' : ''}</span><span><button data-vopen="${v.versionId}">打开此版</button>${i ? `<button data-vrestore="${v.versionId}">恢复为当前</button>` : ''}<button data-vexport="${v.versionId}">导出</button></span></div>`).join('')}</div><div class="actions"><button data-x="close">关闭</button></div>`, (back, done) => back.addEventListener('click', async ev => {
        const x = ev.target.closest('button'); if (!x) return;
        try {
          if (x.dataset.vopen) { await call(yz.templates.open(id, x.dataset.vopen)); done(); S.showPage('create'); }
          if (x.dataset.vrestore) { await call(yz.templates.restore(id, x.dataset.vrestore), '已恢复为新版本（历史保留）。'); done(); refresh(); }
          if (x.dataset.vexport) await call(yz.templates.export(id, x.dataset.vexport), r => r.cancelled ? '已取消。' : `已导出：${r.path}`);
          if (x.dataset.x) done();
        } catch (err) { swallow(err); }
      }));
    }
  } catch (err) { swallow(err); }
});
/* ---------- 创作页：存为模板、表单设置 ---------- */
const activeTab = () => (typeof current === 'object' && current?.tabs?.find(t => t.id === current.activeId)) || null;
q('#tpl-save').addEventListener('click', async () => {
  const tab = activeTab(); if (!tab) { toast('请先打开工作流。', true); return; }
  const fromTemplate = tab.templateId && tab.templateId.startsWith('tpl_');
  const r = await modal(`<h3>存为模板</h3>${fromTemplate ? '<p class="muted">此标签来自模板：可以保存为该模板的新版本（旧版本保留），或另存为新模板。</p>' : '<p class="muted">将创建新模板，原工作副本不受影响。</p>'}<label>名称</label><input id="s-name" value="${esc(tab.title)}"><label>版本说明</label><input id="s-note" placeholder="可选"><div class="actions"><button data-x="no">取消</button>${fromTemplate ? '<button data-x="new">另存为新模板</button><button data-x="ver" class="primary">保存新版本</button>' : '<button data-x="new" class="primary">创建模板</button>'}</div>`, (back, done) => back.addEventListener('click', ev => { const x = ev.target.closest('[data-x]'); if (x) done(x.dataset.x === 'no' ? null : {asNew: x.dataset.x === 'new', name: back.querySelector('#s-name').value, note: back.querySelector('#s-note').value || undefined}); }));
  if (r) call(yz.templates.saveFromTab(tab.id, r), d => `已保存：${d.template.name}`).catch(swallow);
});
q('#tpl-form').addEventListener('click', async () => {
  const tab = activeTab(); if (!tab) { toast('请先打开工作流。', true); return; }
  const tplId = tab.templateId?.startsWith('tpl_') ? tab.templateId : null;
  if (!tplId) { toast('表单随模板版本保存：请先“存为模板”，再从模板库打开后设置表单。', true); return; }
  let d; try { d = await call(yz.templates.formDraft(tplId, tab.id)); } catch (e) { swallow(e); return; }
  let fields = d.fields.map(f => ({...f}));
  const row = (f, i) => { const m = d.mapping[i]; return `<div class="row" data-i="${i}"><span><input data-k="label" value="${esc(f.label ?? f.fieldName)}" class="w110"> <input data-k="group" value="${esc(f.group ?? '')}" placeholder="分组" class="w70"> <input data-k="order" type="number" value="${f.order ?? i}" class="w50"> <small>${esc(f.nodeType)} #${esc(f.nodeId)} · ${esc(f.fieldName)}</small>${m && m.status !== 'ok' ? `<br><small class="err">${esc(STATUS[m.status])}：${esc(m.reason)}${m.candidates.length ? ` 可重新绑定到：${m.candidates.map(c => `<button data-rebind="${esc(c)}">#${esc(c)}</button>`).join('')}` : ''}</small>` : ''}</span><span>${['int', 'float', 'seed', 'number'].includes(f.widgetType) ? `<input data-k="min" type="number" value="${f.constraints?.min ?? ''}" placeholder="最小" class="w60"><input data-k="max" type="number" value="${f.constraints?.max ?? ''}" placeholder="最大" class="w60">` : ''}<button data-del="${i}">移除</button></span></div>`; };
  const html = () => `<h3>表单设置 · ${esc(tab.title)}</h3><p class="muted">${d.fromSaved ? '已保存的表单' : '根据当前工作流推断的默认表单'}；保存后连同当前图成为模板新版本。${d.baseVersionId && d.latestVersionId && d.baseVersionId !== d.latestVersionId ? '<br>起点是此标签固定的版本（不是模板最新版）；保存后此标签固定到新版本。' : ''}</p><div id="f-list" class="list scroll">${fields.map(row).join('')}</div>
    <label>添加字段</label><select id="f-add"><option value="">选择未连线的输入…</option>${d.available.map((a, i) => `<option value="${i}">${esc(a.nodeType)} #${esc(a.nodeId)} · ${esc(a.fieldName)}</option>`).join('')}</select>
    <div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">保存为新版本</button></div>`;
  const result = await modal(html(), (back, done) => {
    const sync = () => back.querySelectorAll('[data-i]').forEach(el => { const f = fields[Number(el.dataset.i)]; el.querySelectorAll('[data-k]').forEach(inp => { const k = inp.dataset.k, v = inp.value; if (k === 'order') f.order = Number(v) || 0; else if (k === 'min' || k === 'max') { f.constraints = {...f.constraints}; if (v === '') delete f.constraints[k]; else f.constraints[k] = Number(v); } else f[k] = v; }); });
    const rerender = () => { back.querySelector('.modal').innerHTML = html(); };
    back.addEventListener('change', ev => { if (ev.target.id === 'f-add' && ev.target.value !== '') { sync(); const a = d.available[Number(ev.target.value)]; fields.push({scopePath: [], nodeId: a.nodeId, nodeType: a.nodeType, fieldName: a.fieldName, widgetType: typeof a.value === 'number' ? (Number.isInteger(a.value) ? 'int' : 'float') : typeof a.value === 'boolean' ? 'boolean' : 'string', constraints: {}, label: a.fieldName, group: '其他', order: fields.length, defaultValue: a.value}); d.mapping.push({status: 'ok'}); rerender(); } });
    back.addEventListener('click', async ev => {
      const x = ev.target.closest('button'); if (!x) return;
      if (x.dataset.del !== undefined) { sync(); fields.splice(Number(x.dataset.del), 1); d.mapping.splice(Number(x.dataset.del), 1); rerender(); }
      if (x.dataset.rebind) { sync(); const i = Number(x.closest('[data-i]').dataset.i); fields[i] = {...fields[i], nodeId: x.dataset.rebind}; d.mapping[i] = {status: 'ok'}; rerender(); }
      if (x.dataset.x) { sync(); done(x.dataset.x === 'yes'); }
    });
  });
  if (result) call(yz.templates.saveForm(tplId, tab.id, fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))), '表单已保存为模板新版本。').catch(swallow);
});
/* ---------- T05–T07 诊断与修复 ---------- */
const SRC = {objectInfo: 'ComfyUI 节点', models: 'ComfyUI 模型目录', lmstudio: 'LM Studio'};
async function diagnose(refresh) {
  const tab = activeTab(); if (!tab) { toast('请先打开工作流。', true); return; }
  let r; try { r = await call(yz.templates.diagnose(tab.id, {refresh})); } catch (e) { swallow(e); return; }
  let canUndo = false;
  for (;;) {
    const src = Object.entries(r.catalog.sources).map(([k, v]) => `${SRC[k]}：${v.ok ? `实时 · ${new Date(v.collectedAt).toLocaleTimeString()}` : v.cached ? `离线，使用缓存（${v.collectedAt ? new Date(v.collectedAt).toLocaleString() : '时间未知'}）` : `不可用（${esc(v.error)}）`}`).join('<br>');
    const issues = r.issues.map(i => `<div class="row block"><strong>${i.severity === 'error' ? '⛔' : '⚠'} ${esc(i.title)}</strong> <small>${esc(i.nodeTitle ?? '')} #${esc(i.nodeId ?? '')}${i.scope ? ` · ${esc(i.scope)}` : ''}${i.field ? ` · ${esc(i.field)}` : ''}</small><br><small>${esc(i.reason)} ${esc(i.advice ?? '')}</small>${i.value ? `<br><small>当前值：${esc(i.value)}</small>` : ''}${(i.candidates ?? []).map(c => `<div><small>→ ${esc(c.value)}（${esc(c.label)}；${esc(c.reason)}）</small>${c.canApply ? ` <button data-fix="${esc(i.key)}" data-cand="${esc(c.id)}">应用此替换</button>` : ''}</div>`).join('')}</div>`).join('') || '<p>没有发现问题。</p>';
    const act = await modal(`<h3>诊断 · ${esc(tab.title)}</h3><p class="muted">${src}</p><p>检查 ${r.nodeCount} 个节点、${r.checkedModels} 个模型引用：${r.errors} 个错误，${r.reviews} 个待核实。</p><div class="list scroll">${issues}</div><div class="actions"><button data-x="refresh">重新采集</button>${canUndo ? '<button data-x="undo">撤销上次修复</button>' : ''}<button data-x="export">导出修复副本</button><button data-x="close" class="primary">关闭</button></div>`, (back, done) => back.addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; if (b.dataset.fix) done({fix: b.dataset.fix, cand: b.dataset.cand}); else if (b.dataset.x) done({x: b.dataset.x}); }));
    try {
      if (act.fix) { const cur = (current.tabs.find(x => x.id === tab.id) || {}).revision; const res = await call(yz.templates.applyFix(tab.id, act.fix, act.cand, cur), d => `已修改 ${d.applied.field}：${d.applied.before} → ${d.applied.after}`); r = res.recheck; canUndo = true; continue; }
      if (act.x === 'undo') { const res = await call(yz.templates.undoFix(tab.id), '已撤销。'); r = res.recheck; canUndo = res.canUndo; continue; }
      if (act.x === 'refresh') { r = await call(yz.templates.diagnose(tab.id, {refresh: true})); continue; }
      if (act.x === 'export') { await call(yz.templates.exportFixed(tab.id), d => d.cancelled ? '已取消。' : `已导出：${d.path}`); continue; }
    } catch (e) { swallow(e); continue; }
    return;
  }
}
q('#diag').addEventListener('click', () => diagnose(true));
})();
