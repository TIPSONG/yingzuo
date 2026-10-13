'use strict';
// E02/E04/S08：正式界面外壳——首页、起始页、服务与日志、设置。与 workbench.js 共享全局 run/accept/current。
(() => {
const desk = window.yingzuoDesktop, yz = window.yingzuo;
const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
let page = 'home', startOpen = false, modalOpen = false, settings = null, lastSequence = 0, servicesBusy = false;
function toast(message, error = false) { const t = q('#toast'); t.textContent = message; t.classList.toggle('error', error); t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, error ? 9000 : 4000); }
async function call(promise, okMessage) {
  const r = await promise;
  if (!r?.ok) { const message = r?.error?.message || '操作未完成。'; toast(message, true); throw Object.assign(new Error(message), {handled: true, code: r?.error?.code ?? null, details: r?.error?.details ?? null}); }
  if (okMessage) toast(typeof okMessage === 'function' ? okMessage(r.data) : okMessage);
  return r.data;
}
const swallow = e => { if (!e?.handled) toast(e.message, true); };

/* ---------- 无边框窗口控制 ---------- */
function syncMaxButton(maximized) {
  const btn = q('#win-max'); if (!btn) return;
  const on = !!maximized;
  btn.dataset.state = on ? 'maximized' : 'restored';
  btn.setAttribute('aria-label', on ? '还原' : '最大化');
  btn.title = on ? '还原' : '最大化';
  const icon = btn.querySelector('.win-max-icon');
  if (icon) icon.textContent = on ? '❐' : '▢';
}
q('#win-min')?.addEventListener('click', () => { desk.windowMinimize?.().catch?.(swallow); });
q('#win-max')?.addEventListener('click', async () => {
  try {
    const r = await desk.windowMaximize?.();
    if (r && typeof r.maximized === 'boolean') syncMaxButton(r.maximized);
    else if (r?.ok && typeof r.maximized === 'boolean') syncMaxButton(r.maximized);
  } catch (e) { swallow(e); }
});
q('#win-close')?.addEventListener('click', () => { desk.windowClose?.().catch?.(swallow); });
try {
  desk.windowIsMaximized?.().then(r => { if (r?.ok) syncMaxButton(r.maximized); }).catch(() => {});
  desk.onWindowState?.(state => syncMaxButton(state?.maximized));
} catch { /* 预加载不可用时忽略（静态预览） */ }

// 原生 ComfyUI 视图是窗口层级之上的视图：离开创作页或打开弹窗时必须隐藏（E10）。
function syncOverlay() { desk.setOverlay(page !== 'create' || startOpen || modalOpen); if (typeof reportBounds === 'function') reportBounds(); }
function showPage(next) {
  page = next;
  for (const p of qa('.page')) p.hidden = p.id !== `page-${next}`;
  for (const b of qa('#nav .nav')) b.classList.toggle('active', b.dataset.page === next);
  syncOverlay();
  if (next === 'home') refreshHome();
  if (next === 'services') refreshServices();
  if (next === 'settings') loadSettings();
}
q('#nav').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b) showPage(b.dataset.page); });
q('#preview').addEventListener('click', () => { closeStart(); showPage('create'); });
q('#templates').addEventListener('click', e => { if (e.target.closest('[data-template]')) { closeStart(); showPage('create'); } });

