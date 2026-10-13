'use strict';
// O01–O07：在线搜索、文件选择与下载规划、下载列表（暂停/继续/取消）、在线模板导入。
(() => {
const yz = window.yingzuo, S = window.yzShell;
const q = s => document.querySelector(s);
const {esc, toast, call, swallow, modal} = S;
const size = b => b == null ? '大小未知' : b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b > 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
const ROLES = {diffusion: '图像主模型', encoder: '文本编码器', vae: 'VAE', lora: 'LoRA', checkpoint: '整合检查点', upscale: '放大模型', controlnet: 'ControlNet'};
let cursor = null, lastQuery = '';
async function search(more) {
  const provider = q('#on-provider').value, query = more ? lastQuery : q('#on-q').value.trim();
  if (!query) return; lastQuery = query;
  try {
    const r = await call(yz.downloads.search(provider, query, {cursor: more ? cursor : null, limit: 20}));
    cursor = r.nextCursor; q('#on-more').hidden = !cursor;
    const html = r.items.map(i => `<div class="row"><span>${esc(i.name)} <small class="muted">${provider === 'civitai' ? `${esc(i.type)} · ${esc(i.creator ?? '')}${i.nsfw ? ' · NSFW' : ''}` : `${i.downloads ?? 0} 下载${i.gated ? ' · 需同意许可' : ''}`}</small></span><button data-detail="${esc(i.id)}" data-provider="${provider}">查看文件</button></div>`).join('');
    q('#on-results').innerHTML = more ? q('#on-results').innerHTML + html : html || '<p class="muted">没有结果。</p>';
  } catch (e) { q('#on-results').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
q('#on-search').addEventListener('click', () => search(false));
q('#on-q').addEventListener('keydown', e => { if (e.key === 'Enter') search(false); });
q('#on-more').addEventListener('click', () => search(true));
q('#on-results').addEventListener('click', e => { const b = e.target.closest('[data-detail]'); if (b) openDetail(b.dataset.provider, b.dataset.detail).catch(swallow); });

async function openDetail(provider, id, preset = {}) {
  const d = await call(yz.downloads.detail(provider, provider === 'civitai' ? Number(id) : id, preset.revision ? {revision: preset.revision} : {}));
  const files = provider === 'civitai' ? d.versions.flatMap(v => v.files.map(f => ({...f, ref: {provider, versionId: v.id}, extra: `${v.name} · 底模 ${v.baseModel ?? '未知'}${v.trainedWords.length ? ` · 触发词 ${v.trainedWords.join(', ')}` : ''}`}))) : d.files.filter(f => f.isWeight).map(f => ({...f, ref: {provider, repo: d.id, revision: d.revision}, extra: ''}));
  const lic = provider === 'civitai' ? `商用：${esc(String(d.license.allowCommercialUse ?? '未知'))}` : `许可：${esc(d.license ?? '未标注')}${d.gated ? '（需在网站同意并配置凭据）' : ''} · revision ${esc(String(d.revision).slice(0, 12))}`;
  const pick = await modal(`<h3>${esc(d.name ?? d.id)}</h3><p class="muted">${lic}</p><div class="list scroll">${files.map((f, i) => `<div class="row"><span>${esc(f.path)} <small class="muted">${size(f.size)}${f.sizeApprox ? '（约）' : ''}${f.sha256 ? ' · 有 sha256' : ''}${f.role ? ` · 推测用途 ${ROLES[f.role]}` : ''}${f.extra ? ` · ${esc(f.extra)}` : ''}</small></span><button data-i="${i}" ${preset.path && preset.path !== f.path ? '' : ''}>下载此文件…</button></div>`).join('') || '<p class="muted">没有可识别的权重文件。</p>'}</div><div class="actions"><button data-x="close">关闭</button></div>`, (back, done) => back.addEventListener('click', ev => { const b = ev.target.closest('button'); if (b?.dataset.i) done(files[Number(b.dataset.i)]); else if (b?.dataset.x) done(null); }));
  if (pick) await planAndAdd(pick);
}
async function planAndAdd(file) {
  let role = file.role ?? '', customDir = null, plan = null;
  for (;;) {
    try { plan = await call(yz.downloads.plan({file, role: role || null, customDir})); } catch (e) { plan = {error: e.message}; }
    const act = await modal(`<h3>下载规划</h3><p>${esc(file.path)} · ${size(file.size)}</p><label>用途（决定 ComfyUI 模型子目录）</label><select id="p-role"><option value="">请选择</option>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${v}</option>`).join('')}</select>
      ${plan.error ? `<p class="err">${esc(plan.error)}</p>` : `<p>目标：${esc(plan.destination)}<br>剩余空间：${size(plan.freeBytes)}</p>${plan.notes.map(n => `<p class="muted">• ${esc(n)}</p>`).join('')}`}
      <div class="actions"><button data-x="dir">选择其他目录…</button><button data-x="no">取消</button><button data-x="go" class="primary" ${plan.canDownload ? '' : 'disabled'}>开始下载</button></div>`, (back, done) => {
      back.querySelector('#p-role').addEventListener('change', ev => done({role: ev.target.value}));
      back.addEventListener('click', ev => { const b = ev.target.closest('[data-x]'); if (b) done({x: b.dataset.x}); });
    });
    if (act.role !== undefined) { role = act.role; continue; }
    if (act.x === 'dir') { const r = await call(yz.downloads.pickDir()).catch(() => ({cancelled: true})); if (!r.cancelled) customDir = r.dir; continue; }
    if (act.x === 'go') { await call(yz.downloads.add({ref: file.ref, file, role: role || null, customDir}), '已加入下载。').catch(swallow); refreshDownloads(); }
    return;
  }
}
q('#on-link').addEventListener('click', async () => {
  const link = await modal(`<h3>粘贴模型链接</h3><input id="l-in" placeholder="https://huggingface.co/… 或 https://civitai.com/models/…"><div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">解析</button></div>`, (back, done) => back.addEventListener('click', ev => { const b = ev.target.closest('[data-x]'); if (b) done(b.dataset.x === 'yes' ? back.querySelector('#l-in').value : null); }));
  if (!link) return;
  try { const r = await call(yz.downloads.parseLink(link)); if (r.provider === 'huggingface') await openDetail('huggingface', r.repo, {revision: r.revision, path: r.path}); else if (r.modelId) await openDetail('civitai', r.modelId); else toast('链接只包含版本号，请使用模型页面链接。', true); } catch (e) { swallow(e); }
});
/* ---------- 下载列表 ---------- */
const DL = {queued: '等待', downloading: '下载中', paused: '已暂停', verifying: '校验中', completed: '已完成', failed: '失败', cancelled: '已取消', planned: '已规划'};
async function refreshDownloads() {
  let list; try { list = await call(yz.downloads.list()); } catch { return; }
  q('#dl-list').innerHTML = list.map(d => `<div class="task"><span class="badge ${d.state === 'completed' ? 'ok' : d.state === 'failed' ? 'bad' : 'warn'}">${DL[d.state] ?? d.state}</span><div><div>${esc(d.destination)}</div><div class="meta">${size(d.receivedBytes)} / ${size(d.totalBytes)}${d.verification ? ` · sha256 ${d.verification.matchedExpected ? '已与来源核对' : '已计算（来源未提供）'}` : ''}</div>${d.error ? `<div class="err">${esc(d.error.message)}</div>` : ''}</div><div class="actions">${['queued', 'downloading'].includes(d.state) ? `<button data-dpause="${d.id}">暂停</button>` : ''}${['paused', 'failed'].includes(d.state) ? `<button data-dresume="${d.id}">继续</button>` : ''}${!['completed', 'cancelled'].includes(d.state) ? `<button data-dcancel="${d.id}">取消</button>` : ''}</div></div>`).join('') || '<p class="muted">没有下载。</p>';
}
q('#dl-list').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try { if (b.dataset.dpause) await call(yz.downloads.pause(b.dataset.dpause)); if (b.dataset.dresume) await call(yz.downloads.resume(b.dataset.dresume)); if (b.dataset.dcancel) await call(yz.downloads.cancel(b.dataset.dcancel)); } catch (err) { swallow(err); }
  refreshDownloads();
});
let t; yz.events.subscribe(ev => { if (ev.type.startsWith('downloads.')) { clearTimeout(t); t = setTimeout(refreshDownloads, 300); } });
q('#nav').addEventListener('click', e => { if (e.target.closest('[data-page="online"]')) refreshDownloads(); });
/* ---------- O07 在线模板 ---------- */
q('#tpl-online').addEventListener('click', async () => {
  const link = await modal(`<h3>从链接导入模板</h3><p class="muted">支持 Hugging Face 文件链接、GitHub 文件链接或其他 https JSON 地址。只下载 JSON，不安装插件、不下载模型。</p><input id="t-in" placeholder="https://…/workflow.json"><div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">导入</button></div>`, (back, done) => back.addEventListener('click', ev => { const b = ev.target.closest('[data-x]'); if (b) done(b.dataset.x === 'yes' ? back.querySelector('#t-in').value : null); }));
  if (link) call(yz.templates.importOnline(link), d => `已导入：${d.template.name}（${d.template.license ? `许可 ${d.template.license}` : '许可未标注'}）。${d.notes[0]}`).catch(swallow);
});
/* ---------- T08/O08 补齐依赖（模型部分） ---------- */
q('#deps').addEventListener('click', async () => {
  const tab = typeof current === 'object' && current?.activeId; if (!tab) { toast('请先打开工作流。', true); return; }
  let plan; try { plan = await call(yz.templates.dependencyPlan(tab)); } catch (e) { swallow(e); return; }
  const chosen = new Map(); const found = new Map();
  for (;;) {
    const html = `<h3>补齐依赖</h3><p class="muted">Manager：${plan.manager.installed ? `已安装 ${esc(plan.manager.version ?? '')}` : esc(plan.manager.reason)}</p>
      <h4>缺失模型（${plan.models.length}）</h4>${plan.models.map((m, i) => `<div class="row block"><strong>${esc(m.name)}</strong> <small>${esc(m.role)} → models/${esc(m.folder ?? '?')} · 节点 ${m.nodes.map(esc).join(', ')}</small>${m.localCandidates.length ? `<br><small>本机已有可替换候选：${m.localCandidates.map(esc).join('、')}（可在“诊断”里应用）</small>` : ''}<br>${found.has(i) ? (found.get(i).length ? found.get(i).map((s, j) => `<label><input type="radio" name="src${i}" data-m="${i}" data-s="${j}" ${chosen.get(i) === j ? 'checked' : ''}> ${esc(s.repo)}@${esc(String(s.revision).slice(0, 8))} · ${size(s.size)}${s.sha256 ? ' · sha256' : ''}${s.gated ? ' · 需许可' : ''} · ${esc(s.license ?? '许可未标注')}</label><br>`).join('') : '<small class="err">没有找到同名文件的可靠来源，请手动下载。</small>') : `<button data-find="${i}">查找来源</button>`}</div>`).join('') || '<p class="muted">无。</p>'}
      <h4>缺失节点/其他（${plan.nodes.length}）</h4>${plan.nodes.map(n => `<div class="row block"><strong>${esc(n.nodeType)}</strong><br><small>${esc(n.reason)}</small></div>`).join('') || '<p class="muted">无。</p>'}
      <div class="actions"><button data-x="close">关闭</button><button data-x="go" class="primary" ${chosen.size ? '' : 'disabled'}>下载所选（${chosen.size}）</button></div>`;
    const act = await modal(html, (back, done) => { back.addEventListener('click', ev => { const b = ev.target.closest('button'); if (b?.dataset.find) done({find: Number(b.dataset.find)}); else if (b?.dataset.x) done({x: b.dataset.x}); }); back.addEventListener('change', ev => { const r = ev.target.closest('[data-m]'); if (r) { chosen.set(Number(r.dataset.m), Number(r.dataset.s)); done({}); } }); });
    if (act.find !== undefined) { try { found.set(act.find, await call(yz.templates.findModelSources(plan.models[act.find].name))); } catch (e) { swallow(e); found.set(act.find, []); } continue; }
    if (act.x === 'go') {
      const items = [...chosen].map(([i, j]) => ({name: plan.models[i].name, role: plan.models[i].role, source: found.get(i)[j]}));
      try { const r = await call(yz.templates.applyDependencyPlan(items)); await modal(`<h3>补齐结果</h3>${r.results.map(x => `<p>${x.ok ? '✓' : '✗'} ${esc(x.name)} ${x.ok ? '已加入下载' : esc(x.error)}</p>`).join('')}<p class="muted">${esc(r.note)}</p><div class="actions"><button data-x="ok" class="primary">好</button></div>`, (back, done) => back.addEventListener('click', ev => { if (ev.target.closest('[data-x]')) done(); })); } catch (e) { swallow(e); }
      return;
    }
    if (act.x === 'close') return;
  }
});
})();
