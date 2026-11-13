'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {skip, browserFixture} = require('./browser-helpers.cjs');
async function open(t, options) {
  const f = await browserFixture(t, options);
  await f.shots.prepareScenario(f.page, 'settings');
  return f.page;
}
const value = (page, key) => page.$eval(`[data-key="${key}"]`, el => el.value);
const edit = (page, key, text) => page.$eval(`[data-key="${key}"]`, (el, text) => { el.value = text; el.dispatchEvent(new Event('input', {bubbles: true})); }, text);
const click = (page, selector) => page.$eval(selector, el => el.click());
const finished = (page, count) => page.waitForFunction(n => window.__yzFixture.completed.filter(k => k === 'settings.update').length >= n, {}, count);
test('RR07: a save acknowledges only submitted revisions; later field edits survive and are saved next', {skip}, async t => {
  const page = await open(t, {updateDelayMs: 400});
  await edit(page, 'comfy.root', 'E:\\A'); await click(page, '#settings-save');
  await edit(page, 'comfy.root', 'E:\\B'); await edit(page, 'lmstudio.url', 'http://127.0.0.1:4567/v1');
  await finished(page, 1);
  assert.equal(await value(page, 'comfy.root'), 'E:\\B');
  assert.equal(await value(page, 'lmstudio.url'), 'http://127.0.0.1:4567/v1');
  assert.equal(await page.$eval('[data-key="comfy.root"]', el => el.classList.contains('dirty')), true);
  await click(page, '#settings-save'); await finished(page, 2);
  const saved = await page.evaluate(() => window.__yzFixture.savedSettings.config);
  assert.equal(saved.comfy.root, 'E:\\B'); assert.equal(saved.lmstudio.url, 'http://127.0.0.1:4567/v1');
  assert.equal(await page.$eval('[data-key="comfy.root"]', el => el.classList.contains('dirty')), false);
});
test('RR07: consecutive saves are serialized even when the second response would be faster', {skip}, async t => {
  const page = await open(t, {updatePlan: [{delayMs: 450}, {delayMs: 5}]});
  await edit(page, 'comfy.root', 'E:\\A'); await click(page, '#settings-save');
  await edit(page, 'comfy.root', 'E:\\B'); await click(page, '#settings-save');
  await edit(page, 'comfy.root', 'E:\\C');
  await finished(page, 2);
  assert.equal(await value(page, 'comfy.root'), 'E:\\C');
  const state = await page.evaluate(() => ({saved: window.__yzFixture.savedSettings.config.comfy.root, max: window.__yzFixture.maxUpdatesInFlight, submitted: window.__yzCalls.filter(c => c[0] === 'settings.update').map(c => c[1][0].comfy.root)}));
  assert.deepEqual(state, {saved: 'E:\\B', max: 1, submitted: ['E:\\A', 'E:\\B']});
});
test('RR07: appearance and path changes during save keep later drafts and latest preview', {skip}, async t => {
  const page = await open(t, {updateDelayMs: 300, pickDelayMs: 120});
  await edit(page, 'comfy.root', 'E:\\A'); await click(page, '#settings-save');
  await edit(page, 'comfy.root', 'E:\\B'); await click(page, '[data-theme-set="light"]');
  await click(page, '[data-pick="comfy.python"]'); await edit(page, 'comfy.python', 'E:\\new-python.exe');
  await finished(page, 1);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.waitForFunction(() => window.__yzFixture.completed.includes('settings.pickPath'));
  assert.equal(await value(page, 'comfy.root'), 'E:\\B');
  assert.equal(await value(page, 'comfy.python'), 'E:\\new-python.exe');
  assert.equal(await page.evaluate(() => window.__yzFixture.savedSettings.config.ui.theme), 'light');
});
test('RR07: failed save retains all drafts and does not poison the next queued save', {skip}, async t => {
  const page = await open(t, {updatePlan: [{delayMs: 300, fail: true}, {delayMs: 5}]});
  await edit(page, 'comfy.root', 'E:\\A'); await click(page, '#settings-save'); await edit(page, 'comfy.root', 'E:\\B');
  await finished(page, 1);
  assert.equal(await value(page, 'comfy.root'), 'E:\\B');
  await click(page, '#settings-save'); await finished(page, 2);
  assert.equal(await page.evaluate(() => window.__yzFixture.savedSettings.config.comfy.root), 'E:\\B');
});
