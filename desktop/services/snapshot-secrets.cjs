'use strict';
// RV03：任务快照的统一敏感字段边界。API 执行图与 UI 图（含未连接/静音/旁路节点、子图）都经过同一政策；
// 识别到的明文在快照其他字段（表单值、参数、采用文本等）中一并替换为凭据引用。不以 API 是否命中决定跳过。
const crypto = require('node:crypto');
const SF = require('../../shared/secret-fields.cjs');
const FS = require('../../shared/form-secrets.cjs');
const {createGraphStoragePolicy} = require('../../shared/graph-storage-policy.cjs');
const {AppError, CODES} = require('../core/errors.cjs');

const nameOf = secret => `node-secret:${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
const unavailable = () => new AppError(CODES.CREDENTIAL_UNAVAILABLE, '工作流含敏感输入（如 API Key），但系统加密存储不可用；为避免明文写入任务快照，未创建任务。');

function secureSnapshot(snapshot, {policy = null, credentials = null, objectInfo = null} = {}) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  objectInfo ??= policy?.getObjectInfo?.() ?? null;
  policy ??= createGraphStoragePolicy({credentials, objectInfo: () => objectInfo});
  const values = new Map();
  let apiPrompt = snapshot.apiPrompt;
  if (apiPrompt && typeof apiPrompt === 'object') {
    const r = SF.redactForStorage({prompt: apiPrompt, objectInfo});
    if (r.refs.length) {
      if (!credentials?.available?.()) throw unavailable();
      let text = JSON.stringify(r.prompt);
      for (const {credentialRef} of r.refs) {
        const secret = r.secrets.get(credentialRef), name = nameOf(secret);
        credentials.set(name, secret, {confirmedNodeSecret: true}); values.set(secret, name);
        text = text.split(JSON.stringify(SF.PLACEHOLDER_PREFIX + credentialRef)).join(JSON.stringify(SF.PLACEHOLDER_PREFIX + name));
      }
      apiPrompt = JSON.parse(text);
    }
  }
  let uiGraph = snapshot.uiGraph;
  if (policy && uiGraph && typeof uiGraph === 'object') {
    let s;
    try { s = policy.secureWithValues(uiGraph); }
    catch (e) { if (e.code === 'CREDENTIAL_UNAVAILABLE') throw unavailable(); throw e; }
    uiGraph = s.graph; for (const [v, n] of s.values) values.set(v, n);
  }
  const {apiPrompt: _a, uiGraph: _u, form, secretRefs = [], ...rest} = snapshot;
  // 表单历史默认值可能与当前 API 图完全不同，不能仅按图中的密钥值匹配。
  const safeRest = FS.sanitizeNamedSecrets(SF.redactValues(rest, values));
  return {...safeRest, ...(form === undefined ? {} : {form: FS.sanitizeForm(SF.redactValues(form, values), {objectInfo})}), uiGraph: SF.redactValues(uiGraph, values), apiPrompt: apiPrompt === undefined ? undefined : SF.redactValues(apiPrompt, values), secretRefs: [...new Set([...secretRefs, ...values.values()])]};
}
function scanSnapshot(snapshot, {policy = null, objectInfo = null} = {}) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  objectInfo ??= policy?.getObjectInfo?.() ?? null;
  policy ??= createGraphStoragePolicy({objectInfo: () => objectInfo});
  const {apiPrompt, uiGraph, form, secretRefs, ...rest} = snapshot;
  return [
    ...SF.findPlaintextSecrets(apiPrompt, objectInfo).map(h => ({nodeId: h.nodeId, field: h.input, type: apiPrompt[h.nodeId]?.class_type})),
    ...(uiGraph ? policy.scan(uiGraph) : []), ...FS.scanForm(form, objectInfo), ...FS.scanNamedSecrets(rest),
  ];
}
module.exports = {secureSnapshot, scanSnapshot};
