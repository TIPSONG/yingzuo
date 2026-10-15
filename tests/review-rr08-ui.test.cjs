'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {chrome, skip, browserFixture} = require('./browser-helpers.cjs');
test('RR08: delayed asset API waits for completion; real grid, favorites and viewer render fixture images', {skip}, async t => {
  const {page, shots} = await browserFixture(t, {delays: {'assets.list': 550}});
  const start = Date.now(); await shots.prepareScenario(page, 'assets');
  assert.ok(Date.now() - start >= 500);
  assert.equal(await page.$$eval('#as-grid .asset-card img', images => images.filter(i => i.naturalWidth > 0).length), 3);
  await shots.prepareScenario(page, 'favorites');
  assert.equal(await page.$$eval('#as-board .cell img', images => images.filter(i => i.naturalWidth > 0).length), 2);
  await page.click('#as-tab-all'); await shots.waitReady(page, 'assets');
  await page.click('#as-grid .asset-card'); await shots.waitReady(page, 'assets-viewer');
  assert.match(await page.$eval('.viewer .meta', el => el.textContent), /Studio portrait/);
  const bounds = await page.evaluate(() => {
    const modal = document.querySelector('.modal').getBoundingClientRect();
    const meta = document.querySelector('.viewer .meta').getBoundingClientRect();
    const close = document.querySelector('[data-v="close"]').getBoundingClientRect();
    return {metadataInside: meta.left >= modal.left && meta.right <= modal.right, closeInside: close.right <= modal.right && close.bottom <= modal.bottom};
  });
  assert.deepEqual(bounds, {metadataInside: true, closeInside: true});
  await page.click('[data-v="close"]');
  assert.equal(await page.$('.viewer'), null);
});
test('RR08: an explicit empty array renders the actual empty state without seeded HTML', {skip}, async t => {
  const {page, shots} = await browserFixture(t, {assetMode: 'empty'});
  await shots.prepareScenario(page, 'assets-empty');
  assert.match(await page.$eval('#as-grid', el => el.textContent), /还没有作品/);
  assert.equal(await page.$$eval('#as-grid .asset-card', cards => cards.length), 0);
});
test('RR08: recycling and application-backup handlers register without an out-of-scope startup error', {skip}, async t => {
  const {page, shots} = await browserFixture(t);
  await shots.prepareScenario(page, 'resources');
  await page.click('#rs-trash');
  await page.waitForFunction(() => document.querySelector('#rs-maint').textContent.includes('回收区为空'));
  await page.click('#rs-appbk');
  await page.waitForFunction(() => document.querySelector('#rs-maint').textContent.includes('还没有应用数据备份'));
  await shots.assertNoErrors(page);
  assert.deepEqual(await page.evaluate(() => window.__yzCalls.filter(c => ['trash.list', 'maintenance.appBackups'].includes(c[0])).map(c => c[0])), ['trash.list', 'maintenance.appBackups']);
});
test('RR08: four styles use identical asset data; lower settings and missing fixtures are checked', {skip}, async t => {
  const {page, browser, server, shots} = await browserFixture(t);
  await page.close();
  for (const [, theme, skin] of shots.VARIANTS) {
    const p = await shots.openFixturePage(browser, server, {theme, skin});
    assert.equal(await p.evaluate(() => { const bar = document.querySelector('#titlebar').getBoundingClientRect(); const controls = document.querySelector('.titlebar-controls').getBoundingClientRect(); return controls.top >= bar.top && controls.bottom <= bar.bottom; }), true, `${theme}/${skin}: titlebar controls must not be clipped by generic header padding`);
    await shots.prepareScenario(p, 'assets');
    assert.deepEqual(await p.$$eval('#as-grid .asset-card', cards => cards.map(c => c.dataset.asset)), ['asset-1', 'asset-2', 'asset-3']);
    await shots.prepareScenario(p, 'settings-lower');
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), theme);
    assert.equal(await p.evaluate(() => document.documentElement.dataset.skin ?? 'default'), skin);
    assert.equal(await p.$eval('#page-settings', el => el.scrollTop > 0), true);
    await p.close();
  }
  const missing = await shots.openFixturePage(browser, server, {omit: ['assets.list']});
  await assert.rejects(shots.prepareScenario(missing, 'assets'), /Unsupported fixture API: assets.list/);
  await missing.close();
});
test('RR08: failed capture exits nonzero and cannot leave a successful manifest', {skip}, t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'yingzuo-rr08-'));
  t.after(() => fs.rmSync(out, {recursive: true, force: true}));
  fs.writeFileSync(path.join(out, 'manifest.json'), '{"status":"complete"}');
  const moduleUrl = pathToFileURL(path.join(__dirname, '../tools/ui-shots.mjs')).href;
  const code = `import {captureScreenshots} from ${JSON.stringify(moduleUrl)}; try { await captureScreenshots(${JSON.stringify({chrome, out, variants: [['default', 'dark', 'default']], scenarios: ['assets'], fixtureOptions: {omit: ['assets.list']}})}); } catch(e) { console.error(e.message); process.exitCode = 1; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /Unsupported fixture API: assets.list/);
  assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false);
  const failure = JSON.parse(fs.readFileSync(path.join(out, 'capture-failure.json'), 'utf8'));
  assert.equal(failure.status, 'failed'); assert.equal(failure.completedShots, 0);
});
