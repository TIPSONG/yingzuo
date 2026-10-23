'use strict';
// RV05：启动早期的应用数据恢复。恢复执行前只用无副作用的路径描述，不创建受恢复的目标目录
// （drafts/templates 等在 preserve 之后不存在，提前 mkdir 会让继续恢复在 swap 时因“目标仍存在”失败）。
// 只创建不属于恢复目标的控制目录（migrations 存放 journal、logs）。恢复成功后由 main.cjs 正常 ensureLayout。
const fs = require('node:fs');
const path = require('node:path');

const PENDING = 'pending-app-restore.json';
const hasPending = root => fs.existsSync(path.join(root, PENDING));
function prepareRestoreLayout(root) {
  const {describeLayout} = require('./repositories/data-root.cjs');
  const layout = describeLayout(root);
  for (const d of [layout.migrations, layout.logs]) if (d) fs.mkdirSync(d, {recursive: true});
  return layout;
}
/** 返回 {mode:'main'|'recovery', layout, result}。异常一律进入恢复模式，不默默转入普通主进程。 */
async function runStartupRestore(root, {applyPending = null} = {}) {
  let layout;
  try { layout = prepareRestoreLayout(root); }
  catch (e) { return {mode: 'recovery', layout: {root, logs: path.join(root, 'logs'), migrations: path.join(root, 'migrations')}, result: {status: 'failed', recovery: true, error: `无法准备恢复：${e.message}`}}; }
  const apply = applyPending ?? require('./maintenance/app-backup.cjs').applyPendingAppRestore;
  let r;
  try { r = await apply(layout); } catch (e) { r = {status: 'failed', recovery: true, error: e.message}; }
  if (!r) r = {status: 'failed', recovery: true, error: '恢复标记无法执行'};
  return {mode: r.recovery ? 'recovery' : 'main', layout, result: r};
}
module.exports = {hasPending, prepareRestoreLayout, runStartupRestore};