/* ---------- 服务卡片 ---------- */
const badge = (text, kind) => `<span class="badge ${kind}">${esc(text)}</span>`;
function comfyCard(c, detailed) {
  if (!c) return '';
  const kind = c.summary === 'ready' ? 'ok' : c.summary === 'degraded' || c.summary === 'port-occupied' ? 'warn' : 'bad';
  const label = {ready: '已就绪', degraded: 'WebSocket 异常', offline: '未运行', 'port-occupied': '端口被占用', 'config-error': '配置错误'}[c.summary] || c.summary;
  const rows = [
    ['地址', c.url], ['端口', c.port ? (c.port.reachable ? '可连接' : c.port.error) : '—'],
    ['身份', c.identity ? (c.identity.ok ? `ComfyUI ${c.identity.comfyuiVersion ?? '版本未知'}` : c.identity.error) : '—'],
    ['WebSocket', c.websocket ? (c.websocket.ok ? '握手成功' : c.websocket.error) : '—'],
    ['编辑器', current.connected ? '已载入' : '未载入'],
    ['归属', c.ownership === 'owned' ? '本应用启动（退出时停止）' : c.ownership === 'external' ? '外部服务（退出时保持运行）' : '—'],
  ];
  if (detailed && c.identity?.devices) rows.push(['设备', c.identity.devices.map(d => `${d.name}`).join('；')]);
  if (c.error) rows.push(['错误', c.error]);
  const running = c.summary === 'ready' || c.summary === 'degraded';
  return `<div class="card"><h3>ComfyUI ${badge(label, kind)}</h3><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div class="actions">
    ${running ? '' : '<button data-svc="startComfy">启动 ComfyUI</button>'}
    ${running ? '<button data-svc="connect">连接编辑器</button>' : ''}
    ${running ? '<button data-svc="freeComfyMemory">释放显存</button>' : ''}
    ${c.ownership === 'owned' ? '<button data-svc="stopComfy">停止（本应用启动的实例）</button>' : ''}</div></div>`;
}
function lmCard(l) {
  if (!l) return '';
  const kind = l.summary === 'api-ready' ? 'ok' : l.summary === 'app-only' ? 'warn' : 'bad';
  const label = {'api-ready': 'API 已就绪', 'app-only': '已安装，API 未启动', offline: '未运行', 'config-error': '配置错误'}[l.summary] || l.summary;
  const loaded = Array.isArray(l.loaded) ? (l.loaded.length ? l.loaded.map(m => `${m.identifier}${m.owned ? '（本应用）' : ''}`).join('；') : '无') : l.loaded?.error ?? '需要 lms CLI';
  const rows = [['应用 / CLI', l.app?.ok ? `已找到 ${l.app.version ?? ''}` : l.app?.error], ['API', l.api?.ok ? `${l.url} 可用` : l.api?.error], ['可用模型', l.models ? `${l.models.length} 个` : '—'], ['Gemma', l.gemma?.found ? l.gemma.id : l.gemma?.reason], ['已加载实例', loaded], ['服务归属', l.serverOwnership === 'owned' ? '本应用启动' : l.serverOwnership === 'external' ? '外部' : '—']];
  return `<div class="card"><h3>LM Studio ${badge(label, kind)}</h3><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div class="actions">
    ${!l.api?.ok && l.app?.ok ? '<button data-svc="startLmServer">启动 API 服务</button>' : ''}
    ${!l.app?.ok ? '<span class="muted">未找到 lms CLI：请手动打开 LM Studio 并在 Developer 页面启动 Server，或在设置中填写 CLI 路径。</span>' : ''}
    ${l.serverOwnership === 'owned' ? '<button data-svc="stopLmServer">停止 API 服务</button>' : ''}</div><p class="muted">显存由润色节点的 release_vram 选项释放，只影响本次调用加载的实例；映作不会卸载你的其他聊天模型。</p></div>`;
}
function renderServices(s) {
  q('#service-cards').innerHTML = comfyCard(s.comfy) + lmCard(s.lmstudio);
  if (page === 'services') q('#service-detail').innerHTML = comfyCard(s.comfy, true) + lmCard(s.lmstudio);
}
async function refreshStatus() {
  if (servicesBusy) return; servicesBusy = true;
  try { renderServices(await call(yz.services.status())); } catch (e) { swallow(e); } finally { servicesBusy = false; }
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-svc]'); if (!b) return;
  const op = b.dataset.svc; b.disabled = true;
  try {
    if (op === 'connect') { await run(() => desk.connect(), '真实 ComfyUI 已连接。'); showPage('create'); return; }
    if (op === 'stopComfy' && !(await confirmModal('停止 ComfyUI', '只会停止由映作启动且已重新核实的实例。未保存的画布会先保存。'))) return;
    const label = {startComfy: '正在启动 ComfyUI，等待真实就绪…', freeComfyMemory: '正在释放显存…', startLmServer: '正在启动 LM Studio API…'}[op];
    if (label) toast(label);
    await call(yz.services[op](), {startComfy: d => d.started ? 'ComfyUI 已启动并就绪。' : '已有 ComfyUI 服务在运行，直接使用。', stopComfy: '已停止本应用启动的 ComfyUI。', freeComfyMemory: '已请求释放显存。', startLmServer: d => d.started ? 'LM Studio API 已启动。' : 'LM Studio API 原本就在运行。', stopLmServer: '已停止 LM Studio API。'}[op]);
  } catch (err) { swallow(err); }
  finally { b.disabled = false; refreshStatus(); }
});

