// Static workbench screenshots with explicit preload fixtures, never a manual desktop/GPU acceptance.
// npm ci; npm run screenshots -- --chrome /path/to/chrome [--out directory]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tools/ui-shots/fixtures.json'), 'utf8'));
const stubSource = require('./ui-shots/stub.cjs');
const {seedPage} = require('./ui-shots/seed.cjs');
export const VIEWPORT = {width: 1440, height: 960, deviceScaleFactor: 1};
export const VARIANTS = [['default', 'dark', 'default'], ['light', 'light', 'default'], ['nasa', 'dark', 'nasa-punk'], ['nasa-light', 'light', 'nasa-punk']];
export const SCENARIOS = ['home', 'create', 'create-start', 'templates', 'online', 'assets', 'assets-empty', 'favorites', 'assets-viewer', 'resources', 'queue', 'services', 'settings', 'settings-lower'];
const selectors = {
  home: '#data-info .row', create: '#empty', 'create-start': '#start', templates: '#tpl-list .task',
  online: '#dl-list p', assets: '#as-grid .asset-card', 'assets-empty': '#as-grid .empty-state',
  favorites: '#as-board .cell', 'assets-viewer': '.viewer .stage img', resources: '#rs-models details',
  queue: '#queue-list .task', services: '#service-detail .card', settings: '#settings-form [data-key="comfy.root"]', 'settings-lower': '#credentials input',
};
const mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json'};
export async function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    let url; try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = path.resolve(root, url === '/' ? 'desktop/workbench.html' : url.replace(/^\//, ''));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'}); fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
export async function openFixturePage(browser, server, options = {}) {
  const page = await browser.newPage();
  page.captureErrors = [];
  page.on('pageerror', error => page.captureErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', req => page.captureErrors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) page.captureErrors.push(`HTTP ${response.status()}: ${response.url()}`); });
  await page.setViewport(VIEWPORT);
  await page.emulateTimezone('Asia/Shanghai');
  await page.emulateMediaFeatures([{name: 'prefers-color-scheme', value: options.theme ?? 'dark'}]);
  await page.evaluateOnNewDocument(stubSource(fixtures, options));
  await page.goto(`http://127.0.0.1:${server.address().port}/desktop/workbench.html`, {waitUntil: 'load'});
  await waitReady(page, 'home');
  return page;
}
export async function assertNoErrors(page) {
  const errors = await page.evaluate(() => {
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    return [
      ...(window.__yzFixture?.errors ?? []).map(e => `${e.key}: ${e.message}`),
      ...[...document.querySelectorAll('#toast.error, #status.error, .page .err, .page .issue.error, .modal .err')].filter(el => visible(el) && el.textContent.trim()).map(el => `UI: ${el.textContent.trim()}`),
    ];
  });
  if (page.captureErrors.length || errors.length) throw new Error([...page.captureErrors, ...errors].join('\n'));
}
export async function waitReady(page, id) {
  const selector = selectors[id]; if (!selector) throw new Error(`Unknown screenshot scenario: ${id}`);
  await page.waitForFunction(sel => {
    const s = window.__yzFixture;
    if (s?.errors.length) return true;
    const el = document.querySelector(sel);
    return s && s.pending === 0 && el?.getClientRects().length && !document.querySelector('#status.error');
  }, {timeout: 10000}, selector);
  await assertNoErrors(page);
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all([...document.images].filter(img => img.getClientRects().length).map(async img => { await img.decode(); if (!img.naturalWidth) throw new Error(`Image did not load: ${img.src}`); }));
    await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getTiming().iterations ?? 1)).map(a => a.finished.catch(() => {})));
  });
  await assertNoErrors(page);
  const incomplete = await page.evaluate(() => ({pending: window.__yzFixture.pending, loading: [...document.querySelectorAll('.page:not([hidden]) p, .page:not([hidden]) [aria-busy="true"]')].some(el => el.getClientRects().length && (/^(正在检测|扫描中|检测中|加载中)[…\.]*$/.test(el.textContent.trim()) || el.getAttribute('aria-busy') === 'true'))}));
  if (incomplete.pending || incomplete.loading) throw new Error(`Incomplete screenshot state: ${JSON.stringify(incomplete)}`);
}
export async function prepareScenario(page, id) {
  await page.evaluate(seedPage, id);
  if (id === 'favorites' || id === 'assets-viewer') {
    await waitReady(page, 'assets');
    await page.click(id === 'favorites' ? '#as-tab-fav' : '#as-grid .asset-card');
  } else if (id === 'resources') await page.click('#rs-scan');
  await waitReady(page, id);
  if (id === 'settings-lower') {
    await page.$eval('#page-settings', el => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => { const el = document.querySelector('#page-settings'); return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2; });
  }
}
function sourceEvidence() {
  const files = [];
  const walk = dir => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name); if (fs.statSync(file).isDirectory()) walk(file); else files.push(file); } };
  walk(path.join(root, 'desktop/ui')); walk(path.join(root, 'tools/ui-shots'));
  for (const file of ['desktop/workbench.html', 'desktop/workbench.js', 'desktop/workbench.css', 'tools/ui-shots.mjs', 'assets/mark.svg', ...fixtures['assets.list'].items.map(a => a.fixtureImage.replace(/^\//, ''))]) files.push(path.join(root, file));
  const hashes = Object.fromEntries(files.sort().map(file => [path.relative(root, file).replaceAll('\\', '/'), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const git = args => { try { return execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim(); } catch { return null; } };
  return {head: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain', '--', ...Object.keys(hashes)]), sourceHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), sourceFiles: hashes};
}
export async function captureScreenshots({chrome, out, variants = VARIANTS, scenarios = SCENARIOS, fixtureOptions = {}}) {
  const puppeteer = (await import('puppeteer-core')).default;
  out = path.resolve(out); fs.mkdirSync(out, {recursive: true});
  fs.rmSync(path.join(out, 'manifest.json'), {force: true});
  fs.rmSync(path.join(out, 'capture-failure.json'), {force: true});
  let server, browser;
  const manifest = {status: 'complete', evidence: 'static workbench with explicit preload fixtures; not manual acceptance', generatedAt: new Date().toISOString(), ...sourceEvidence(), viewport: VIEWPORT, fixtures: 'tools/ui-shots/fixtures.json', shots: []};
  try {
    server = await startServer();
    browser = await puppeteer.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'], defaultViewport: VIEWPORT});
    manifest.browser = await browser.version();
    for (const [prefix, theme, skin] of variants) {
      for (const id of scenarios) {
        const page = await openFixturePage(browser, server, {...fixtureOptions, theme, skin, ...(id === 'assets-empty' ? {assetMode: 'empty'} : {})});
        try {
          await prepareScenario(page, id);
          const state = await page.evaluate(() => ({theme: document.documentElement.dataset.theme, skin: document.documentElement.dataset.skin ?? 'default', dpr: devicePixelRatio, w: innerWidth, h: innerHeight, calls: [...new Set(window.__yzFixture.completed)]}));
          if (state.theme !== theme || state.skin !== skin) throw new Error(`Appearance mismatch: ${id}`);
          const file = `${prefix}-${id}.png`;
          await page.screenshot({path: path.join(out, file)});
          await assertNoErrors(page);
          manifest.shots.push({file, scenario: id, ...state});
          console.log(file, state.theme, state.skin);
        } finally { await page.close(); }
      }
    }
    if (sourceEvidence().sourceHash !== manifest.sourceHash) throw new Error('Screenshot source changed during capture; regenerate from a stable source tree.');
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (error) {
    fs.writeFileSync(path.join(out, 'capture-failure.json'), JSON.stringify({status: 'failed', error: error.message, completedShots: manifest.shots.length, generatedAt: new Date().toISOString()}, null, 2) + '\n');
    throw error;
  } finally { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const chrome = arg('--chrome', process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome'));
  try { await captureScreenshots({chrome, out: path.resolve(root, arg('--out', 'docs/development/ui-shots'))}); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
