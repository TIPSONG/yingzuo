'use strict';
// 路径校验：解析到登记根目录后校验；处理 Windows 大小写、保留名、尾随点／空格、
// 中文路径、目录穿越、UNC/设备路径。文件操作以 (rootId, relativePath) 调用。
const nodePath = require('node:path');
const fs = require('node:fs');
const {AppError, CODES} = require('./errors.cjs');
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const INVALID_CHARS = /[<>:"|?*\x00-\x1f]/;

/** 校验单个路径段（Windows 规则，跨平台一律执行，保证数据可迁移到 Windows）。 */
function validateSegment(segment) {
  if (!segment || segment === '.' || segment === '..') return '空段或相对段';
  if (INVALID_CHARS.test(segment)) return '包含 Windows 不允许的字符';
  if (/[. ]$/.test(segment)) return '以点或空格结尾';
  if (RESERVED.test(segment.replace(/[. ]+$/, ''))) return 'Windows 保留名称';
  if (Buffer.byteLength(segment) > 255) return '名称过长';
  return null;
}
/** 校验相对路径（使用 / 或 \ 分隔），返回规范化的段数组。 */
function splitRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024) throw new AppError(CODES.INVALID_PATH, '路径为空或过长。');
  if (relative.includes('\0')) throw new AppError(CODES.INVALID_PATH, '路径包含空字符。');
  if (/^([a-zA-Z]:|[\\/]|\\\\|\/\/)/.test(relative)) throw new AppError(CODES.INVALID_PATH, '这里只接受相对路径。');
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  for (const s of segments) {
    const reason = validateSegment(s);
    if (reason) throw new AppError(CODES.INVALID_PATH, `路径段“${s}”无效：${reason}。`, {details: {segment: s, reason}});
  }
  return segments;
}
const fold = (p, platform) => platform === 'win32' ? p.toLowerCase() : p;
/** 判断 target 是否位于 root 内（含 root 本身），按平台处理大小写。 */
function isInside(root, target, platform = process.platform) {
  const lib = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const r = fold(lib.resolve(root), platform), t = fold(lib.resolve(target), platform);
  const rel = lib.relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !lib.isAbsolute(rel));
}
/** 把相对路径解析到根下；可选检查真实路径（防止符号链接逃逸）。 */
function resolveInside(root, relative, {platform = process.platform, realpath = false} = {}) {
  const lib = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const segments = splitRelative(relative);
  const target = lib.join(lib.resolve(root), ...segments);
  if (!isInside(root, target, platform)) throw new AppError(CODES.PATH_OUTSIDE_ROOT, '路径超出允许的目录。');
  if (realpath && fs.existsSync(target)) {
    const real = fs.realpathSync.native(target), realRoot = fs.realpathSync.native(root);
    if (!isInside(realRoot, real, platform)) throw new AppError(CODES.PATH_OUTSIDE_ROOT, '路径经链接指向允许目录之外。');
  }
  return target;
}
/** 已登记根目录表：外部只能以 rootId 引用。 */
class RootRegistry {
  constructor(platform = process.platform) { this.roots = new Map(); this.platform = platform; }
  register(id, absolutePath, {writable = true, label = id} = {}) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(id)) throw new AppError(CODES.INVALID_ARGUMENT, '根目录标识无效。');
    const lib = this.platform === 'win32' ? nodePath.win32 : nodePath.posix;
    if (!lib.isAbsolute(absolutePath)) throw new AppError(CODES.INVALID_PATH, `根目录 ${id} 必须是绝对路径。`);
    this.roots.set(id, {id, path: lib.resolve(absolutePath), writable, label});
  }
  get(id) { const r = this.roots.get(id); if (!r) throw new AppError(CODES.NOT_FOUND, `未登记的目录：${id}`); return r; }
  resolve(id, relative, options = {}) {
    const root = this.get(id);
    if (options.write && !root.writable) throw new AppError(CODES.FORBIDDEN, `${root.label} 为只读目录。`);
    return relative ? resolveInside(root.path, relative, {platform: this.platform, ...options}) : root.path;
  }
  /** 反查：绝对路径属于哪个根。 */
  locate(absolute) {
    for (const root of this.roots.values()) if (isInside(root.path, absolute, this.platform)) {
      const lib = this.platform === 'win32' ? nodePath.win32 : nodePath.posix;
      return {rootId: root.id, relative: lib.relative(root.path, lib.resolve(absolute)).split(lib.sep).join('/')};
    }
    return null;
  }
  list() { return [...this.roots.values()]; }
}
/** 生成不冲突的文件名：a.png → a (2).png */
function uniqueName(dir, name, exists = p => fs.existsSync(p)) {
  const ext = nodePath.extname(name), base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; exists(nodePath.join(dir, candidate)); i++) { candidate = `${base} (${i})${ext}`; if (i > 9999) throw new AppError(CODES.CONFLICT, '重名文件过多。'); }
  return candidate;
}
module.exports = {validateSegment, splitRelative, isInside, resolveInside, RootRegistry, uniqueName};
