'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {chrome, skip} = require('./browser-helpers.cjs');
const stub = require('../tools/ui-shots/stub.cjs');

async function fixture(t) {
  const shots = await import('../tools/ui-shots.mjs');
  const server = await shots.startServer();
  let browser;
  t.after(async () => { if (browser) await browser.close(); await new Promise(r => server.close(r)); });
  browser = await require('puppeteer-core').launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu']});
  const page = await browser.newPage(); page.captureErrors = [];
  await page.evaluateOnNewDocument(stub(shots.fixtures, {}));
  await page.evaluateOnNewDocument(() => {
    const original = window.yingzuo;
    window.thumbVersion = 0; window.thumbRequests = 0; window.brokenFavorite = false;
    window.yingzuo = new Proxy(original, {get: (obj, group) => group !== 'assets' ? obj[group] : new Proxy(obj.assets, {get: (api, key) => {
      if (key === 'thumbnail') return async (...args) => {
        window.thumbRequests++;
        if (window.thumbVersion) return {ok: true, data: {dataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><rect width="8" height="4" fill="red"/></svg>')}};
        return api[key](...args);
      };
      if (key === 'scan') return async () => ({ok: true, data: {indexed: 1, missing: 0, errors: []}});
      if (key === 'watch') return async () => ({ok: true, data: {watching: []}});
      if (key === 'favorites') return async (...args) => {
        const r = await api[key](...args);
        if (window.brokenFavorite) r.data.items = r.data.items.map(i => ({...i, broken: true, storedMissing: true}));
        return r;
      };
      if (key === 'favoriteLayout') return async (...args) => window.brokenFavorite ? {ok: true, data: {cells: [], height: 0}} : api[key](...args);
      if (key === 'unfavorite') return async id => { window.removedFavorite = id; return {ok: true, data: {removed: id}}; };
      return api[key];
    }})});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/desktop/workbench.html`);
  return {page, shots};
}

test('rescanning replaced images refreshes gallery thumbnails instead of reusing old data URLs', {skip}, async t => {
  const {page, shots} = await fixture(t);
  await shots.prepareScenario(page, 'assets');
  const first = await page.$eval('#as-grid img', el => el.src);
  const calls = await page.evaluate(() => window.thumbRequests);
  await page.evaluate(() => { window.thumbVersion = 1; });
  await page.click('#as-scan');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('扫描完成'));
  await shots.waitReady(page, 'assets');
  assert.notEqual(await page.$eval('#as-grid img', el => el.src), first);
  assert.ok(await page.evaluate(() => window.thumbRequests) > calls);
});

test('missing favorite copies retain a visible remove action', {skip}, async t => {
  const {page, shots} = await fixture(t);
  await page.evaluate(() => { window.brokenFavorite = true; });
  await page.click('[data-page="assets"]');
  await shots.waitReady(page, 'assets');
  await page.click('#as-tab-fav');
  await page.waitForFunction(() => document.querySelector('#as-count').textContent.includes('文件丢失'));
  assert.equal(await page.$$eval('#as-board [data-unfav]', els => els.length), 2);
  const id = await page.$eval('#as-board [data-unfav]', el => el.dataset.unfav);
  await page.click('#as-board [data-unfav]');
  assert.equal(await page.evaluate(() => window.removedFavorite), id);
});

test('resizing the favorites board reuses thumbnails while reopening refreshes them', {skip}, async t => {
  const {page, shots} = await fixture(t);
  await shots.prepareScenario(page, 'favorites');
  await page.waitForFunction(() => [...document.querySelectorAll('#as-board [data-fav-thumb]')].every(el => el.querySelector('img')));
  const before = await page.evaluate(() => window.thumbRequests);
  await page.setViewport({width: 1100, height: 800});
  await shots.waitReady(page, 'favorites');
  await page.waitForFunction(() => [...document.querySelectorAll('#as-board [data-fav-thumb]')].every(el => el.querySelector('img')));
  assert.equal(await page.evaluate(() => window.thumbRequests), before, 'layout changes must not reread unchanged image files');
  await page.click('#as-tab-fav');
  await page.waitForFunction(before => window.thumbRequests > before, {}, before);
});