/* ---------- 首页 ---------- */
async function refreshHome() {
  refreshStatus();
  q('#recent-tabs').innerHTML = (current.tabs || []).map(t => `<div class="row"><span>${esc(t.title)} <span class="muted">· ${t.mode === 'parameters' ? '表单' : t.mode === 'app' ? 'App Mode' : '节点'} · 版本 ${t.revision ?? 0}</span></span><button data-open-tab="${esc(t.id)}">打开</button></div>`).join('') || '<p class="muted">还没有工作副本。</p>';
  try {
    const info = await call(yz.maintenance.info());
    const disk = info.disk.map(d => d.freeBytes != null ? `${d.path}：可用 ${(d.freeBytes / 2 ** 30).toFixed(1)} GB` : `${d.path}：${d.error}`).join('<br>');
    const mig = info.migration ? {imported: '已从旧 .local 导入（源文件保留）', 'already-imported': '旧数据此前已导入', 'nothing-to-import': '无旧数据', failed: `旧数据导入失败：${info.migration.error}`}[info.migration.status] : '—';
    q('#data-info').innerHTML = `<div class="row"><span>数据目录（${esc(info.dataRoot.mode)}）：${esc(info.dataRoot.root)}</span><button data-open-loc="data">打开</button></div><div class="row"><span>${disk}</span></div><div class="row"><span>迁移：${esc(mig)}</span></div>`;
  } catch (e) { swallow(e); }
}
q('#home-refresh').addEventListener('click', refreshHome);
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open-tab]'); if (t) { showPage('create'); run(() => desk.activateTab(t.dataset.openTab), '工作副本已切换。'); }
  const l = e.target.closest('[data-open-loc]'); if (l) call(yz.maintenance.openLocation(l.dataset.openLoc)).catch(swallow);
});
q('.entry-row').addEventListener('click', async e => {
  const b = e.target.closest('[data-entry]'); if (!b) return;
  showPage('create');
  if (b.dataset.entry === 'start') { openStart(); return; }
  const mode = b.dataset.entry;
  const templateId = settings?.config?.defaults?.templateId || 'text';
  const tab = current.tabs.find(t => t.id === current.activeId);
  await run(async () => { await requireConnection(); if (!tab) await accept(await desk.openTemplate(templateId)); return desk.setMode(mode); }, mode === 'graph' ? '已切到节点画布。' : '已切到参数表单。');
});

/* ---------- 起始页（E04） ---------- */
function openStart() { startOpen = true; q('#start').hidden = false; q('#start-templates').innerHTML = q('#templates').innerHTML; syncOverlay(); }
function closeStart() { startOpen = false; q('#start').hidden = true; syncOverlay(); }
q('#new-tab').addEventListener('click', openStart);
q('#start-close').addEventListener('click', closeStart);
const afterImport = r => { if (r?.importInfo?.notes?.length) toast(r.importInfo.notes.join(' ')); return r; };
async function importText(text, name) { closeStart(); const r = await run(async () => { await requireConnection(); return afterImport(await desk.importText(text, name)); }, '已导入工作流。'); if (!r) openStart(); }
q('#start-file').addEventListener('click', async () => { closeStart(); const r = await run(async () => { await requireConnection(); return afterImport(await desk.importWorkflow()); }, '已导入工作流。'); if (!r || r.cancelled) openStart(); });
q('#start-blank').addEventListener('click', () => { closeStart(); run(async () => { await requireConnection(); return desk.newBlank(); }, '已创建空白画布。'); });
q('#paste-import').addEventListener('click', () => { const text = q('#paste').value; if (!text.trim()) { toast('请先粘贴 JSON。', true); return; } importText(text, '粘贴的工作流'); });
q('#start-templates').addEventListener('click', e => { const b = e.target.closest('[data-template]'); if (b) { closeStart(); run(async () => { await requireConnection(); return desk.openTemplate(b.dataset.template); }, '已打开模板工作副本。'); } });
const dz = q('#dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', async e => {
  e.preventDefault(); dz.classList.remove('over');
  const file = e.dataTransfer?.files?.[0]; if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('工作流超过 8 MB。', true); return; }
  importText(await file.text(), file.name);
});
// 窗口其他位置的拖放不导航页面
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());

