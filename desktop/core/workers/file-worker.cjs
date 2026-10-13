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
const TASKS = {sha256, imageProbe, sleep: ({ms}) => new Promise(r => setTimeout(() => r({slept: ms}), ms))};

parentPort.on('message', async ({id, kind, args}) => {
  try {
    const fn = TASKS[kind]; if (!fn) throw Object.assign(new Error(`未知任务 ${kind}`), {code: 'UNKNOWN_TASK'});
    const result = await fn(args, p => parentPort.postMessage({id, progress: p}));
    parentPort.postMessage({id, result});
  } catch (e) { parentPort.postMessage({id, error: {message: e.message, code: e.code ?? 'WORKER_ERROR'}}); }
});
