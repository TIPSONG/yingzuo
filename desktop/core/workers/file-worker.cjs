'use strict';
// R17：大文件工作线程。任务：sha256（带进度）、imageProbe（读取文件头与大小上限，避免整图同步读入主进程）。
const {parentPort} = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');

async function sha256({file, chunk = 4 << 20}, progress) {
  const h = crypto.createHash('sha256'), total = fs.statSync(file).size;
  let done = 0, last = 0;
  for await (const c of fs.createReadStream(file, {highWaterMark: chunk})) {
    h.update(c); done += c.length;
    if (done - last >= 64 << 20 || done === total) { last = done; progress({done, total}); }
  }
  return {sha256: h.digest('hex'), bytes: done};
}
function imageProbe({file, maxBytes = 200 << 20, headBytes = 64 << 10}) {
  const size = fs.statSync(file).size;
  if (size > maxBytes) { const e = new Error(`图片 ${size} 字节，超过上限 ${maxBytes}。`); e.code = 'TOO_LARGE'; throw e; }
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(Math.min(size, headBytes)); fs.readSync(fd, buf, 0, buf.length, 0); return {size, head: buf}; } finally { fs.closeSync(fd); }
}
/** S09：图片元数据在 worker 中读取，只把小结果（格式、生成信息摘要、尺寸）传回主进程，不回传 Buffer。 */
function imageMeta({file, maxBytes = 200 << 20}) {
  const size = fs.statSync(file).size;
  if (size > maxBytes) return {format: null, metadata: {readError: `图片 ${size} 字节，超过读取上限 ${maxBytes}。`}};
  const {detectFormat, readGenerationInfo} = require('../image-meta.cjs');
  const {imageSize} = require('../../services/asset-index.cjs');
  const buf = fs.readFileSync(file);
  return {format: detectFormat(buf), metadata: {generation: readGenerationInfo(buf), dimensions: imageSize(buf)}};
}
/** S09：缩略图在 worker 中由 sharp 生成（限制像素与输入大小），写到调用方给的临时文件。 */
async function thumbnail({src, tmp, size, format = 'webp', maxPixels = 268402689, maxBytes = 300 << 20}) {
  const st = fs.statSync(src);
  if (st.size > maxBytes) throw Object.assign(new Error(`图片 ${st.size} 字节，超过缩略图上限。`), {code: 'TOO_LARGE'});
  let sharp; try { sharp = require('sharp'); } catch (e) { throw Object.assign(new Error(`缩略图组件不可用：${e.message}`), {code: 'UNSUPPORTED'}); }
  sharp.cache(false); sharp.concurrency(1);
  await sharp(src, {limitInputPixels: maxPixels, animated: false}).rotate().resize(size, size, {fit: 'inside', withoutEnlargement: true})[format === 'png' ? 'png' : 'webp'](format === 'png' ? {} : {quality: 80}).toFile(tmp);
  return {bytes: fs.statSync(tmp).size};
}
/** S09：大文件复制（流式，带进度）；目标先写临时名，完成后改名；excl 时目标已存在即失败。 */
async function copyFile({src, dest, excl = true, tmp: given}, progress) {
  if (excl && fs.existsSync(dest)) throw Object.assign(new Error(`目标已存在：${dest}`), {code: 'EEXIST'});
  const tmp = given ?? `${dest}.yz-copy-${process.pid}-${Date.now()}`, total = fs.statSync(src).size;
  let done = 0, last = 0;
  try {
    await new Promise((resolve, reject) => {
      const r = fs.createReadStream(src, {highWaterMark: 4 << 20}), w = fs.createWriteStream(tmp, {flags: 'wx'});
      r.on('data', c => { done += c.length; if (done - last >= 64 << 20 || done === total) { last = done; progress({done, total}); } });
      r.on('error', reject); w.on('error', reject); w.on('finish', resolve); r.pipe(w);
    });
    if (excl && fs.existsSync(dest)) throw Object.assign(new Error(`目标已存在：${dest}`), {code: 'EEXIST'});
    fs.renameSync(tmp, dest);
    return {bytes: done};
  } catch (e) { try { fs.rmSync(tmp, {force: true}); } catch { /* 忽略 */ } throw e; }
}
// C08：图包整包读写（含 base64、JSON、hash）在 worker 中执行
const packBuild = a => require('../../services/graph-package.cjs').workerBuild(a);
const packParse = a => require('../../services/graph-package.cjs').workerParse(a);
const TASKS = {sha256, imageProbe, imageMeta, thumbnail, copyFile, packBuild, packParse, sleep: ({ms}) => new Promise(r => setTimeout(() => r({slept: ms}), ms))};

parentPort.on('message', async ({id, kind, args}) => {
  try {
    const fn = TASKS[kind]; if (!fn) throw Object.assign(new Error(`未知任务 ${kind}`), {code: 'UNKNOWN_TASK'});
    const result = await fn(args, p => parentPort.postMessage({id, progress: p}));
    parentPort.postMessage({id, result});
  } catch (e) { parentPort.postMessage({id, error: {message: e.message, code: e.code ?? 'WORKER_ERROR'}}); }
});
