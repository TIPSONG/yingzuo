'use strict';
// 开发进度记录工具：tasks.json 是事实源，Markdown 由此生成。
// 用法：node tools/progress.cjs set <ID[,ID..]> <状态> [--commit X] [--files a,b] [--checks "..."] [--note "..."]
//       node tools/progress.cjs render
const fs = require('node:fs');
const path = require('node:path');
const FILE = path.join(__dirname, '..', 'docs', 'development', 'tasks.json');
const OUT = path.join(__dirname, '..', 'docs', 'development', 'Grovebot开发进度.md');
const STATES = ['未开始', '实现中', '程序完成', '有限支持', '阻塞'];
const tasks = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const [cmd, ids, status, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
if (cmd === 'set') {
  if (!STATES.includes(status)) throw new Error('状态必须是：' + STATES.join('/'));
  for (const id of ids.split(',')) {
    const t = tasks.find(x => x.id === id);
    if (!t) throw new Error('未知任务 ' + id);
    t.status = status;
    if (opt.commit) t.commit = opt.commit;
    if (opt.files) t.files = opt.files.split(',');
    if (opt.checks) t.checks = opt.checks;
    if (opt.note !== undefined) t.note = opt.note;
  }
  fs.writeFileSync(FILE, JSON.stringify(tasks, null, 1) + '\n');
}
const esc = s => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const count = s => tasks.filter(t => t.status === s).length;
const header = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('<!-- TABLE -->')[0] : '# Grovebot 开发进度\n\n';
let md = header + '<!-- TABLE -->\n\n';
md += `统计：程序完成 ${count('程序完成')} / 有限支持 ${count('有限支持')} / 实现中 ${count('实现中')} / 阻塞 ${count('阻塞')} / 未开始 ${count('未开始')}（共 ${tasks.length}）。“程序完成”不等于 Codex 验收通过。\n\n`;
for (const b of [1, 2, 3, 4, 5, 6]) {
  md += `### 批次 ${b}\n\n| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const t of tasks.filter(x => x.batch === b)) md += `| ${t.id} | ${esc(t.name)} | ${t.status} | ${esc(t.commit)} | ${esc(t.files.join('<br>'))} | ${esc(t.checks)} | ${esc(t.note)} |  |\n`;
  md += '\n';
}
fs.writeFileSync(OUT, md);