/* ---------- 弹窗（重命名、确认） ---------- */
function modal(html, onReady) {
  return new Promise(resolve => {
    modalOpen = true; syncOverlay();
    const back = document.createElement('div'); back.className = 'modal-back'; back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.append(back);
    const done = v => { back.remove(); modalOpen = false; syncOverlay(); resolve(v); };
    onReady(back, done);
  });
}
const confirmModal = (title, text) => modal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="actions"><button data-x="no">返回</button><button data-x="yes" class="primary">继续</button></div>`, (b, done) => b.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes'); }));
q('#rename').addEventListener('click', async () => {
  const tab = current.tabs.find(t => t.id === current.activeId); if (!tab) return;
  const title = await modal(`<h3>重命名工作副本</h3><input id="rename-input" maxlength="80" value="${esc(tab.title)}"><div class="actions"><button data-x="no">取消</button><button data-x="yes" class="primary">保存</button></div>`, (b, done) => {
    const input = b.querySelector('input'); input.focus(); input.select();
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); });
    b.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'yes' ? input.value : null); });
  });
  if (title && title.trim()) run(() => desk.renameTab(tab.id, title.trim()), '已重命名。', false);
});

/* ---------- 服务与日志 ---------- */
async function refreshServices() {
  refreshStatus();
  try {
    const logs = await call(yz.services.logs());
    q('#comfy-log').textContent = logs.comfy.map(f => `# ${f.file}\n${f.lines.join('\n') || '（空）'}`).join('\n\n');
    q('#app-log').textContent = logs.app.join('\n') || '（空）';
  } catch (e) { swallow(e); }
}
q('#logs-refresh').addEventListener('click', refreshServices);
q('#open-logs').addEventListener('click', () => call(yz.maintenance.openLocation('logs')).catch(swallow));
q('#export-diag').addEventListener('click', () => call(yz.maintenance.exportDiagnostics(), d => d.cancelled ? '已取消。' : `诊断信息已导出：${d.path}`).catch(swallow));

/* ---------- 设置（S01/S08） ---------- */
const FIELDS = [
  ['外观', [['ui.theme', '界面主题', 'theme', '深色为默认；「跟随系统」随操作系统外观变化'], ['ui.skin', '界面皮肤', 'skin', '皮肤叠在明暗模式之上；NASA 朋克偏深色科技感']]],
  ['ComfyUI', [['comfy.root', '安装目录', 'path'], ['comfy.python', 'Python', 'file', '按需启动用；通常是 .venv\\Scripts\\python.exe'], ['comfy.url', '地址', 'text', '仅本机 http 地址'], ['comfy.extraArgs', '附加启动参数', 'list', '每项以空格分隔；--listen/--port 由地址决定'], ['comfy.startTimeoutSec', '启动超时（秒）', 'int'], ['comfy.workflowsDir', '工作流目录', 'path', '留空 = <安装目录>\\user\\default\\workflows'], ['comfy.outputDir', '输出目录', 'path', '留空 = <安装目录>\\output'], ['comfy.inputDir', '输入目录', 'path', '留空 = <安装目录>\\input']]],
  ['LM Studio / Gemma', [['lmstudio.url', 'API 地址', 'text'], ['lmstudio.cli', 'lms CLI', 'file'], ['gemma.patchFile', 'Gemma 本地补丁', 'file', '仅登记位置，更新插件时据此保留补丁']]],
  ['目录', [['paths.templates', '模板', 'path', '留空使用数据目录'], ['paths.favorites', '收藏', 'path'], ['paths.downloads', '下载', 'path'], ['paths.backups', '备份', 'path']]],
  ['行为', [['tray.closeToTray', '关闭窗口时缩到托盘', 'bool'], ['downloads.concurrency', '下载并发', 'int'], ['queue.maxBatch', '批量上限', 'int'], ['defaults.templateId', '默认模板', 'select:text,edit,gemma-text,gemma-edit,prompt'], ['updates.checkFrequency', '更新检查', 'select:manual,daily,weekly'], ['updates.channel', '更新渠道', 'select:stable,beta']]],
];
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

