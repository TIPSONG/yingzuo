'use strict';
// RV15：截图前把页面切到指定页并补齐空状态示例（只改内容，不改主题/皮肤）。在页面上下文执行。
function seedPage(id) {
  const pageId = id === 'create-start' ? 'create' : id;
  const navBtn = document.querySelector(`nav .nav[data-page="${pageId}"]`);
  if (navBtn) navBtn.click();
  for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== `page-${pageId}`;
  for (const btn of document.querySelectorAll('nav .nav')) btn.classList.toggle('active', btn.dataset.page === pageId);
  const toast = document.getElementById('toast'); if (toast) toast.hidden = true;
  const set = (sel, html) => { const el = document.getElementById(sel); if (el && !el.children.length) el.innerHTML = html; };
  if (pageId === 'create') {
    const start = document.getElementById('start'); if (start) start.hidden = id !== 'create-start';
    const empty = document.getElementById('empty'); if (empty) empty.hidden = id === 'create-start';
  }
  if (pageId === 'assets') set('as-grid', '<div class="empty-state"><h3>还没有作品</h3><p>点击「扫描输出目录」，或在创作页运行任务后自动出现。</p></div>');
  if (pageId === 'queue') set('queue-list', '<div class="empty-state"><h3>还没有任务</h3><p>在创作页打开工作流并点击「运行」后，任务会出现在这里。</p></div>');
  if (pageId === 'templates') set('tpl-list', '<div class="empty-state"><h3>还没有模板</h3><p>可以导入 JSON、导入内置模板，或在创作页「存为模板」。</p></div>');
}
module.exports = {seedPage};
