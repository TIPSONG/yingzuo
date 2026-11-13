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

/* C04：恢复失败时进入独立恢复模式，不加载 main.cjs */
test('C04：应用数据恢复失败→加载恢复模式而不是主进程；成功→主进程', async () => {
  const fs = require('node:fs'), os = require('node:os');
  for (const [res, expect] of [[{status: 'failed', recovery: true, error: 'x'}, 'recovery'], [{status: 'restored'}, 'main'], [null, 'recovery']]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-entry-')); fs.writeFileSync(path.join(root, 'pending-app-restore.json'), '{}');
    const calls = []; const app = {isPackaged: false, setPath() {}, requestSingleInstanceLock: () => true, quit() {}};
    const orig = Module._load;
    Module._load = function (req, parent, ...rest) {
      if (req === 'electron') return {app};
      if (req === './main.cjs') { calls.push('main'); return {}; }
      if (req === './recovery.cjs') return {startRecovery: () => calls.push('recovery')};
      if (req === './repositories/data-root.cjs') return {resolveDataRoot: () => ({root}), ensureLayout: r => ({root: r}), describeLayout: r => ({root: r})};
      if (req === './maintenance/app-backup.cjs') return {applyPendingAppRestore: async () => { if (!res) throw new Error('标记损坏'); return res; }};
      return orig.call(this, req, parent, ...rest);
    };
    try { delete require.cache[require.resolve('../desktop/entry.cjs')]; require('../desktop/entry.cjs'); await new Promise(r => setTimeout(r, 20)); } finally { Module._load = orig; }
    assert.deepEqual(calls, [expect]);
  }
});
test('C04：恢复模式处理函数只读恢复记录，不创建数据库；选择后重启', () => {
  const fs = require('node:fs'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rec-'));
  const layout = {root, migrations: path.join(root, 'migrations'), logs: path.join(root, 'logs'), database: path.join(root, 'app.db')};
  fs.writeFileSync(path.join(root, 'pending-app-restore.json'), JSON.stringify({dir: '/b', action: null, journalId: 'rs-1', error: 'swap 失败'}));
  const calls = []; const app = {relaunch: () => calls.push('relaunch'), exit: c => calls.push(`exit${c}`)};
  const {createRecoveryHandlers} = require('../desktop/recovery.cjs');
  const h = createRecoveryHandlers({layout, result: {status: 'failed', error: 'swap 失败', journalId: 'rs-1'}, app, shell: {openPath: async () => ''}});
  assert.equal(h.state().error, 'swap 失败');
  h.choose('rollback');
  assert.deepEqual(calls, ['relaunch', 'exit0']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pending-app-restore.json'), 'utf8')).action, 'rollback');
  assert.ok(!fs.existsSync(layout.database), '恢复模式不打开/创建数据库');
  fs.writeFileSync(path.join(root, 'pending-app-restore.json'), '{broken');
  assert.throws(() => h.choose('bogus'));
  h.choose('rollback'); // 标记损坏且无 journal：取消登记
  assert.ok(!fs.existsSync(path.join(root, 'pending-app-restore.json')));
});
