'use strict';
// U05/U08：版本检测展示与应用安装包显式下载。执行更新（U06）在“资源与维护”页，经维护事务先备份。
(() => {
const yz = window.yingzuo, S = window.yzShell;
const q = s => document.querySelector(s);
const {esc, call, swallow} = S;
const repoRow = (name, r) => `<div class="row block"><strong>${esc(name)}</strong> ${r.git ? `<small>${esc(r.describe ?? r.head?.slice(0, 8))} · ${esc(r.branch)}${r.dirty ? ' · 有本地改动' : ''}</small>` : `<small>${esc(r.note ?? r.error ?? '')}</small>`}${r.error ? `<br><small class="err">${esc(r.error)}</small>` : ''}${r.fetchError ? `<br><small class="err">获取远端失败：${esc(r.fetchError)}</small>` : ''}
  ${r.updateAvailable ? `<br><small>落后 ${r.behind.length} 个提交：${r.behind.slice(0, 5).map(b => esc(b.subject)).join('；')}</small>` : r.git && r.upstream ? '<br><small>已是远端最新（以上次获取为准）</small>' : ''}${(r.blockers ?? []).map(b => `<br><small class="err">${esc(b)}</small>`).join('')}</div>`;
async function check(fetchRemote) {
  q('#up-result').innerHTML = '<p class="muted">检测中…</p>';
  try { const r = await call(yz.maintenance.checkUpdates({fetchRemote})); q('#up-result').innerHTML = (r.comfy ? repoRow('ComfyUI', r.comfy) : '<p class="muted">未配置 ComfyUI 目录。</p>') + r.plugins.map(p => repoRow(p.name, p)).join('') + '<p class="muted">需要更新时到“资源与维护”页执行：会先备份，本地补丁保存并重放，失败自动恢复。</p>'; }
  catch (e) { q('#up-result').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
q('#up-check').addEventListener('click', () => check(false));
q('#up-fetch').addEventListener('click', () => check(true));
q('#up-app').addEventListener('click', async () => {
  try {
    const r = await call(yz.maintenance.checkAppRelease());
    q('#up-result').innerHTML = `<div class="row block"><strong>映作 ${esc(r.currentVersion)}</strong>${r.latest ? `<br>最新：${esc(r.latest.version)}（${esc(new Date(r.latest.publishedAt).toLocaleDateString())}）${r.updateAvailable ? '' : ' · 已是最新'}<pre class="log">${esc(r.latest.notes.slice(0, 2000))}</pre>${r.updateAvailable ? r.latest.assets.filter(a => a.name !== 'SHA256SUMS.txt').map(a => `<button data-asset="${esc(a.name)}" ${r.latest.hasChecksums ? '' : 'disabled'}>下载 ${esc(a.name)}</button>`).join('') + (r.latest.hasChecksums ? '' : '<br><small class="err">该版本没有 SHA256SUMS.txt，不提供下载。</small>') : ''}` : ''}<br><small class="muted">${esc(r.note)}</small> <button id="up-open">打开安装包目录</button></div>`;
  } catch (e) { swallow(e); }
});
q('#up-result').addEventListener('click', e => {
  const a = e.target.closest('[data-asset]'); if (a) call(yz.maintenance.downloadAppRelease(a.dataset.asset), '已加入下载（在“在线资源”页查看进度），完成后会按 sha256 校验。').catch(swallow);
  if (e.target.id === 'up-open') call(yz.maintenance.openAppUpdateFolder()).catch(swallow);
});
})();
// U05：按设置频率的后台检查结果（只提示，不执行）
window.yingzuo.events.subscribe(event => {
  if (event.type !== 'maintenance.updates') return;
  const d = event.data;
  if (d.app?.updateAvailable) window.yzShell.toast(`映作有新版本 ${d.app.version}，可在“服务与日志”中查看并下载。`);
  if (d.environment?.behind?.length) window.yzShell.toast(`有 ${d.environment.behind.length} 个仓库落后于上次获取的远端版本，可在“资源与维护”中更新。`);
});
