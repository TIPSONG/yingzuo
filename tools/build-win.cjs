'use strict';
// B03/B04：Windows x64 构建（便携包 + NSIS），随后生成产物清单与 SHA256。
// 必须在 Windows 上运行：better-sqlite3 需要按 Electron ABI 为 win32 重建，Linux 交叉编译不可靠。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' && !process.argv.includes('--manifest-only')) {
  console.error('build:win 需要在 Windows x64 上运行（原生模块 better-sqlite3 必须按 Electron 44 的 win32 ABI 重建）。当前平台：' + process.platform);
  process.exit(2);
}
if (!process.argv.includes('--manifest-only')) {
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  const r = spawnSync(bin, ['--win', 'nsis', 'portable', '--x64', '--publish', 'never'], {cwd: root, stdio: 'inherit', shell: process.platform === 'win32'});
  if (r.status !== 0) { console.error(`electron-builder 失败（退出码 ${r.status}）。`); process.exit(r.status || 1); }
}
const dist = path.join(root, 'dist');
const artifacts = fs.existsSync(dist) ? fs.readdirSync(dist).filter(f => /\.(exe|blockmap)$/i.test(f)) : [];
if (!artifacts.length) { console.error('dist/ 中没有找到 exe 产物。'); process.exit(1); }
const manifest = {
  name: pkg.build.productName, version: pkg.version, builtAt: new Date().toISOString(), platform: 'win32-x64',
  electron: pkg.devDependencies.electron, signed: false,
  note: '未进行代码签名。Windows SmartScreen 可能提示未知发布者。升级不会覆盖 userData；便携版数据在 exe 旁的 data/ 目录（需 portable.flag）。',
  artifacts: artifacts.map(file => { const buf = fs.readFileSync(path.join(dist, file)); return {file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex')}; }),
};
fs.writeFileSync(path.join(dist, 'artifacts.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), manifest.artifacts.map(a => `${a.sha256}  ${a.file}`).join('\n') + '\n');
console.log(`已生成 ${manifest.artifacts.length} 个产物清单：dist/artifacts.json、dist/SHA256SUMS.txt`);
