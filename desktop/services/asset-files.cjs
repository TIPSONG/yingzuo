'use strict';
// A05 文件入口、A06 原图导出、A07 分享副本导出。
// 只通过 shell.openPath / showItemInFolder 打开，从不拼接命令；路径必须位于登记根目录内，失败返回路径与原因。
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../core/errors.cjs');
const {isInside, uniqueName} = require('../core/paths.cjs');
const {stripForShare, detectFormat, shareSupport} = require('../core/image-meta.cjs');

class AssetFiles {
  /** allowedRoots: () => [absolute dir]；shell: Electron shell（可注入替身）。 */
  constructor({shell, allowedRoots, platform = process.platform}) {
    this.shell = shell; this.allowedRootsFn = allowedRoots; this.platform = platform;
  }
  check(file) {
    if (typeof file !== 'string' || !file || file.includes('\0') || !path.isAbsolute(file)) throw new AppError(CODES.INVALID_PATH, `路径无效：${String(file)}`);
    const resolved = path.resolve(file);
    const roots = this.allowedRootsFn().filter(Boolean);
    if (!roots.some(r => isInside(r, resolved, this.platform))) throw new AppError(CODES.PATH_OUTSIDE_ROOT, `不在应用管理的目录内：${resolved}`, {details: {path: resolved}});
    if (!fs.existsSync(resolved)) throw new AppError(CODES.NOT_FOUND, `文件不存在：${resolved}`, {details: {path: resolved, reason: '文件不存在'}});
    return resolved;
  }
  async openFile(file) {
    const p = this.check(file);
    if (fs.statSync(p).isDirectory()) throw new AppError(CODES.INVALID_ARGUMENT, `这是目录，请用“打开所在目录”：${p}`);
    if (/\.(exe|bat|cmd|com|ps1|vbs|js|msi|lnk|scr|hta|jar|sh)$/i.test(p)) throw new AppError(CODES.FORBIDDEN, `不打开可执行文件：${p}`, {details: {path: p, reason: '可执行类型'}});
    const err = await this.shell.openPath(p);
    if (err) throw new AppError(CODES.INTERNAL, `无法打开 ${p}：${err}`, {details: {path: p, reason: err}});
    return {opened: p};
  }
  revealFile(file) { const p = this.check(file); this.shell.showItemInFolder(p); return {revealed: p}; }
  async openDirectory(dir) {
    const p = this.check(dir);
    if (!fs.statSync(p).isDirectory()) throw new AppError(CODES.INVALID_ARGUMENT, `不是目录：${p}`);
    const err = await this.shell.openPath(p);
    if (err) throw new AppError(CODES.INTERNAL, `无法打开 ${p}：${err}`, {details: {path: p, reason: err}});
    return {opened: p};
  }

  /** A06：字节复制，重名生成新文件，绝不覆盖；生成信息随字节保留。 */
  exportOriginal(file, destDir) {
    const src = this.check(file);
    const dest = exclusiveTarget(destDir, path.basename(src), target => fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL));
    const a = fs.statSync(src).size, b = fs.statSync(dest).size;
    if (a !== b) { fs.rmSync(dest, {force: true}); throw new AppError(CODES.INTEGRITY, `复制后大小不一致：${dest}`); }
    return {exported: dest, bytes: b};
  }
  /** A07：容器级清除生成信息与隐私元数据；不支持的格式直接拒绝。 */
  exportShare(file, destDir) {
    const src = this.check(file);
    const buf = fs.readFileSync(src);
    const {buffer, removed, format} = stripForShare(buf);
    const ext = {png: '.png', jpeg: '.jpg', webp: '.webp'}[format];
    const base = path.basename(src, path.extname(src));
    const dest = exclusiveTarget(destDir, `${base}-分享${ext}`, target => fs.writeFileSync(target, buffer, {flag: 'wx'}));
    return {exported: dest, format, removed, bytes: buffer.length};
  }
  shareSupportFor(file) {
    const src = this.check(file);
    const fd = fs.openSync(src, 'r'); const head = Buffer.alloc(16);
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    return {format: detectFormat(head), ...shareSupport(detectFormat(head))};
  }
}
/** 在目录中原子地占用不冲突文件名（EEXIST 时换名重试）。 */
function exclusiveTarget(destDir, name, write) {
  if (typeof destDir !== 'string' || !path.isAbsolute(destDir)) throw new AppError(CODES.INVALID_PATH, '导出目录必须是绝对路径。');
  if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) throw new AppError(CODES.NOT_FOUND, `导出目录不存在：${destDir}`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const target = path.join(destDir, uniqueName(destDir, name));
    try { write(target); return target; }
    catch (e) { if (e.code !== 'EEXIST') throw new AppError(CODES.INTERNAL, `写入失败 ${target}：${e.message}`, {details: {path: target}}); }
  }
  throw new AppError(CODES.CONFLICT, '无法生成不冲突的文件名。');
}
module.exports = {AssetFiles, exclusiveTarget};
