'use strict';
// RV13（及 RV11/RV12 实测）：在真实浏览器中加载 workbench.html + 替身 preload。
// REQUIRE_BROWSER_TESTS=1 的 CI 必须实际执行；缺依赖时直接失败，不能用 SKIP 掩盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.join(__dirname, '..');
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
let puppeteer = null; try { puppeteer = require('puppeteer-core'); } catch { /* 未安装 */ }
const skip = !puppeteer || !chrome ? '需要 puppeteer-core 与 Chrome' : false;
if (skip && process.env.REQUIRE_BROWSER_TESTS === '1') throw new Error(skip);
const stubSource = require('../tools/ui-shots/stub.cjs');
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tools/ui-shots/fixtures.json'), 'utf8'));

async function open(t, opts) {
  const server = http.createServer((req, res) => { const f = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, {'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'}); fs.createReadStream(f).pipe(res); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu']});
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(stubSource(fixtures, opts));
  await page.goto(`http://127.0.0.1:${server.address().port}/desktop/workbench.html`, {waitUntil: 'networkidle0'});
  await waitForIdle(page);
  const reads = await completed(page, 'settings.get');
  await page.click('nav .nav[data-page="settings"]');
  // The hidden form exists before navigation. Wait for this navigation's read,
  // not a selector belonging to the form that loadSettings is about to replace.
  await finished(page, 'settings.get', reads + 1);
  await page.waitForSelector('#settings-form [data-key="comfy.root"]', {visible: true});
  return page;
}
const waitForIdle = async page => {
  await page.waitForFunction(() => window.__yzFixture?.pending === 0);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getTiming().iterations ?? 1)).map(a => a.finished.catch(() => {}))));
};
const completed = (page, key) => page.evaluate(key => window.__yzFixture.completed.filter(k => k === key).length, key);
const finished = async (page, key, count) => {
  await page.waitForFunction((key, count) => window.__yzFixture.completed.filter(k => k === key).length >= count, {}, key, count);
  await waitForIdle(page);
};
const typeInto = (page, key, text) => page.locator(`#settings-form [data-key="${key}"]`).fill(text);
const val = (page, key) => page.$eval(`#settings-form [data-key="${key}"]`, el => el.value);

