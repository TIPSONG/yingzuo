'use strict';
// F07：日志轮转与脱敏。日志写失败不阻断业务操作。
const fs = require('node:fs');
const path = require('node:path');
const SECRET_KEYS = /(token|secret|password|passwd|authorization|api[_-]?key|cookie|session|credential|signature|x-amz-[a-z-]+)/i;
/** 脱敏字符串：URL 查询签名、Bearer、hf_ 令牌、Windows 用户目录。 */
function redactString(value) {
  return String(value)
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [已脱敏]')
    .replace(/\bhf_[A-Za-z0-9]{8,}\b/g, 'hf_[已脱敏]')
    .replace(/([?&](?:token|sig|signature|key|api_key|apikey|X-Amz-[A-Za-z-]+|Expires|Policy|Key-Pair-Id)=)[^&\s"']+/gi, '$1[已脱敏]')
    .replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, '//[已脱敏]@')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1[用户]')
    .replace(/(\/home\/)[^/\s"']+/g, '$1[用户]');
}
function redact(value, depth = 0) {
  if (depth > 8) return '[过深]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[已脱敏]' : redact(v, depth + 1);
    return out;
  }
  return value;
}
class Logger {
  constructor(dir, {name = 'yingzuo', maxBytes = 2 * 1024 * 1024, keep = 5, now = () => new Date()} = {}) {
    this.dir = dir; this.name = name; this.maxBytes = maxBytes; this.keep = keep; this.now = now; this.failures = 0;
  }
  get file() { return path.join(this.dir, `${this.name}.log`); }
  rotate() {
    try {
      if (!fs.existsSync(this.file) || fs.statSync(this.file).size < this.maxBytes) return;
      for (let i = this.keep - 1; i >= 1; i--) { const from = `${this.file}.${i}`; if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`); }
      fs.renameSync(this.file, `${this.file}.1`);
      const extra = `${this.file}.${this.keep + 1}`; if (fs.existsSync(extra)) fs.rmSync(extra);
    } catch { this.failures++; }
  }
  write(level, message, data) {
    try {
      fs.mkdirSync(this.dir, {recursive: true}); this.rotate();
      const line = JSON.stringify({t: this.now().toISOString(), level, message: redactString(message), ...(data === undefined ? {} : {data: redact(data)})});
      fs.appendFileSync(this.file, line + '\n');
    } catch { this.failures++; }
  }
  info(m, d) { this.write('info', m, d); } warn(m, d) { this.write('warn', m, d); } error(m, d) { this.write('error', m, d); }
  /** 读取最近若干行（诊断页面用）。 */
  tail(lines = 200) {
    try { return fs.readFileSync(this.file, 'utf8').trimEnd().split('\n').slice(-lines); } catch { return []; }
  }
}
module.exports = {Logger, redact, redactString};
