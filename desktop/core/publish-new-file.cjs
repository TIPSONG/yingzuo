'use strict';
const fs = require('node:fs');
const {pipeline} = require('node:stream/promises');

const sameVersion = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;
const inspect = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const identityFromStat = st => st.isFile() && String(st.ino) !== '0' ? {dev: String(st.dev), ino: String(st.ino), birthtimeNs: String(st.birthtimeNs ?? st.birthtimeMs)} : null;
function fileIdentity(file) { try { return identityFromStat(fs.lstatSync(file, {bigint: true})); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
const sameIdentity = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
function openOwnedTemp(file, expected = null) {
  const fd = fs.openSync(file, expected ? 'r+' : 'wx');
  const identity = identityFromStat(fs.fstatSync(fd, {bigint: true}));
  if (!identity || (expected && !sameIdentity(expected, identity))) {
    fs.closeSync(fd);
    throw Object.assign(new Error('临时文件身份已变化，未写入。'), {code: 'SOURCE_CHANGED'});
  }
  return {fd, identity};
}

/** Publish an owned temporary file without replacing a destination created by another writer.
 * Hard links claim the destination atomically. Filesystems without links use exclusive copy.
 * A replaced temporary path is preserved; the caller may separately report pending cleanup. */
async function publishNewFile(temp, destination) {
  const source = fs.lstatSync(temp), sourceIdentity = fileIdentity(temp);
  if (!source.isFile() || !sourceIdentity) throw Object.assign(new Error('无法确认发布源文件的身份。'), {code: 'EINVAL'});
  let targetIdentity = sourceIdentity;
  const removeOwnedTarget = () => { if (sameIdentity(targetIdentity, fileIdentity(destination))) fs.unlinkSync(destination); };
  try { fs.linkSync(temp, destination); }
  catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    // Keep the identity of the inode created by our exclusive open, rather than
    // assuming a post-copy path lookup still belongs to us.
    const fd = fs.openSync(destination, 'wx');
    targetIdentity = identityFromStat(fs.fstatSync(fd, {bigint: true}));
    if (!targetIdentity) { fs.closeSync(fd); throw Object.assign(new Error('无法确认目标文件身份，临时源已保留。'), {code: 'EINVAL'}); }
    try { await pipeline(fs.createReadStream(temp), fs.createWriteStream(destination, {fd, autoClose: true})); }
    catch (e) { removeOwnedTarget(); throw e; }
  }
  const published = fs.lstatSync(destination), current = inspect(temp);
  if (!current || !sameIdentity(sourceIdentity, fileIdentity(temp)) || !sameVersion(source, current) || !sameIdentity(targetIdentity, fileIdentity(destination)) || published.size !== source.size) {
    removeOwnedTarget();
    throw Object.assign(new Error('临时文件在发布期间已变化，未提交结果。'), {code: 'SOURCE_CHANGED'});
  }
  let tempRetained = false;
  try {
    const pending = inspect(temp);
    if (pending && sameIdentity(sourceIdentity, fileIdentity(temp)) && sameVersion(source, pending)) fs.unlinkSync(temp);
    else tempRetained = !!pending;
  } catch { tempRetained = true; } // The verified destination is already committed; keep cleanup recoverable.
  return {bytes: published.size, tempRetained};
}
module.exports = {publishNewFile, fileIdentity, identityFromStat, sameIdentity, openOwnedTemp};
