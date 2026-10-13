'use strict';
// R21：第二个实例在加载 main.cjs（迁移、写工作区）之前退出。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
function load(lock) {
  const calls = []; const app = {isPackaged: false, setPath: (k, v) => calls.push(['setPath', k, v]), requestSingleInstanceLock: () => { calls.push(['lock']); return lock; }, quit: () => calls.push(['quit'])};
  const orig = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === 'electron') return {app};
    if (req === './main.cjs') { calls.push(['main']); return {}; }
    return orig.call(this, req, parent, ...rest);
  };
  try { delete require.cache[require.resolve('../desktop/entry.cjs')]; require('../desktop/entry.cjs'); } finally { Module._load = orig; }
  return calls.map(c => c[0]);
}
test('第一实例：先设 userData、取锁，再加载主进程', () => assert.deepEqual(load(true), ['setPath', 'lock', 'main']));
test('第二实例：取锁失败直接退出，不加载主进程', () => assert.deepEqual(load(false), ['setPath', 'lock', 'quit']));
