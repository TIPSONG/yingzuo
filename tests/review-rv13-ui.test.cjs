'use strict';
// RV13（及 RV11/RV12 实测）：在真实浏览器中加载 workbench.html + 替身 preload。
// 需要 puppeteer-core 与本机 Chrome（CHROME_PATH）；缺少时跳过（Windows CI 只跑静态检查 review-rv11-12）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.join(__dirname, '..');
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
let puppeteer = null; try { puppeteer = require('puppeteer-core'); } catch { /* 未安装 */ }
const skip = !puppeteer || !chrome ? '需要 puppeteer-core 与 Chrome' : false;
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
  await page.click('nav .nav[data-page="settings"]');
  await page.waitForSelector('#settings-form [data-key="comfy.root"]');
  return page;
}
const settle = page => page.evaluate(() => new Promise(r => setTimeout(r, 50)).then(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))));
const typeInto = async (page, key, text) => { const sel = `#settings-form [data-key="${key}"]`; await page.click(sel, {clickCount: 3}); await page.type(sel, text); };
const val = (page, key) => page.$eval(`#settings-form [data-key="${key}"]`, el => el.value);

test('RV13：编辑多个字段后切主题与皮肤，未保存输入保留；继续编辑后保存提交全部字段', {skip}, async t => {
  const page = await open(t, {});
  await typeInto(page, 'comfy.root', 'E:\\新ComfyUI'); await typeInto(page, 'lmstudio.url', 'http://127.0.0.1:4321/v1');
  await page.click('[data-theme-set="light"]'); await settle(page);
  await page.click('[data-skin-set="nasa-punk"]'); await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), 'nasa-punk');
  assert.equal(await val(page, 'comfy.root'), 'E:\\新ComfyUI');
  assert.equal(await val(page, 'lmstudio.url'), 'http://127.0.0.1:4321/v1');
  await typeInto(page, 'comfy.startTimeoutSec', '300');
  await page.click('#settings-save'); await settle(page);
  const saved = await page.evaluate(() => window.__yzCalls.filter(c => c[0] === 'settings.update').at(-1)[1][0]);
  assert.equal(saved.comfy.root, 'E:\\新ComfyUI'); assert.equal(saved.lmstudio.url, 'http://127.0.0.1:4321/v1'); assert.equal(saved.comfy.startTimeoutSec, 300);
  assert.deepEqual(saved.ui, {theme: 'light', skin: 'nasa-punk'});
});
test('RV13：路径选择与凭据保存不抹掉其他字段草稿', {skip}, async t => {
  const page = await open(t, {});
  await typeInto(page, 'comfy.root', 'E:\\草稿');
  await page.click('[data-pick="comfy.python"]'); await settle(page);
  assert.equal(await val(page, 'comfy.python'), 'D:\\picked\\python');
  assert.equal(await val(page, 'comfy.root'), 'E:\\草稿');
  await page.type('[data-cred="civitai"]', 'secret'); await page.click('[data-cred-save="civitai"]'); await settle(page);
  assert.equal(await val(page, 'comfy.root'), 'E:\\草稿');
});
test('RV13：外观保存失败恢复到已保存外观；快速连续切换按最后一次操作收敛（迟到响应不覆盖）', {skip}, async t => {
  const bad = await open(t, {failUpdate: true});
  await typeInto(bad, 'comfy.root', 'E:\\保留');
  await bad.click('[data-theme-set="light"]'); await settle(bad);
  assert.equal(await bad.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await bad.$eval('[data-theme-set="dark"]', el => el.classList.contains('active')), true);
  assert.equal(await val(bad, 'comfy.root'), 'E:\\保留');
  const slow = await open(t, {updateDelayMs: 120});
  await slow.click('[data-theme-set="light"]'); await slow.click('[data-theme-set="system"]'); await slow.click('[data-theme-set="dark"]');
  await slow.evaluate(() => new Promise(r => setTimeout(r, 500)));
  assert.equal(await slow.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await slow.$eval('[data-theme-set="dark"]', el => el.getAttribute('aria-pressed')), 'true');
});
test('RV11/RV12 实测：浅色与 NASA 浅色下选中导航、弹窗/空状态文字的实际对比度 ≥ 4.5:1', {skip}, async t => {
  for (const skin of ['default', 'nasa-punk']) {
    const page = await open(t, {theme: 'light', skin}); await settle(page);
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
