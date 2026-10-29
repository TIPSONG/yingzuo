'use strict';
// A04 作品浏览与查看器、A08 收藏板。只通过 assets.* 接口按 ID 操作，不传任意路径。
(() => {
const yz = window.yingzuo, S = window.yzShell;
const q = s => document.querySelector(s);
const {esc, toast, call, swallow, modal} = S;
const size = b => b == null ? '' : b > 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
let tab = 'all', offset = 0, items = [];
const thumbCache = new Map();
async function thumb(id, px = 256) {
  const k = `${id}:${px}`;
  if (!thumbCache.has(k)) thumbCache.set(k, yz.assets.thumbnail(id, {size: px}).then(r => r?.ok ? r.data.dataUrl : null, () => null));
  return thumbCache.get(k);
}
async function fillThumbs(root) {
  for (const el of root.querySelectorAll('[data-thumb]')) {
    const url = await thumb(el.dataset.thumb, Number(el.dataset.px || 256));
    el.innerHTML = url ? `<img alt="" src="${url}">` : '<span class="muted">无缩略图</span>';
  }
}
async function loadAll(more = false) {
  if (!more) { offset = 0; items = []; }
  try {
    const r = await call(yz.assets.list({offset, limit: 60, query: q('#as-q').value.trim()}));
    items.push(...r.items); offset += r.items.length;
    q('#as-count').textContent = `共 ${r.total ?? items.length} 张`;
    q('#as-more').hidden = r.nextOffset == null;
    q('#as-grid').innerHTML = items.map(a => `<div class="asset-card" data-asset="${esc(a.id)}"><div class="thumb" data-thumb="${esc(a.id)}">${a.kind === 'image' ? '…' : esc(a.format ?? a.kind)}</div><div class="cap" title="${esc(a.path)}">${esc(a.name)} <small class="muted">${a.width ? `${a.width}×${a.height}` : ''}${a.taskId ? ' · 任务' : ''}</small></div></div>`).join('') || '<div class="empty-state"><h3>还没有作品</h3><p>点击“扫描输出目录”，或在创作页运行任务后自动出现。</p></div>';
    fillThumbs(q('#as-grid'));
  } catch (e) { q('#as-grid').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function loadBoard() {
  const board = q('#as-board');
  try {
    const r = await call(yz.assets.favorites({limit: 500}));
    const width = Math.max(320, board.clientWidth || q('#page-assets .page-body').clientWidth - 20);
    const lay = await call(yz.assets.favoriteLayout({width, rowHeight: 220, gap: 8}));
    const byId = new Map(r.items.map(i => [i.id, i]));
    q('#as-count').textContent = `收藏 ${r.total} 张${r.items.some(i => i.broken) ? `（${r.items.filter(i => i.broken).length} 张收藏文件丢失）` : ''}`;
    board.style.height = `${lay.height}px`;
    board.innerHTML = lay.cells.map(c => { const f = byId.get(c.id); return `<div class="cell" data-cell="${esc(c.id)}" title="${esc(f.storedPath)}${f.sourceMissing ? '（原图已删除，收藏副本仍在）' : ''}"><div class="fill" data-fav-thumb="${esc(`favorite:${f.id}`)}"></div><button data-unfav="${esc(f.id)}">取消收藏</button></div>`; }).join('') || '<div class="empty-state"><h3>还没有收藏</h3><p>在作品查看器中点“收藏”。</p></div>';
    // CSP 禁止内联 style 属性：位置用 CSSOM 设置
    const cells = new Map(lay.cells.map(c => [c.id, c]));
    for (const el of board.querySelectorAll('[data-cell]')) { const c = cells.get(el.dataset.cell); Object.assign(el.style, {left: `${c.x}px`, top: `${c.y}px`, width: `${c.width}px`, height: `${c.height}px`}); }
    for (const el of board.querySelectorAll('[data-fav-thumb]')) { const id = el.dataset.favThumb; const url = id ? await thumb(id, 512) : null; el.innerHTML = url ? `<img alt="" src="${url}">` : '<span class="muted">缩略图不可用</span>'; }
  } catch (e) { board.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function show(which) {
  tab = which;
  q('#as-tab-all').classList.toggle('primary', which === 'all'); q('#as-tab-fav').classList.toggle('primary', which === 'fav');
  q('#as-grid').hidden = which !== 'all'; q('#as-board').hidden = which !== 'fav'; q('#as-q').hidden = which !== 'all'; q('#as-more').hidden = true;
  return which === 'all' ? loadAll() : loadBoard();
}
async function openViewer(id) {
  const a = await call(yz.assets.get(id));
  const url = a.kind === 'image' ? await thumb(id, 1024) : null;
  const g = a.generation;
  const share = await yz.assets.shareSupport(id).then(r => r?.ok ? r.data : {supported: false, reason: r?.error?.message}, () => ({supported: false}));
  const meta = `<h3>${esc(a.name)}</h3><p class="muted">${esc(a.path)}<br>${a.width ? `${a.width}×${a.height} · ` : ''}${size(a.size)} · ${esc(a.format ?? '')}</p>
    ${g.prompts.length ? `<p><b>提示词</b><br>${g.prompts.map(p => esc(typeof p === 'string' ? p : p.text ?? JSON.stringify(p))).join('<br>')}</p>` : ''}
    ${g.seed != null ? `<p>seed：${esc(String(g.seed))}</p>` : ''}${g.checkpoints.length ? `<p>模型：${g.checkpoints.map(esc).join('、')}</p>` : ''}
    ${a.task ? `<p>来自任务 ${esc(a.task.id)}（${esc(a.task.state ?? '记录缺失')}）</p>` : ''}
    ${a.missingFields.length ? `<p class="muted">缺少：${a.missingFields.map(esc).join('、')}（如实显示，不推测）</p>` : ''}${a.readError ? `<p class="err">${esc(a.readError)}</p>` : ''}
    <div class="actions"><button data-v="fav" class="primary" ${a.favoriteId ? 'disabled' : ''}>${a.favoriteId ? '已收藏' : '收藏'}</button><button data-v="open">用系统程序打开</button><button data-v="reveal">在文件夹中显示</button><button data-v="export">导出原图…</button><button data-v="share" ${share.supported ? '' : `disabled title="${esc(share.reason ?? '')}"`}>导出分享副本…</button><button data-v="close">关闭</button></div>
    <p class="muted">滚轮缩放 · 拖动平移 · 0 适应 · 1 原始比例 · Esc 关闭</p>`;
  await modal(`<div class="viewer"><div class="stage">${url ? `<img alt="" src="${url}" draggable="false">` : '<span class="muted">无法预览</span>'}</div><div class="meta">${meta}</div></div>`, (back, done) => {
    const img = back.querySelector('.stage img'), stage = back.querySelector('.stage');
    let z = 1, x = 0, y = 0, drag = null;
    const apply = () => { if (img) img.style.transform = `translate(${x}px,${y}px) scale(${z})`; };
    const fit = () => { if (!img) return; z = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight, 1); x = y = 0; apply(); };
    img?.addEventListener('load', fit);
    stage.addEventListener('wheel', e => { e.preventDefault(); z = Math.max(0.05, Math.min(16, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); apply(); }, {passive: false});
    stage.addEventListener('pointerdown', e => { drag = {sx: e.clientX - x, sy: e.clientY - y}; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', e => { if (drag) { x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply(); } });
    stage.addEventListener('pointerup', () => { drag = null; });
    const key = e => { if (e.key === '0') fit(); else if (e.key === '1') { z = 1; x = y = 0; apply(); } else if (e.key === 'Escape') done(null); else if (e.key === '+' || e.key === '=') { z *= 1.15; apply(); } else if (e.key === '-') { z /= 1.15; apply(); } };
    document.addEventListener('keydown', key);
    const run = async (fn, msg) => { try { const r = await call(fn()); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); } catch (e) { swallow(e); } };
    back.addEventListener('click', e => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      const v = b.dataset.v;
      if (v === 'close') { document.removeEventListener('keydown', key); done(null); }
      else if (v === 'fav') run(() => yz.assets.favorite(id), r => r.duplicate ? '已在收藏中。' : '已收藏（副本保存在收藏目录）。');
      else if (v === 'open') run(() => yz.assets.openFile(id));
      else if (v === 'reveal') run(() => yz.assets.revealFile(id));
      else if (v === 'export') run(() => yz.assets.exportOriginal(id), r => `已导出：${r.exported}`);
      else if (v === 'share') run(() => yz.assets.exportShare(id), r => `已导出分享副本：${r.exported}${r.removed?.length ? `（已移除 ${r.removed.join('、')}）` : ''}`);
    });
  });
}
q('#as-tab-all').addEventListener('click', () => show('all').catch(swallow));
q('#as-tab-fav').addEventListener('click', () => show('fav').catch(swallow));
q('#as-q').addEventListener('keydown', e => { if (e.key === 'Enter') loadAll().catch(swallow); });
q('#as-more').addEventListener('click', () => loadAll(true).catch(swallow));
q('#as-grid').addEventListener('click', e => { const c = e.target.closest('[data-asset]'); if (c) openViewer(c.dataset.asset).catch(swallow); });
q('#as-board').addEventListener('click', async e => { const b = e.target.closest('[data-unfav]'); if (b) { try { await call(yz.assets.unfavorite(b.dataset.unfav)); toast('已取消收藏（文件移到回收区）。'); loadBoard(); } catch (er) { swallow(er); } return; } const c = e.target.closest('[data-fav-thumb]'); if (c?.dataset.favThumb) openViewer(c.dataset.favThumb).catch(swallow); });
q('#as-scan').addEventListener('click', async () => { try { const r = await call(yz.assets.scan()); toast(`扫描完成：索引 ${r.indexed}，标记丢失 ${r.missing}${r.errors?.length ? `，${r.errors.length} 个文件读取失败` : ''}。`); yz.assets.watch().catch(() => {}); loadAll(); } catch (e) { swallow(e); } });
q('#as-open-output').addEventListener('click', () => call(yz.assets.openLocation('output')).catch(swallow));
q('#as-open-fav').addEventListener('click', () => call(yz.assets.openLocation('favorites')).catch(swallow));
q('#nav').addEventListener('click', e => { if (e.target.closest('[data-page="assets"]')) show(tab).catch(swallow); });
window.addEventListener('resize', () => { if (S.page === 'assets' && tab === 'fav') loadBoard(); });
})();
