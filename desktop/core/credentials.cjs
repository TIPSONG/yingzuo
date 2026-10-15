'use strict';
// F07：凭据仅用 Electron safeStorage 加密保存；系统无法安全加密时拒绝保存，不降级为明文。
const fs = require('node:fs');
const {writeJsonAtomic} = require('./fs-atomic.cjs');
const {AppError, CODES} = require('./errors.cjs');
const ALLOWED = new Set(['huggingface', 'civitai']);
// R18/D15：工作流节点中的敏感输入（如 lmstudio_api_key），按明文哈希命名，快照里只存引用。
const NODE_SECRET = /^node-secret:[0-9a-f]{16}$/;
class CredentialStore {
  constructor(file, safeStorage) { this.file = file; this.safeStorage = safeStorage; }
  available() {
    try {
      if (!this.safeStorage?.isEncryptionAvailable()) return false;
      // Linux 下 basic_text 后端等同明文，不接受。
      if (typeof this.safeStorage.getSelectedStorageBackend === 'function' && ['basic_text', 'unknown'].includes(this.safeStorage.getSelectedStorageBackend())) return false;
      return true;
    } catch { return false; }
  }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {version: 1, items: {}}; } }
  set(name, secret, {confirmedNodeSecret = false} = {}) {
    if (!ALLOWED.has(name) && !NODE_SECRET.test(name)) throw new AppError(CODES.INVALID_ARGUMENT, '未知的凭据名称。');
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 4096) throw new AppError(CODES.INVALID_ARGUMENT, '凭据内容无效。');
    if (!this.available()) throw new AppError(CODES.CREDENTIAL_UNAVAILABLE, '系统加密存储不可用，为避免明文保存，未保存该凭据。');
    const data = this.read();
    const nodeSecret = NODE_SECRET.test(name);
    data.items[name] = {cipher: this.safeStorage.encryptString(nodeSecret ? secret : secret.trim()).toString('base64'), savedAt: new Date().toISOString(), ...(nodeSecret && confirmedNodeSecret ? {confirmedNodeSecret: true} : {})};
    writeJsonAtomic(this.file, data);
  }
  get(name) {
    const item = this.read().items[name];
    if (!item) return null;
    if (!this.available()) throw new AppError(CODES.CREDENTIAL_UNAVAILABLE, '系统加密存储不可用，无法读取凭据。');
    return this.safeStorage.decryptString(Buffer.from(item.cipher, 'base64'));
  }
  remove(name) { const data = this.read(); delete data.items[name]; writeJsonAtomic(this.file, data); }
  /** 只返回是否已配置，从不返回密文或明文。 */
  status() { const items = this.read().items; return {available: this.available(), configured: Object.fromEntries([...ALLOWED].map(n => [n, !!items[n]]))}; }
}
module.exports = {CredentialStore};
