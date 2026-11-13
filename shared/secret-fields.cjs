'use strict';
// R18/D15：敏感节点输入的识别与脱敏（纯函数，不读写存储）。
// 快照、导出、诊断写盘前调用 redactForStorage：真实值替换为凭据引用占位，提交时用 resolveSecrets 在内存中还原。
// 接入任务快照存储（task-repo/SnapshotStore）留给主线，避免与队列改动冲突。
const {SECRET_INPUTS} = require('./bindings.cjs');

const PLACEHOLDER_PREFIX = '__yz_credential__:';
const KNOWN_SECRET = new Set(['LMStudioPromptEnhancer.lmstudio_api_key']);

/** 判断输入是否敏感：object_info 声明 password、已知节点字段、或名称匹配。 */
function isSecretInput(classType, name, def) {
  const opts = Array.isArray(def) ? def[1] : null;
  if (opts && (opts.password === true || opts.sensitive === true)) return true;
  if (KNOWN_SECRET.has(`${classType}.${name}`)) return true;
  return SECRET_INPUTS.test(String(name));
}
const defOf = (objectInfo, classType, name) => {
  const i = objectInfo?.[classType]?.input; return i?.required?.[name] ?? i?.optional?.[name] ?? null;
};
const isPlaceholder = v => typeof v === 'string' && v.startsWith(PLACEHOLDER_PREFIX);
const refName = (nodeId, input) => `node:${nodeId}:${input}`;

/**
 * 对 API prompt（与可选 UI 图）脱敏。返回 {prompt, graph, refs, secrets}；
 * refs: [{nodeId, input, credentialRef}]；secrets: Map(credentialRef → 明文)，只应交给 CredentialStore，不能写入快照。
 * 空字符串不视为秘密（不生成引用）。
 */
function redactForStorage({prompt, graph = null, objectInfo = null}) {
  const out = structuredClone(prompt ?? {}), refs = [], secrets = new Map(), values = new Map();
  for (const [nodeId, node] of Object.entries(out)) {
    for (const [input, value] of Object.entries(node?.inputs ?? {})) {
      if (typeof value !== 'string' || !value || isPlaceholder(value)) continue;
      if (!isSecretInput(node.class_type, input, defOf(objectInfo, node.class_type, input))) continue;
      const credentialRef = refName(nodeId, input);
      secrets.set(credentialRef, value); values.set(value, credentialRef);
      node.inputs[input] = PLACEHOLDER_PREFIX + credentialRef;
      refs.push({nodeId, input, credentialRef});
    }
  }
  return {prompt: out, graph: graph ? redactValues(graph, values) : null, refs, secrets};
}
/** 在任意 JSON（UI 图、诊断、生成信息）中把已知明文替换为占位。 */
function redactValues(obj, values) {
  const walk = v => {
    if (typeof v === 'string') { for (const [secret, ref] of values) if (v === secret) return PLACEHOLDER_PREFIX + ref; else if (v.includes(secret)) v = v.split(secret).join('[已脱敏]'); return v; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}
/** 提交前在内存中解析占位；缺失凭据抛错（不静默提交空值）。 */
async function resolveSecrets(prompt, getCredential) {
  const out = structuredClone(prompt), missing = [];
  for (const node of Object.values(out)) for (const [k, v] of Object.entries(node?.inputs ?? {})) {
    if (!isPlaceholder(v)) continue;
    const ref = v.slice(PLACEHOLDER_PREFIX.length), secret = await getCredential(ref);
    if (typeof secret !== 'string' || !secret) missing.push(ref); else node.inputs[k] = secret;
  }
  if (missing.length) throw Object.assign(new Error(`缺少凭据：${missing.join('、')}，请在设置中重新填写。`), {code: 'CREDENTIAL_MISSING', missing});
  return out;
}
/** 既有快照检查：返回仍含明文敏感输入的位置（用于迁移告警）。 */
function findPlaintextSecrets(prompt, objectInfo = null) {
  const hits = [];
  for (const [nodeId, node] of Object.entries(prompt ?? {})) for (const [input, v] of Object.entries(node?.inputs ?? {}))
    if (typeof v === 'string' && v && !isPlaceholder(v) && isSecretInput(node.class_type, input, defOf(objectInfo, node.class_type, input))) hits.push({nodeId, input});
  return hits;
}
module.exports = {PLACEHOLDER_PREFIX, isSecretInput, defOf, redactForStorage, redactValues, resolveSecrets, findPlaintextSecrets, isPlaceholder};
