'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {skip, browserFixture} = require('./browser-helpers.cjs');

async function gallery(t, options = {}) {
  const {page, shots} = await browserFixture(t, options);
  await page.evaluateOnNewDocument(() => {
    const original = window.yingzuo;
    window.waiting = [];
    window.largeBoard = false;
    let favoriteCount = 61;
    const ok = data => ({ok: true, data});
    const handlers = {
      get: async id => {
        if (window.holdDetail === id) await new Promise(r => window.waiting.push(r));
        return original.assets.get(id);
      },
      list: async ({query, offset}) => {
        const result = await original.assets.list({query, offset});
        const items = result.data.items;
        if (query === 'hold' || offset > 0) {
          await new Promise(r => window.waiting.push(r));
          return ok({items: [items[2]], total: 2, nextOffset: null});
        }
        if (query === 'more') return ok({items: [items[0]], total: 2, nextOffset: 1});
        if (query) {
          const matches = items.filter(a => a.name.includes(query));
          return ok({items: matches, total: matches.length, nextOffset: null});
        }
        return result;
      },
      favorites: async options => {
        if (!window.largeBoard) return original.assets.favorites(options);
        const {offset, limit, layout} = options;
        const items = Array.from({length: Math.min(limit, Math.max(0, favoriteCount - offset))}, (_, i) => ({
          id: String(offset + i + 1), storedPath: 'collection.png', sourcePath: 'original.png', broken: false,
        }));
        const cells = items.map((f, i) => ({id: f.id, x: 0, y: i * 44, width: layout.width, height: 44}));
        return ok({items, total: favoriteCount, layout: {cells, height: cells.length * 44}});
      },
      thumbnail: (id, opts) => original.assets.thumbnail(window.largeBoard && id.startsWith('favorite:') ? 'asset-1' : id, opts),
      unfavorite: async () => { favoriteCount--; return ok({trashed: 'recycle'}); },
      favorite: async () => ok({duplicate: false}),
    };
    window.yingzuo = new Proxy(original, {get: (o, g) => g === 'assets'
      ? new Proxy(o.assets, {get: (a, k) => handlers[k] ?? a[k]}) : o[g]});
  });
  await page.reload();
  await shots.prepareScenario(page, 'assets');
  return {page, shots};
}

async function search(page, text, submit = true) {
  await page.$eval('#as-q', (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', {bubbles: true}));
  }, text);
  if (submit) await page.$eval('#as-q', input => input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
}
const count = page => page.$eval('#as-count', el => el.textContent);
const ids = page => page.$$eval('#as-grid [data-asset]', els => els.map(el => el.dataset.asset));
const release = page => page.evaluate(() => window.waiting.shift()());

test('gallery ignores stale search, deduplicates load-more clicks, and keeps the active tab count', {skip}, async t => {
  const {page} = await gallery(t);
  await search(page, 'hold');
  await page.waitForFunction(() => window.waiting.length === 1);
  await search(page, 'cat', false);
  await page.waitForFunction(() => document.querySelector('#as-count').textContent === '找到 1 张');
  await release(page);
  assert.deepEqual(await ids(page), ['asset-2']);
  assert.equal(await count(page), '找到 1 张');

  await search(page, 'more');
  await page.waitForSelector('#as-more:not([hidden]):enabled');
  await page.$eval('#as-more', b => { b.click(); b.click(); });
  await page.waitForFunction(() => window.waiting.length === 1);
  assert.equal(await page.$eval('#as-more', b => b.disabled), true);
  await page.click('#as-tab-fav');
  await page.waitForFunction(() => document.querySelector('#as-count').textContent === '收藏 2 张');
  await release(page);
  assert.equal(await count(page), '收藏 2 张');
  assert.equal(await page.$eval('#as-more', b => b.hidden), true);
  assert.equal(await page.evaluate(() => window.waiting.length), 0);
});

test('filtered empty state clears the search, and keyboard viewer returns focus on dismissal', {skip}, async t => {
  const {page, shots} = await gallery(t, {theme: 'light', skin: 'nasa-punk'});
  await page.setViewport({width: 960, height: 700});
  await search(page, 'absent', false);
  await page.waitForSelector('[data-clear-search]');
  assert.match(await page.$eval('#as-grid', el => el.textContent), /没有匹配的作品/);
  assert.equal(await page.$eval('#as-grid', el => {
    const empty = el.firstElementChild.getBoundingClientRect(), grid = el.getBoundingClientRect();
    return Math.abs(empty.width - grid.width) < 2 && grid.right <= innerWidth;
  }), true);
  await page.click('[data-clear-search]');
  await shots.waitReady(page, 'assets');
  assert.equal(await page.$eval('#as-q', el => el === document.activeElement && el.value === ''), true);
  await page.focus('.asset-card'); await page.keyboard.press('Enter'); await shots.waitReady(page, 'assets-viewer');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.v), 'close');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.v), 'fav');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-v="fav"]').textContent === '已收藏');
  assert.equal(await page.$eval('[data-v="fav"]', el => el.disabled), true);
  await page.click('[data-v="close"]');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.asset), 'asset-1');
  await page.keyboard.press('Enter'); await shots.waitReady(page, 'assets-viewer');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.viewer'), null);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.asset), 'asset-1');
  await page.evaluate(() => { window.holdDetail = 'asset-1'; });
  await page.click('[data-asset="asset-1"]');
  await page.waitForFunction(() => window.waiting.length === 1);
  await page.click('[data-asset="asset-2"]');
  await shots.waitReady(page, 'assets-viewer');
  assert.match(await page.$eval('.viewer h3', el => el.textContent), /watercolor_cat/);
  await page.keyboard.press('Escape');
  await release(page);
  await page.waitForFunction(() => window.__yzCalls.filter(([key]) => key === 'assets.shareSupport').length === 4 && !window.__yzFixture.pending);
  assert.equal(await page.$('.viewer'), null);
  await shots.assertNoErrors(page);
});

test('favorite pages navigate and removing the last item on the last page returns to the preceding page', {skip}, async t => {
  const {page} = await gallery(t);
  await page.evaluate(() => { window.largeBoard = true; });
  await page.click('#as-tab-fav');
  await page.waitForSelector('#as-fav-next:not([hidden]):enabled');
  assert.match(await count(page), /显示 1–60/);
  await page.click('#as-fav-next');
  await page.waitForSelector('[data-cell="61"]');
  assert.match(await count(page), /显示 61–61/);
  assert.equal(await page.$eval('#as-fav-next', b => b.disabled), true);
  await page.click('#as-fav-prev');
  await page.waitForSelector('[data-cell="1"]');
  await page.click('#as-fav-next');
  await page.waitForSelector('[data-cell="61"]');
  await page.click('[data-unfav="61"]');
  await page.waitForSelector('[data-cell="1"]');
  assert.equal(await count(page), '收藏 60 张');
  assert.equal(await page.$eval('#as-fav-prev', b => b.hidden), true);
});
