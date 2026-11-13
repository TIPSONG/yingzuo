'use strict';
// B03/B04：Windows x64 构建（便携包 + NSIS），随后生成产物清单与 SHA256。
// 必须在 Windows 上运行：better-sqlite3 需要按 Electron ABI 为 win32 重建，Linux 交叉编译不可靠。
const fs = require('node:fs');
const path = require('node:path');
const {writeManifest} = require('./release-assets.cjs');
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
const manifest = writeManifest(dist, pkg);
console.log(`已生成 ${manifest.artifacts.length} 个产物清单：dist/artifacts.json、dist/SHA256SUMS.txt`);
