'use strict';
// D09：取消后退出超时不得当作成功。
const test = require('node:test');
const assert = require('node:assert/strict');
const {prepareQuit} = require('../desktop/services/quit-flow.cjs');
const timeout = () => Object.assign(new Error('超时'), {code: 'TIMEOUT'});
function hooks(cancelResults) {
  const log = [];
  return {log, h: {activeTasks: () => [{id: 't'}], pauseSubmissions: r => log.push(['pause', r]), resumeSubmissions: r => log.push(['resume', r]), waitForIdle: async () => log.push(['wait']),
    cancelActive: async () => { log.push(['cancel']); const r = cancelResults.shift(); if (r) throw r; }}};
}
const boxes = answers => { const seen = []; return {seen, show: async o => { seen.push(o.title); return {response: answers.shift()}; }}; };
test('无任务直接退出', async () => { assert.equal(await prepareQuit({hooks: {activeTasks: () => []}, showMessageBox: () => assert.fail()}), 'quit'); });
test('取消超时：提示后用户选“返回”——不退出并恢复提交', async () => {
  const {h, log} = hooks([timeout()]); const b = boxes([1, 2]);
  assert.equal(await prepareQuit({hooks: h, showMessageBox: b.show}), 'return');
  assert.deepEqual(b.seen, ['任务正在运行', '任务尚未结束']);
  assert.deepEqual(log.at(-1), ['resume', 'quit']);
});
test('取消超时：继续等待后成功才退出；选“仍然退出”时明确退出', async () => {
  const a = hooks([timeout(), null]); assert.equal(await prepareQuit({hooks: a.h, showMessageBox: boxes([1, 0]).show}), 'quit');
  assert.equal(a.log.filter(x => x[0] === 'cancel').length, 2);
  const c = hooks([timeout()]); assert.equal(await prepareQuit({hooks: c.h, showMessageBox: boxes([1, 1]).show}), 'quit');
});
test('其他错误：恢复提交并抛出', async () => {
  const {h, log} = hooks([new Error('坏')]);
  await assert.rejects(prepareQuit({hooks: h, showMessageBox: boxes([1]).show}), /坏/);
  assert.deepEqual(log.at(-1), ['resume', 'quit']);
});
