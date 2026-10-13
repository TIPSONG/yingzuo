// RV15：可复现的界面截图脚本。用法：
//   npm i --no-save puppeteer-core   （仓库不把它列为依赖）
//   node tools/ui-shots.mjs [--chrome /path/to/chrome] [--out docs/development/ui-shots]
// 主题与皮肤通过替身 settings.get 的配置驱动（走真实 loadSettings → applyAppearance），每张图共用 tools/ui-shots/fixtures.json 的同一份内容。
// 输出 manifest.json 记录 git HEAD、视口、DPR、浏览器版本与每张图的主题/皮肤。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const out = path.resolve(root, arg('--out', 'docs/development/ui-shots'));
const chrome = arg('--chrome', process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome'));
const VIEWPORT = {width: 1440, height: 960, deviceScaleFactor: 1};
const puppeteer = (await import('puppeteer-core')).default;
const stubSource = require('./ui-shots/stub.cjs');
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tools/ui-shots/fixtures.json'), 'utf8'));
const {seedPage} = require('./ui-shots/seed.cjs');

const mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json'};
export async function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(root, url === '/' ? 'desktop/workbench.html' : url.replace(/^\//, ''));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'}); fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return server;
}
const VARIANTS = [['default', 'dark', 'default'], ['light', 'light', 'default'], ['nasa', 'dark', 'nasa-punk'], ['nasa-light', 'light', 'nasa-punk']];
const PAGES = ['home', 'create', 'create-start', 'templates', 'online', 'assets', 'resources', 'queue', 'services', 'settings'];

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}/desktop/workbench.html`;
const browser = await puppeteer.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`], defaultViewport: VIEWPORT});
const head = (() => { try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(); } catch { return null; } })();
const dirty = (() => { try { return execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'desktop']).toString().trim().length > 0; } catch { return null; } })();
const manifest = {generatedAt: new Date().toISOString(), head, desktopDirty: dirty, browser: await browser.version(), viewport: VIEWPORT, fixtures: 'tools/ui-shots/fixtures.json', shots: []};
fs.mkdirSync(out, {recursive: true});
for (const [prefix, theme, skin] of VARIANTS) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{name: 'prefers-color-scheme', value: theme}]);
  await page.evaluateOnNewDocument(stubSource(fixtures, {theme, skin}));
  await page.goto(base, {waitUntil: 'networkidle0'});
  await page.waitForFunction(t => document.documentElement.dataset.theme === t, {}, theme);
  for (const id of PAGES) {
    await page.evaluate(seedPage, id);
    await new Promise(r => setTimeout(r, 150));
    // 等主题切换的 CSS 过渡全部结束，避免截到过渡中的混合色
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
    const state = await page.evaluate(() => ({theme: document.documentElement.dataset.theme, skin: document.documentElement.dataset.skin ?? 'default', dpr: devicePixelRatio, w: innerWidth, h: innerHeight}));
    const file = `${prefix}-${id}.png`;
    await page.screenshot({path: path.join(out, file)});
    manifest.shots.push({file, page: id, ...state});
    console.log(file, state.theme, state.skin);
  }
  await page.close();
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await browser.close(); server.close();
