'use strict';
// A04 作品浏览与查看器、A08 收藏板。只通过 assets.* 接口按 ID 操作，不传任意路径。
(() => {
const yz = window.yingzuo, S = window.yzShell;
const q = s => document.querySelector(s);
const {esc, toast, call, swallow, modal} = S;
const size = b => b == null ? '' : b > 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
const PAGE_SIZE = 60;
let tab = 'all', revision = 0, nextOffset = null, boardOffset = 0, viewerRequest = 0;
let searchTimer, resizeTimer;
const thumbCache = new Map();
async function thumb(id, px = 256) {
  const k = `${id}:${px}`;
  if (!thumbCache.has(k)) thumbCache.set(k, yz.assets.thumbnail(id, {size: px}).then(r => r?.ok ? r.data.dataUrl : null, () => null));
  return thumbCache.get(k);
}
async function fillThumbs(root, selector, px, request) {
  for (const el of root.querySelectorAll(selector)) {
    if (request !== revision) return;
    if (el.dataset.requested) continue;
    el.dataset.requested = 'true';
    const url = await thumb(el.dataset.thumb ?? el.dataset.favThumb, px);
    if (request !== revision || !el.isConnected) return;
    if (url) {
      const image = new Image();
      image.alt = '';
      image.src = url;
      el.replaceChildren(image);
    } else el.textContent = '无缩略图';
  }
}
function assetCard(a) {
  const details = [a.width && a.height ? `${a.width}×${a.height}` : '', a.taskId ? '任务' : ''].filter(Boolean).join(' · ');
  return `<button class="asset-card" data-asset="${esc(a.id)}" title="${esc(a.path)}"><span class="thumb" ${a.kind === 'image' ? `data-thumb="${esc(a.id)}"` : ''}>${a.kind === 'image' ? '…' : esc(a.format ?? a.kind)}</span><span class="cap"><span class="asset-name">${esc(a.name)}</span>${details ? `<small class="muted">${esc(details)}</small>` : ''}</span></button>`;
}
function startSearch(delayed = false) {
  clearTimeout(searchTimer);
  const request = ++revision;
  nextOffset = null;
  thumbCache.clear();
  q('#as-grid').replaceChildren();
  q('#as-grid').setAttribute('aria-busy', 'true');
  q('#as-count').textContent = '正在读取作品…';
  q('#as-more').hidden = true;
  if (delayed) searchTimer = setTimeout(() => loadAll(request), 200);
  else return loadAll(request);
}
async function loadAll(request, offset = 0) {
  const query = q('#as-q').value.trim(), more = q('#as-more'), grid = q('#as-grid');
  more.disabled = true;
  grid.setAttribute('aria-busy', 'true');
  try {
    const response = await yz.assets.list({offset, limit: PAGE_SIZE, query});
    if (request !== revision) return;
    const r = await call(response);
    if (request !== revision) return;
    nextOffset = r.nextOffset;
    q('#as-count').textContent = query ? `找到 ${r.total} 张` : `共 ${r.total} 张`;
    const retry = grid.querySelector('.err');
    retry?.remove();
    grid.insertAdjacentHTML('beforeend', r.items.map(assetCard).join(''));
    if (!grid.childElementCount) grid.innerHTML = query
      ? '<div class="empty-state"><h3>没有匹配的作品</h3><button data-clear-search>清除搜索</button></div>'
      : '<div class="empty-state"><h3>还没有作品</h3><p>点击“扫描输出目录”，或在创作页运行任务后自动出现。</p></div>';
    more.hidden = nextOffset == null;
    fillThumbs(grid, '[data-thumb]', 256, request);
  } catch (e) {
    if (request === revision) {
      grid.querySelector('.err')?.remove();
      grid.insertAdjacentHTML('beforeend', `<p class="err">${esc(e.message)}</p>`);
      q('#as-count').textContent = '作品读取失败';
    }
  } finally {
    if (request === revision) { more.disabled = false; grid.removeAttribute('aria-busy'); }
  }
}
async function loadBoard(offset = boardOffset, refresh = true) {
  const request = ++revision, board = q('#as-board');
  boardOffset = offset;
  const prev = q('#as-fav-prev'), next = q('#as-fav-next');
  if (refresh) thumbCache.clear();
  board.setAttribute('aria-busy', 'true');
  prev.disabled = next.disabled = true;
  try {
    const width = Math.max(1, board.clientWidth || q('#page-assets .page-body').clientWidth - 20);
    const response = await yz.assets.favorites({offset, limit: PAGE_SIZE, layout: {width, rowHeight: 220, gap: 8}});
    if (request !== revision) return;
    const r = await call(response);
    if (request !== revision) return;
    if (offset > 0 && !r.items.length) return loadBoard(Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1) * PAGE_SIZE);
    const broken = r.items.filter(i => i.broken);
    const range = r.total > PAGE_SIZE ? ` · 显示 ${offset + 1}–${offset + r.items.length}` : '';
    q('#as-count').textContent = `收藏 ${r.total} 张${range}${broken.length ? `（本页 ${broken.length} 张收藏文件丢失）` : ''}`;
    prev.hidden = next.hidden = r.total <= PAGE_SIZE;
    prev.disabled = offset === 0;
    next.disabled = offset + r.items.length >= r.total;
    const lay = r.layout;
    const byId = new Map(r.items.map(i => [i.id, i]));
    const cells = [...lay.cells, ...broken.map((f, i) => ({id: f.id, x: 0, y: lay.height + 8 + i * 104, width, height: 96}))];
    board.style.height = `${broken.length ? lay.height + 8 + broken.length * 104 : lay.height}px`;
    board.innerHTML = cells.map(c => {
      const f = byId.get(c.id), path = f.sourcePath || f.storedPath, name = path.split(/[\\/]/).pop();
      const preview = f.broken ? '<p class="muted">收藏副本已丢失；原图仍在时，可重新收藏以恢复。</p>' : `<button class="fill" data-fav-thumb="${esc(`favorite:${f.id}`)}" aria-label="查看 ${esc(name)}"></button>`;
      return `<div class="cell" data-cell="${esc(f.id)}" title="${esc(f.storedPath)}${f.sourceMissing ? '（原图已删除）' : ''}">${preview}<button data-unfav="${esc(f.id)}">${f.broken ? '移除失效记录' : '取消收藏'}</button></div>`;
    }).join('') || '<div class="empty-state"><h3>还没有收藏</h3><p>在作品查看器中点“收藏”。</p></div>';
    for (const [i, el] of [...board.children].entries()) {
      const c = cells[i];
      if (c) Object.assign(el.style, {left: `${c.x}px`, top: `${c.y}px`, width: `${c.width}px`, height: `${c.height}px`});
    }
    await fillThumbs(board, '[data-fav-thumb]', 512, request);
  } catch (e) {
    if (request === revision) {
      board.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      q('#as-count').textContent = '收藏读取失败';
    }
  } finally {
    if (request === revision) board.removeAttribute('aria-busy');
  }
}
function show(which) {
  clearTimeout(searchTimer);
  clearTimeout(resizeTimer);
  tab = which;
  for (const id of ['all', 'fav']) {
    const button = q(`#as-tab-${id}`);
    button.classList.toggle('primary', which === id);
    button.setAttribute('aria-pressed', String(which === id));
  }
  q('#as-grid').hidden = which !== 'all';
  q('#as-board').hidden = which !== 'fav';
  q('#as-q').hidden = which !== 'all';
  q('#as-more').hidden = q('#as-fav-prev').hidden = q('#as-fav-next').hidden = true;
  q('#as-count').textContent = which === 'fav' ? '正在读取收藏…' : '';
  return which === 'all' ? startSearch() : loadBoard();
}
async function openViewer(id, trigger) {
  const request = ++viewerRequest;
  const a = await call(yz.assets.get(id));
  const url = a.kind === 'image' ? await thumb(id, 1024) : null;
  const g = a.generation;
  const share = await yz.assets.shareSupport(id).then(r => r?.ok ? r.data : {supported: false, reason: r?.error?.message}, () => ({supported: false}));
  if (request !== viewerRequest || S.page !== 'assets' || !trigger.getClientRects().length || q('.modal-back')) return;
  const meta = `<h3>${esc(a.name)}</h3><p class="muted">${esc(a.path)}<br>${a.width ? `${a.width}×${a.height} · ` : ''}${size(a.size)} · ${esc(a.format ?? '')}</p>
    ${g.prompts.length ? `<p><b>提示词</b><br>${g.prompts.map(p => esc(typeof p === 'string' ? p : p.text ?? JSON.stringify(p))).join('<br>')}</p>` : ''}
    ${g.seed != null ? `<p>seed：${esc(String(g.seed))}</p>` : ''}${g.checkpoints.length ? `<p>模型：${g.checkpoints.map(esc).join('、')}</p>` : ''}
    ${a.task ? `<p>来自任务 ${esc(a.task.id)}（${esc(a.task.state ?? '记录缺失')}）</p>` : ''}
    ${a.missingFields.length ? `<p class="muted">缺少：${a.missingFields.map(esc).join('、')}（如实显示，不推测）</p>` : ''}${a.readError ? `<p class="err">${esc(a.readError)}</p>` : ''}
    <div class="actions"><button data-v="fav" class="primary" ${a.favoriteId ? 'disabled' : ''}>${a.favoriteId ? '已收藏' : '收藏'}</button><button data-v="open">用系统程序打开</button><button data-v="reveal">在文件夹中显示</button><button data-v="export">导出原图…</button><button data-v="share" ${share.supported ? '' : `disabled title="${esc(share.reason ?? '')}"`}>导出分享副本…</button><button data-v="close">关闭</button></div>
    <p class="muted">滚轮缩放 · 拖动平移 · 0 适应 · 1 预览图 100% · Esc 关闭</p>`;
  await modal(`<div class="viewer"><div class="stage">${url ? `<img alt="" src="${url}" draggable="false">` : '<span class="muted">无法预览</span>'}</div><div class="meta">${meta}</div></div>`, (back, done) => {
    const img = back.querySelector('.stage img'), stage = back.querySelector('.stage');
    back.querySelector('[role="dialog"]').setAttribute('aria-label', a.name);
    back.querySelector('[data-v="close"]').focus();
    let z = 1, x = 0, y = 0, drag = null;
    const apply = () => { if (img) img.style.transform = `translate(${x}px,${y}px) scale(${z})`; };
    const fit = () => { if (!img?.naturalWidth) return; z = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight, 1); x = y = 0; apply(); };
    img?.addEventListener('load', fit);
    fit();
    const zoom = factor => { z = Math.max(0.05, Math.min(16, z * factor)); apply(); };
    stage.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, {passive: false});
    stage.addEventListener('pointerdown', e => { drag = {sx: e.clientX - x, sy: e.clientY - y}; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', e => { if (drag) { x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply(); } });
    stage.addEventListener('lostpointercapture', () => { drag = null; });
    back.addEventListener('keydown', e => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Tab') {
        const buttons = [...back.querySelectorAll('button:enabled')];
        const first = buttons[0], last = buttons.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      } else if (e.key === '0') fit();
      else if (e.key === '1') { z = 1; x = y = 0; apply(); }
      else if (e.key === 'Escape') done(null);
      else if (e.key === '+' || e.key === '=') zoom(1.15);
      else if (e.key === '-') zoom(1 / 1.15);
    });
    const run = async (fn, msg) => { try { const r = await call(fn()); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); } catch (e) { swallow(e); } };
    back.addEventListener('click', e => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      const v = b.dataset.v;
      if (v === 'close') done(null);
      else if (v === 'fav') {
        if (document.activeElement === b) back.querySelector('[data-v="close"]').focus();
        b.disabled = true;
        call(yz.assets.favorite(id)).then(r => {
          b.textContent = '已收藏';
          toast(r.duplicate ? '已在收藏中。' : '已收藏（副本保存在收藏目录）。');
        }).catch(e => { b.disabled = false; swallow(e); });
      }
      else if (v === 'open') run(() => yz.assets.openFile(id));
      else if (v === 'reveal') run(() => yz.assets.revealFile(id));
      else if (v === 'export') run(() => yz.assets.exportOriginal(id), r => `已导出：${r.exported}`);
      else if (v === 'share') run(() => yz.assets.exportShare(id), r => `已导出分享副本：${r.exported}${r.removed?.length ? `（已移除 ${r.removed.join('、')}）` : ''}`);
    });
  });
  if (trigger.isConnected) trigger.focus({preventScroll: true});
}
q('#as-tab-all').addEventListener('click', () => show('all').catch(swallow));
q('#as-tab-fav').addEventListener('click', () => show('fav').catch(swallow));
q('#as-q').addEventListener('input', e => { if (!e.isComposing) startSearch(true); });
q('#as-q').addEventListener('compositionend', () => startSearch(true));
q('#as-q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) startSearch(); });
q('#as-more').addEventListener('click', () => { if (nextOffset != null) loadAll(revision, nextOffset); });
function goToBoardPage(offset) {
  q('#page-assets').scrollTop = 0;
  q('#as-tab-fav').focus({preventScroll: true});
  loadBoard(offset);
}
q('#as-fav-prev').addEventListener('click', () => goToBoardPage(Math.max(0, boardOffset - PAGE_SIZE)));
q('#as-fav-next').addEventListener('click', () => goToBoardPage(boardOffset + PAGE_SIZE));
q('#as-grid').addEventListener('click', e => {
  if (e.target.closest('[data-clear-search]')) {
    const input = q('#as-q'); input.value = ''; input.focus(); startSearch();
    return;
  }
  const c = e.target.closest('[data-asset]'); if (c) openViewer(c.dataset.asset, c).catch(swallow);
});
q('#as-board').addEventListener('click', async e => {
  const b = e.target.closest('[data-unfav]');
  if (b) {
    b.disabled = true;
    try {
      const r = await call(yz.assets.unfavorite(b.dataset.unfav));
      toast(r.trashed ? '已取消收藏（文件移到回收区）。' : '已移除收藏记录。');
      if (tab === 'fav') loadBoard();
    } catch (er) { b.disabled = false; swallow(er); }
    return;
  }
  const c = e.target.closest('[data-fav-thumb]'); if (c) openViewer(c.dataset.favThumb, c).catch(swallow);
});
q('#as-scan').addEventListener('click', async e => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const r = await call(yz.assets.scan());
    toast(`扫描完成：索引 ${r.indexed}，标记丢失 ${r.missing}${r.errors?.length ? `，${r.errors.length} 个文件读取失败` : ''}。`);
    yz.assets.watch().catch(() => {});
    show(tab);
  } catch (err) { swallow(err); } finally { button.disabled = false; }
});
q('#as-open-output').addEventListener('click', () => call(yz.assets.openLocation('output')).catch(swallow));
q('#as-open-fav').addEventListener('click', () => call(yz.assets.openLocation('favorites')).catch(swallow));
q('#nav').addEventListener('click', e => { if (e.target.closest('[data-page="assets"]')) show(tab).catch(swallow); });
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (S.page === 'assets' && tab === 'fav') loadBoard(boardOffset, false); }, 120);
});
})();
