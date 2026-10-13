'use strict';
// F08/B02：开发检查。语法、接口白名单一致性、禁止的通用接口、JSON 有效性。
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const problems = [];
const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk(root);
for (const file of files.filter(f => /\.(c?js|mjs)$/.test(f))) {
  const r = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  if (r.status !== 0) problems.push(`语法错误 ${path.relative(root, file)}：${r.stderr.split('\n').slice(0, 4).join(' ')}`);
}
for (const file of files.filter(f => f.endsWith('.json') && !f.includes(`${path.sep}fixtures${path.sep}`))) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(`JSON 无效 ${path.relative(root, file)}：${e.message}`); }
}
// preload 中公开的分组方法必须都在主进程 API 中实现，且不得出现通用文件/命令接口。
const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.cjs'), 'utf8');
const groups = /const GROUPS = (\{[\s\S]*?\n\});/.exec(preload);
if (!groups) problems.push('preload.cjs 中找不到 GROUPS');
else {
  const declared = Function(`return ${groups[1]}`)();
  const apiSource = fs.readFileSync(path.join(root, 'desktop', 'services', 'api.cjs'), 'utf8') + fs.readdirSync(path.join(root, 'desktop', 'services')).map(f => fs.readFileSync(path.join(root, 'desktop', 'services', f), 'utf8')).join('\n');
  for (const [group, names] of Object.entries(declared)) for (const name of names) if (!apiSource.includes(`'${group}.${name}'`)) problems.push(`preload 公开了 ${group}.${name}，但主进程没有实现`);
  for (const banned of ['exec', 'readFile', 'writeFile', 'spawn', 'shell']) if (Object.values(declared).flat().includes(banned)) problems.push(`preload 不得公开通用接口 ${banned}`);
}
if (/nodeIntegration\s*:\s*true/.test(files.filter(f => f.endsWith('.cjs') && f.includes(`${path.sep}desktop${path.sep}`)).map(f => fs.readFileSync(f, 'utf8')).join('\n'))) problems.push('发现 nodeIntegration:true');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`check 通过：${files.filter(f => /\.(c?js|mjs)$/.test(f)).length} 个脚本语法正确，接口白名单一致。`);
