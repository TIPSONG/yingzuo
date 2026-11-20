'use strict';
// 统一错误代码。IPC 返回 { ok:false, error:{ code, message, retryable, details? } }。
const CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',               // revision / identity 不匹配
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  FORBIDDEN: 'FORBIDDEN',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  INVALID_PATH: 'INVALID_PATH',
  LOCKED: 'LOCKED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  SERVICE_IDENTITY: 'SERVICE_IDENTITY',
  NOT_OWNED: 'NOT_OWNED',
  UNSUPPORTED: 'UNSUPPORTED',
  INVALID_STATE: 'INVALID_STATE',
  CORRUPT_DATA: 'CORRUPT_DATA',
  READ_ONLY: 'READ_ONLY',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  CREDENTIAL_UNAVAILABLE: 'CREDENTIAL_UNAVAILABLE',
  NETWORK: 'NETWORK',
  HTTP: 'HTTP',
  INTEGRITY: 'INTEGRITY',
  DISK_SPACE: 'DISK_SPACE',
  INTERNAL: 'INTERNAL',
});
const RETRYABLE = new Set([CODES.LOCKED, CODES.TIMEOUT, CODES.SERVICE_UNAVAILABLE, CODES.NETWORK]);
class AppError extends Error {
  constructor(code, message, {retryable, details, cause} = {}) {
    super(message, cause ? {cause} : undefined);
    if (!Object.hasOwn(CODES, code)) throw new TypeError(`未知错误代码 ${code}`);
    this.name = 'AppError';
    this.code = code;
    this.retryable = retryable ?? RETRYABLE.has(code);
    if (details !== undefined) this.details = details;
  }
}
function toIpcError(error) {
  if (error instanceof AppError) return {code: error.code, message: error.message, retryable: error.retryable, ...(error.details !== undefined ? {details: error.details} : {})};
  // 共享图策略不依赖 Electron 层；只接纳它声明的安全错误与无值的位置说明。
  if (['INVALID_STATE', 'CREDENTIAL_UNAVAILABLE'].includes(error?.code)) return {code: error.code, message: error.message, retryable: false, ...(Array.isArray(error.details?.uncertain) ? {details: {uncertain: error.details.uncertain.map(({scope, nodeId, type, field}) => ({scope, nodeId, type, field}))}} : {})};
  return {code: CODES.INTERNAL, message: String(error?.message ?? error), retryable: false};
}
const fail = (code, message, options) => new AppError(code, message, options);
module.exports = {CODES, AppError, toIpcError, fail};
