'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {skip, browserFixture} = require('./browser-helpers.cjs');

const portInput = '[data-key="mcp.port"]';
const toggle = '[data-key="mcp.enabled"]';
async function state(page, text) {
  await page.waitForFunction(text => document.querySelector('[data-mcp-state]')?.textContent.includes(text), {}, text);
}
test('MCP 设置从关闭到运行，复制、换密钥及停用走实际按钮，保留其他设置草稿', {skip}, async t => {
  const {page} = await browserFixture(t);
  await page.click('nav [data-page="settings"]');
  await state(page, '已关闭');
  assert.equal(await page.$eval('[data-mcp-copy]', el => el.disabled), true);
  await page.click(toggle);
  await page.locator(portInput).fill('17746');
  assert.equal(await page.$eval('[data-mcp-copy]', el => el.disabled), true);
  await page.click('#settings-save');
  await state(page, 'http://127.0.0.1:17746/mcp');
  await page.locator('[data-key="comfy.root"]').fill('E:\\editing');
  await page.click('[data-mcp-copy]');
  await page.waitForFunction(() => window.__yzFixture.completed.includes('mcp.copyConfig'));
  await page.locator('[data-mcp-rotate]').click();
  await page.click('.modal [data-x="no"]');
  assert.equal(await page.evaluate(() => window.__yzFixture.calls.some(([name]) => name === 'mcp.rotateToken')), false);
  await page.click('[data-mcp-rotate]');
  await page.click('.modal [data-x="yes"]');
  await page.waitForFunction(() => window.__yzFixture.completed.includes('mcp.rotateToken'));
  assert.equal(await page.$eval('[data-key="comfy.root"]', el => el.value), 'E:\\editing');
  await page.click(toggle);
  await page.click('#settings-save');
  await state(page, '已关闭');
  assert.equal(await page.$eval('[data-mcp-copy]', el => el.disabled), true);
  assert.deepEqual(page.captureErrors, []);
});

test('密钥轮换后监听失败时显示运行错误，禁用配置复制', {skip}, async t => {
  const {page} = await browserFixture(t, {mcpPortTakenOnRotate: true});
  await page.click('nav [data-page="settings"]');
  await state(page, '已关闭');
  await page.click(toggle);
  await page.click('#settings-save');
  await state(page, '/mcp');
  await page.click('[data-mcp-rotate]');
  await page.click('.modal [data-x="yes"]');
  await state(page, '已被占用');
  assert.match(await page.$eval('#toast.error', el => el.textContent), /已被占用/);
  assert.equal(await page.$eval('[data-mcp-copy]', el => el.disabled), true);
});

test('MCP 端口占用显示实际错误，修改端口可恢复', {skip}, async t => {
  const {page} = await browserFixture(t, {mcpOccupiedPort: 17742, skin: 'nasa-punk', theme: 'light'});
  await page.setViewport({width: 1050, height: 700});
  await page.click('nav [data-page="settings"]');
  await state(page, '已关闭');
  await page.click(toggle);
  await page.click('#settings-save');
  await state(page, '端口 17742 已被占用');
  assert.equal(await page.$eval('[data-mcp-copy]', el => el.disabled), true);
  await page.locator(portInput).fill('17743');
  await page.click('#settings-save');
  await state(page, 'http://127.0.0.1:17743/mcp');
  await page.$eval('[data-mcp-copy]', el => el.scrollIntoView({block: 'center'}));
  const fits = await page.$eval('#mcp-connection', panel => {
    const rect = panel.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && panel.scrollWidth <= panel.clientWidth;
  });
  assert.ok(fits);
  assert.ok(await page.$eval('#settings-save', button => {
    const rect = button.getBoundingClientRect(), point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return button.contains(point) && getComputedStyle(button.closest('header')).backgroundColor !== 'rgba(0, 0, 0, 0)';
  }));
  assert.deepEqual(page.captureErrors, []);
});
