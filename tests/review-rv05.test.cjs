'use strict';
// RV05：通过 entry 等价的启动恢复（runStartupRestore）在 stage/preserve/carry/swap/verify 各步中断后重开并继续；
// 恢复前不重建目标目录；用户之后放入目标路径的真实内容仍触发冲突。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ensureLayout, describeLayout} = require('../desktop/repositories/data-root.cjs');
const A = require('../desktop/maintenance/app-backup.cjs');
const {runStartupRestore, prepareRestoreLayout} = require('../desktop/startup-restore.cjs');

async function fixture(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv05-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const layout = ensureLayout(d);
  fs.writeFileSync(layout.workspace, '{"v":1}');
  fs.writeFileSync(path.join(layout.drafts, 'a.json'), 'draft-v1');
  fs.writeFileSync(path.join(layout.templates, 't.json'), 'tpl-v1');
  const {dir} = await A.createAppBackup({layout});
  fs.writeFileSync(layout.workspace, '{"v":2}');
  fs.writeFileSync(path.join(layout.drafts, 'a.json'), 'draft-v2');
  await A.scheduleAppRestore(layout, dir);
  return {d, layout, dir};
}

test('RV05：prepareRestoreLayout 不创建受恢复目录，只建控制目录', t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv05a-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const l = prepareRestoreLayout(d);
  assert.deepEqual(fs.readdirSync(d).sort(), ['logs', 'migrations']);
  assert.equal(l.drafts, describeLayout(d).drafts);
});

for (const step of ['stage', 'preserve', 'carry', 'swap', 'verify']) {
  test(`RV05：drafts 的 ${step} 步后中断→恢复模式；选择继续后经启动恢复完成，目标内容为备份版本`, async t => {
    const {d, layout} = await fixture(t);
    let armed = true;
    const hooks = {afterStep: async (id, s) => { if (armed && id === 'drafts' && s === step) { armed = false; throw new Error(`模拟在 ${step} 后中断`); } }};
    const first = await runStartupRestore(d, {applyPending: l => A.applyPendingAppRestore(l, {hooks})});
    assert.equal(first.mode, 'recovery');
    A.chooseAppRecovery(describeLayout(d), 'resume');
    // 下次启动：与 entry 相同，只经 runStartupRestore，不先 ensureLayout
    const second = await runStartupRestore(d);
    assert.equal(second.mode, 'main', second.result.error);
    assert.equal(fs.readFileSync(path.join(layout.drafts, 'a.json'), 'utf8'), 'draft-v1');
    assert.equal(fs.readFileSync(layout.workspace, 'utf8'), '{"v":1}');
    assert.ok(!fs.existsSync(path.join(d, 'pending-app-restore.json')));
  });
}

test('RV05：preserve 后旧实现（先 ensureLayout）会失败——证明 bootstrap 顺序是关键', async t => {
  const {d} = await fixture(t);
  let armed = true;
  const hooks = {afterStep: async (id, s) => { if (armed && id === 'drafts' && s === 'preserve') { armed = false; throw new Error('中断'); } }};
  await runStartupRestore(d, {applyPending: l => A.applyPendingAppRestore(l, {hooks})});
  assert.ok(!fs.existsSync(path.join(d, 'drafts')), '中断后目标确实不存在');
  A.chooseAppRecovery(describeLayout(d), 'resume');
  ensureLayout(d); // 旧 entry 的行为
  const r = await runStartupRestore(d);
  assert.equal(r.mode, 'recovery');
  assert.match(r.result.error, /目标仍存在/);
});

test('RV05：中断后用户在目标路径放入真实文件——仍按冲突停止，不删除用户内容', async t => {
  const {d} = await fixture(t);
  let armed = true;
  const hooks = {afterStep: async (id, s) => { if (armed && id === 'drafts' && s === 'preserve') { armed = false; throw new Error('中断'); } }};
  await runStartupRestore(d, {applyPending: l => A.applyPendingAppRestore(l, {hooks})});
  fs.mkdirSync(path.join(d, 'drafts')); fs.writeFileSync(path.join(d, 'drafts', 'user.json'), '用户新内容');
  A.chooseAppRecovery(describeLayout(d), 'resume');
  const r = await runStartupRestore(d);
  assert.equal(r.mode, 'recovery');
  assert.equal(fs.readFileSync(path.join(d, 'drafts', 'user.json'), 'utf8'), '用户新内容');
});

test('RV05：准备布局失败或恢复函数抛错——进入恢复模式，不默默加载主进程', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv05b-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  fs.writeFileSync(path.join(d, 'migrations'), '不是目录'); // mkdir 失败
  assert.equal((await runStartupRestore(d)).mode, 'recovery');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv05c-')); t.after(() => fs.rmSync(d2, {recursive: true, force: true}));
  assert.equal((await runStartupRestore(d2, {applyPending: async () => { throw new Error('boom'); }})).mode, 'recovery');
});
