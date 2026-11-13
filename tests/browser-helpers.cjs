'use strict';
const fs = require('node:fs');
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
let puppeteer; try { puppeteer = require('puppeteer-core'); } catch { /* Optional for unit-only local runs. */ }
const skip = !puppeteer || !chrome ? '需要 puppeteer-core 与 Chrome' : false;
if (skip && process.env.REQUIRE_BROWSER_TESTS === '1') throw new Error(skip);
async function browserFixture(t, options = {}) {
  const shots = await import('../tools/ui-shots.mjs');
  const server = await shots.startServer();
  let browser;
  t.after(async () => { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); });
  browser = await puppeteer.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu']});
  const page = await shots.openFixturePage(browser, server, options);
  return {page, browser, server, shots};
}
module.exports = {chrome, skip, browserFixture};