test('RV13：编辑多个字段后切主题与皮肤，未保存输入保留；继续编辑后保存提交全部字段', {skip}, async t => {
  const page = await open(t, {});
  await typeInto(page, 'comfy.root', 'E:\\新ComfyUI'); await typeInto(page, 'lmstudio.url', 'http://127.0.0.1:4321/v1');
  await page.locator('[data-theme-set="light"]').click(); await finished(page, 'settings.update', 1);
  await page.locator('[data-skin-set="nasa-punk"]').click(); await finished(page, 'settings.update', 2);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), 'nasa-punk');
  assert.equal(await val(page, 'comfy.root'), 'E:\\新ComfyUI');
  assert.equal(await val(page, 'lmstudio.url'), 'http://127.0.0.1:4321/v1');
  await typeInto(page, 'comfy.startTimeoutSec', '300');
  await page.click('#settings-save'); await finished(page, 'settings.update', 3);
  const saved = await page.evaluate(() => window.__yzCalls.filter(c => c[0] === 'settings.update').at(-1)[1][0]);
  assert.equal(saved.comfy.root, 'E:\\新ComfyUI'); assert.equal(saved.lmstudio.url, 'http://127.0.0.1:4321/v1'); assert.equal(saved.comfy.startTimeoutSec, 300);
  assert.deepEqual(saved.ui, {theme: 'light', skin: 'nasa-punk'});
});
test('RV13：路径选择与凭据保存不抹掉其他字段草稿', {skip}, async t => {
  const page = await open(t, {});
  await typeInto(page, 'comfy.root', 'E:\\草稿');
  await page.click('[data-pick="comfy.python"]'); await finished(page, 'settings.pickPath', 1);
  assert.equal(await val(page, 'comfy.python'), 'D:\\picked\\python');
  assert.equal(await val(page, 'comfy.root'), 'E:\\草稿');
  await page.type('[data-cred="civitai"]', 'secret'); await page.click('[data-cred-save="civitai"]'); await finished(page, 'settings.setCredential', 1);
  assert.equal(await val(page, 'comfy.root'), 'E:\\草稿');
});
test('RV13：外观保存失败恢复到已保存外观；快速连续切换按最后一次操作收敛（迟到响应不覆盖）', {skip}, async t => {
  const bad = await open(t, {failUpdate: true});
  await typeInto(bad, 'comfy.root', 'E:\\保留');
  await bad.locator('[data-theme-set="light"]').click(); await finished(bad, 'settings.update', 1);
  assert.equal(await bad.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await bad.$eval('[data-theme-set="dark"]', el => el.classList.contains('active')), true);
  assert.equal(await val(bad, 'comfy.root'), 'E:\\保留');
  const slow = await open(t, {updateDelayMs: 120});
  // Dispatch the real click handlers in one browser task so all choices precede
  // the delayed save responses, regardless of the CI machine's pointer speed.
  await slow.evaluate(() => {
    for (const theme of ['light', 'system', 'dark']) document.querySelector(`[data-theme-set="${theme}"]`).click();
  });
  await finished(slow, 'settings.update', 3);
  assert.deepEqual(await slow.evaluate(() => window.__yzCalls.filter(c => c[0] === 'settings.update').map(c => c[1][0].ui.theme)), ['light', 'system', 'dark']);
  assert.equal(await slow.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await slow.$eval('[data-theme-set="dark"]', el => el.getAttribute('aria-pressed')), 'true');
});
test('RV13：设置读取晚于开始编辑时保留焦点和选区；离开页面或打开弹窗后不抢焦点', {skip}, async t => {
  const page = await open(t, {pauseSettingsGets: [3, 4, 5]});
  const beginRead = async () => {
    await page.evaluate(() => window.yzShell.showPage('settings'));
    await page.waitForFunction(() => typeof window.__yzFixture.resumeSettingsGet === 'function');
  };
  const resumeRead = async count => {
    await page.evaluate(() => window.__yzFixture.resumeSettingsGet());
    await finished(page, 'settings.get', count);
  };
  await beginRead();
  await typeInto(page, 'comfy.root', 'E:\\first');
  await page.$eval('[data-key="comfy.root"]', el => el.setSelectionRange(3, 8, 'backward'));
  await resumeRead(3);
  assert.deepEqual(await page.evaluate(() => ({key: document.activeElement.dataset.key, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd, direction: document.activeElement.selectionDirection})), {key: 'comfy.root', start: 3, end: 8, direction: 'backward'});
  await page.keyboard.type('continued');
  assert.equal(await val(page, 'comfy.root'), 'E:\\continued');

  await beginRead();
  await page.focus('[data-key="comfy.root"]');
  await page.click('nav .nav[data-page="home"]');
  await resumeRead(4);
  assert.equal(await page.evaluate(() => window.yzShell.page), 'home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.page), 'home');

  await beginRead();
  await page.focus('[data-key="comfy.root"]');
  await page.evaluate(() => {
    void window.yzShell.modal('<input id="rv13-modal-focus">', back => back.querySelector('input').focus());
  });
  await resumeRead(5);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'rv13-modal-focus');
});
test('RV11/RV12 实测：浅色与 NASA 浅色下选中导航、弹窗/空状态文字的实际对比度 ≥ 4.5:1', {skip}, async t => {
  for (const skin of ['default', 'nasa-punk']) {
    const page = await open(t, {theme: 'light', skin}); await waitForIdle(page);
    const r = await page.evaluate(() => {
      const rgb = s => { const n = s.match(/[\d.]+/g).map(Number); return s.startsWith('color(srgb') ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n; };
      const L = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); layers.push(c); if ((c[3] ?? 1) === 1) break; } let out = [255, 255, 255]; for (const c of layers.reverse()) { const a = c[3] ?? 1; out = out.map((v, i) => c[i] * a + v * (1 - a)); } return out; };
      const C = el => { const a = L(rgb(getComputedStyle(el).color)), b = L(bgOf(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      const back = document.createElement('div'); back.className = 'modal-back'; back.innerHTML = '<div class="modal"><h3>弹窗</h3><p>正文</p></div><div class="empty-state"><h3>空状态</h3></div><div class="task"><span>任务</span></div>'; document.body.append(back);
      return {nav: C(document.querySelector('nav .nav.active')), modal: C(back.querySelector('.modal h3')), empty: C(back.querySelector('.empty-state h3')), task: C(back.querySelector('.task span')), card: C(document.querySelector('.theme-option.active small'))};
    });
    for (const [k, v] of Object.entries(r)) assert.ok(v >= 4.5, `${skin} ${k} = ${v.toFixed(2)}`);
  }
});
