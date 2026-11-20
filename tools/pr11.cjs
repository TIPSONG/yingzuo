'use strict';
// PR #11 审阅问题（D01–D15）与后续程序任务（PR11-R01–R22）状态。数据在 docs/development/pr11-status.json，
// 渲染到 Grovebot开发进度.md 的 <!-- PR11 --> 区块。用法：
//   node tools/pr11.cjs set <ID[,ID..]> <状态> [--commit X] [--tests "..."] [--note "..."]
//   node tools/pr11.cjs render
const fs = require('node:fs');
const path = require('node:path');
const DATA = path.join(__dirname, '..', 'docs', 'development', 'pr11-status.json');
const OUT = path.join(__dirname, '..', 'docs', 'development', 'Grovebot开发进度.md');
const STATES = ['程序完成', '实现中', '阻塞', '未开始', '有限支持'];
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const [cmd, ids, status, ...rest] = process.argv.slice(2);
if (cmd === 'set') {
  if (!STATES.includes(status)) throw new Error(`状态只能是 ${STATES.join('/')}`);
  const opt = {}; for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  for (const id of ids.split(',')) { const it = data.items.find(x => x.id === id); if (!it) throw new Error(`未知 ${id}`); Object.assign(it, {status}, opt.commit ? {commit: opt.commit} : {}, opt.tests ? {tests: opt.tests} : {}, opt.note ? {note: opt.note} : {}); }
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
}
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
let md = '<!-- PR11 -->\n## PR #11 审阅修复（2026-10-13 起）\n\n来源：`docs/development/PR11代码审阅与下一轮程序计划.md`（审阅 head 47e2e18）。审阅里的任务编号 R01–R22 与原计划的 R01–R08（资源任务）重名，这里统一写作 **PR11-R01…R22**。\n\n';
for (const [title, pre] of [['审阅发现', 'D'], ['后续程序任务', 'PR11-R'], ['第二轮审阅发现（PR11第二轮代码审阅与收尾计划.md，审阅 head 68f7598）', 'N'], ['第二轮收尾任务', 'S'], ['第三轮收尾任务（PR11第三轮代码审阅与最终收尾计划.md，审阅 head f493fce）', 'C0'], ['代码与截图审阅（PR11代码与截图审阅-d5cca17.md，审阅 head d5cca17；人工验收栏由验收方填写）', 'RV'], ['Codex 复审修复（aab1998；证据见当前状态与验证证据.md）', 'RR']]) {
  const accept = pre === 'RV' || pre === 'RR'; // 人工验收列始终留空
  md += `### ${title}\n\n| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 |${accept ? ' 人工验收 |' : ''}\n| --- | --- | --- | --- | --- | --- | --- |${accept ? ' --- |' : ''}\n`;
  for (const it of data.items.filter(x => x.id.startsWith(pre))) md += `| ${it.id} | ${it.level} | ${esc(it.name)} | ${it.status} | ${esc(it.commit)} | ${esc(it.tests)} | ${esc(it.note)} |${accept ? '  |' : ''}\n`;
  md += '\n';
}
md += '<!-- /PR11 -->';
let doc = fs.readFileSync(OUT, 'utf8');
if (doc.includes('<!-- PR11 -->')) doc = doc.replace(/<!-- PR11 -->[\s\S]*?<!-- \/PR11 -->/, md);
else doc = doc.replace('<!-- TABLE -->', md + '\n\n<!-- TABLE -->');
fs.writeFileSync(OUT, doc);