let themeMedia = null;
function resolvedTheme(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'system') {
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch { return 'dark'; }
  }
  return 'dark';
}
function applyTheme(theme) {
  const mode = theme === 'light' || theme === 'system' || theme === 'dark' ? theme : 'dark';
  document.documentElement.dataset.theme = resolvedTheme(mode);
  if (themeMedia) { try { themeMedia.removeEventListener('change', onSystemTheme); } catch { /* 旧引擎 */ try { themeMedia.removeListener(onSystemTheme); } catch { /* ignore */ } } themeMedia = null; }
  if (mode === 'system') {
    try {
      themeMedia = matchMedia('(prefers-color-scheme: dark)');
      if (themeMedia.addEventListener) themeMedia.addEventListener('change', onSystemTheme);
      else if (themeMedia.addListener) themeMedia.addListener(onSystemTheme);
    } catch { /* ignore */ }
  }
}
function onSystemTheme() {
  const pref = settings?.config?.ui?.theme;
  if (pref === 'system') document.documentElement.dataset.theme = resolvedTheme('system');
}
function applySkin(skin) {
  const s = skin === 'nasa-punk' ? 'nasa-punk' : 'default';
  if (s === 'default') delete document.documentElement.dataset.skin;
  else document.documentElement.dataset.skin = s;
}
function applyAppearance(cfg) {
  applyTheme(cfg?.ui?.theme);
  applySkin(cfg?.ui?.skin);
}
async function loadSettings() {
  try { settings = await call(yz.settings.get()); applyAppearance(settings?.config); renderSettings(); } catch (e) { swallow(e); }
}
function renderSettings() {
  const c = settings.config;
  q('#settings-issues').innerHTML = (settings.loadError ? `<div class="issue error">配置文件读取失败，已用默认值启动（原文件已另存）：${esc(settings.loadError)}</div>` : '') + settings.issues.map(i => `<div class="issue ${i.severity}">${esc(i.field)}：${esc(i.message)}</div>`).join('');
  q('#settings-form').innerHTML = FIELDS.map(([legend, items]) => `<fieldset><legend>${esc(legend)}</legend>${items.map(([key, label, type, hint]) => {
    const v = getPath(c, key); let input;
    if (type === 'theme') {
      const cur = v === 'light' || v === 'system' ? v : 'dark';
      const card = (id, cls, labelText) => `<button type="button" class="theme-option ${cls} ${cur === id ? 'active' : ''}" data-theme-set="${id}" aria-pressed="${cur === id}"><span class="theme-swatch" aria-hidden="true"><span></span><span></span><span></span></span><small>${labelText}</small></button>`;
      input = `<div class="theme-options" role="radiogroup" aria-label="${esc(label)}">${card('dark', '', '深色')}${card('light', 'theme-option-light', '浅色')}${card('system', 'theme-option-system', '跟随系统')}</div><input type="hidden" data-key="${key}" data-type="text" value="${cur}">`;
      return `<div class="setting setting-theme"><span>${esc(label)}</span>${input}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
    }
    if (type === 'skin') {
      const cur = v === 'nasa-punk' ? 'nasa-punk' : 'default';
      const card = (id, cls, labelText) => `<button type="button" class="theme-option ${cls} ${cur === id ? 'active' : ''}" data-skin-set="${id}" aria-pressed="${cur === id}"><span class="theme-swatch" aria-hidden="true"><span></span><span></span><span></span></span><small>${labelText}</small></button>`;
      input = `<div class="theme-options" role="radiogroup" aria-label="${esc(label)}">${card('default', 'skin-option-default', '默认')}${card('nasa-punk', 'skin-option-nasa', 'NASA朋克')}</div><input type="hidden" data-key="${key}" data-type="text" value="${cur}">`;
      return `<div class="setting setting-theme setting-skin"><span>${esc(label)}</span>${input}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
    }
    if (type === 'bool') input = `<input type="checkbox" data-key="${key}" data-type="bool" ${v ? 'checked' : ''}>`;
    else if (type === 'int') input = `<input type="number" data-key="${key}" data-type="int" value="${esc(v)}">`;
    else if (type === 'list') input = `<input type="text" data-key="${key}" data-type="list" value="${esc((v || []).join(' '))}">`;
    else if (type.startsWith('select:')) input = `<select data-key="${key}" data-type="text">${type.slice(7).split(',').map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    else input = `<input type="text" data-key="${key}" data-type="text" value="${esc(v)}">`;
    const pick = type === 'path' || type === 'file' ? `<button type="button" data-pick="${key}">选择…</button>` : '<span></span>';
    return `<label class="setting"><span>${esc(label)}</span>${input}${pick}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
  }).join('')}</fieldset>`).join('') + `<fieldset><legend>数据位置</legend>${Object.entries(settings.locations).map(([k, v]) => `<div class="setting"><span>${esc(k)}</span><span class="muted">${esc(v || '未配置')}</span>${v ? `<button type="button" data-open-loc="${k}">打开</button>` : '<span></span>'}</div>`).join('')}</fieldset>`;
  const cred = settings.credentials;
  q('#credentials').innerHTML = cred.available ? ['huggingface', 'civitai'].map(n => `<div class="row"><span>${n === 'huggingface' ? 'Hugging Face 令牌' : 'Civitai API Key'}：${cred.configured[n] ? '已保存（系统加密）' : '未设置'}</span><span><input type="password" data-cred="${n}" placeholder="粘贴后保存" class="w220"> <button data-cred-save="${n}">保存</button> ${cred.configured[n] ? `<button data-cred-remove="${n}">删除</button>` : ''}</span></div>`).join('') : '<div class="issue error">系统加密存储不可用，为避免明文保存，映作不会保存在线来源凭据。公开资源仍可下载。</div>';
}
function collectPatch() {
  const patch = {};
  for (const el of qa('#settings-form [data-key]')) {
    const [g, k] = el.dataset.key.split('.'); const t = el.dataset.type;
    const value = t === 'bool' ? el.checked : t === 'int' ? Number.parseInt(el.value, 10) : t === 'list' ? el.value.split(/\s+/).filter(Boolean) : el.value.trim();
    (patch[g] ??= {})[k] = value;
  }
  return patch;
}
q('#settings-save').addEventListener('click', async () => { try { const r = await call(yz.settings.update(collectPatch()), '设置已保存。'); settings = {...settings, ...r}; applyAppearance(settings?.config); renderSettings(); refreshStatus(); } catch (e) { swallow(e); } });
q('#settings-reload').addEventListener('click', loadSettings);
q('#settings-form').addEventListener('click', async e => {
  const themeBtn = e.target.closest('[data-theme-set]');
  if (themeBtn) {
    const raw = themeBtn.dataset.themeSet;
    const theme = raw === 'light' || raw === 'system' ? raw : 'dark';
    applyTheme(theme);
    const hidden = q('#settings-form [data-key="ui.theme"]');
    if (hidden) hidden.value = theme;
    try {
      const msg = theme === 'light' ? '已切换为浅色主题。' : theme === 'system' ? '已跟随系统外观。' : '已切换为深色主题。';
      const r = await call(yz.settings.update({ui: {theme}}), msg);
      settings = {...settings, ...r};
      renderSettings();
    } catch (err) { swallow(err); }
    return;
  }
  const skinBtn = e.target.closest('[data-skin-set]');
  if (skinBtn) {
    const skin = skinBtn.dataset.skinSet === 'nasa-punk' ? 'nasa-punk' : 'default';
    applySkin(skin);
    const hidden = q('#settings-form [data-key="ui.skin"]');
    if (hidden) hidden.value = skin;
    try {
      const r = await call(yz.settings.update({ui: {skin}}), skin === 'nasa-punk' ? '已套用 NASA 朋克皮肤。' : '已恢复默认皮肤。');
      settings = {...settings, ...r};
      renderSettings();
    } catch (err) { swallow(err); }
    return;
  }
  const b = e.target.closest('[data-pick]'); if (!b) return; try { const r = await call(yz.settings.pickPath(b.dataset.pick)); if (!r.cancelled) { settings = {...settings, ...r}; renderSettings(); } } catch (err) { swallow(err); }
});
q('#credentials').addEventListener('click', async e => {
  const s = e.target.closest('[data-cred-save]'), r = e.target.closest('[data-cred-remove]');
  try {
    if (s) { const input = q(`[data-cred="${s.dataset.credSave}"]`); settings.credentials = await call(yz.settings.setCredential(s.dataset.credSave, input.value), '凭据已加密保存。'); input.value = ''; renderSettings(); }
    if (r) { settings.credentials = await call(yz.settings.removeCredential(r.dataset.credRemove), '凭据已删除。'); renderSettings(); }
  } catch (err) { swallow(err); }
});
q('#import-alpha').addEventListener('click', () => call(yz.maintenance.importAlphaDrafts(), d => d.cancelled ? '已取消。' : `已导入 ${d.tabs} 个 A 测标签草稿${d.needReselect.length ? `；${d.needReselect.length} 个标签的参考图需要重新选择` : ''}。`).catch(swallow));

/* ---------- 事件：先读快照再订阅，检测序号间隙 ---------- */
yz.events.subscribe(event => {
  if (lastSequence && event.sequence !== lastSequence + 1) refreshStatus(); // 有间隙：重新同步
  lastSequence = event.sequence;
  if (event.type === 'services.status') renderServices(event.data);
  if (event.type === 'services.comfy' && event.data.phase === 'failed') toast(`ComfyUI 启动失败：${event.data.error}`, true);
});
yz.maintenance.info().then(r => { if (r.ok) lastSequence = r.data.sequence; });
window.yzShell = {toast, call, swallow, modal, esc, showPage, get page() { return page; }};
loadSettings();
showPage('home');
})();
