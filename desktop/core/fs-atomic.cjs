'use strict';
// 原子文件写入、带版本 JSON、损坏隔离。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {AppError, CODES} = require('./errors.cjs');

function writeFileAtomic(file, data, {mode} = {}) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'w', mode);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); }
  catch (error) { try { fs.rmSync(temp, {force: true}); } catch { /* 忽略 */ } throw error; }
}
function writeJsonAtomic(file, value) { writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n'); }
/** 把损坏文件改名保留，不删除。返回保留路径。 */
function quarantine(file, reason = 'corrupt') {
  const target = `${file}.${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, target);
  return target;
}
/**
 * 读取带版本 JSON 并按需迁移。
 * migrations: { [fromVersion]: data => dataOfNextVersion }，currentVersion：目标版本。
 * 返回 { data, migrated, from, corrupt?, quarantined? }。
 */
function readVersionedJson(file, {currentVersion, migrations = {}, validate = x => x, defaults, maxBytes = 64 * 1024 * 1024}) {
  if (!fs.existsSync(file)) return {data: validate(typeof defaults === 'function' ? defaults() : structuredClone(defaults)), migrated: false, from: null, created: true};
  if (fs.statSync(file).size > maxBytes) throw new AppError(CODES.CORRUPT_DATA, `${path.basename(file)} 超过大小限制。`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new AppError(CODES.CORRUPT_DATA, `${path.basename(file)} 不是有效 JSON：${error.message}`, {details: {file}}); }
  if (!data || typeof data !== 'object' || !Number.isInteger(data.version)) throw new AppError(CODES.CORRUPT_DATA, `${path.basename(file)} 缺少版本号。`, {details: {file}});
  if (data.version > currentVersion) throw new AppError(CODES.UNSUPPORTED, `${path.basename(file)} 来自更新的映作版本（v${data.version}），为避免损坏已只读。`, {details: {file, version: data.version}});
  const from = data.version;
  while (data.version < currentVersion) {
    const step = migrations[data.version];
    if (!step) throw new AppError(CODES.MIGRATION_FAILED, `缺少 v${data.version} 的迁移规则。`);
    const next = step(structuredClone(data));
    if (next.version !== data.version + 1) throw new AppError(CODES.MIGRATION_FAILED, `迁移 v${data.version} 未产生下一版本。`);
    data = next;
  }
  return {data: validate(data), migrated: from !== currentVersion, from};
}
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', c => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
  });
}
module.exports = {writeFileAtomic, writeJsonAtomic, quarantine, readVersionedJson, sha256, sha256File};
