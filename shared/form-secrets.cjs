'use strict';
// 表单是图以外的独立副本。敏感输入只能在执行图中引用凭据，不能作为可分享默认值保留。
const SF = require('./secret-fields.cjs');
const isSensitiveField = (field, objectInfo) => !!field && (field.sensitive === true || SF.isSecretInput(field.nodeType, field.fieldName, SF.defOf(objectInfo, field.nodeType, field.fieldName)));
function unmappedValues(form) {
  if (!form || Array.isArray(form)) return [];
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const hits = [];
  for (const kind of ['values', 'requestedValues']) for (const [i, value] of Object.entries(form[kind] ?? {})) {
    if (value === '' || value == null || SF.isPlaceholder(value)) continue;
    const field = /^(0|[1-9]\d*)$/.test(i) ? fields[Number(i)] : null;
    if (!field || !['nodeId', 'nodeType', 'fieldName'].every(k => typeof field[k] === 'string' && field[k])) hits.push({type: 'form', nodeId: 'unknown', field: `${kind}.${i}`, unresolved: true});
  }
  return hits;
}
function sanitizeFields(fields, {objectInfo = null} = {}) {
  if (!Array.isArray(fields)) return fields;
  return fields.map(f => isSensitiveField(f, objectInfo) ? {...f, sensitive: true, defaultValue: ''} : structuredClone(f));
}
function scanForm(form, objectInfo = null) {
  const hits = unmappedValues(form);
  const fields = Array.isArray(form) ? form : form?.fields;
  for (const [i, f] of (Array.isArray(fields) ? fields : []).entries()) {
    if (!isSensitiveField(f, objectInfo)) continue;
    for (const [kind, value] of [['defaultValue', f.defaultValue], ['values', form?.values?.[i]], ['requestedValues', form?.requestedValues?.[i]]]) {
      if (typeof value === 'string' && value && !SF.isPlaceholder(value)) hits.push({type: f.nodeType, nodeId: f.nodeId, field: `${f.fieldName}.${kind}`});
    }
  }
  return hits;
}
function sanitizeForm(form, {objectInfo = null} = {}) {
  if (!form || typeof form !== 'object') return form;
  if (Array.isArray(form)) return sanitizeFields(form, {objectInfo});
  const uncertain = unmappedValues(form);
  if (uncertain.length) throw Object.assign(new Error('任务表单的历史字段映射不完整，已阻止保存；请恢复固定的表单版本或重新从工作流创建任务。'), {code: 'INVALID_STATE', details: {uncertain}});
  const out = structuredClone(form);
  out.fields = sanitizeFields(out.fields, {objectInfo});
  for (const [i, field] of (Array.isArray(out.fields) ? out.fields : []).entries()) if (isSensitiveField(field, objectInfo)) {
    for (const key of ['values', 'requestedValues']) if (out[key] && Object.hasOwn(out[key], i)) out[key][i] = '';
  }
  return out;
}
function scanNamedSecrets(value, at = '$', hits = []) {
  if (!value || typeof value !== 'object') return hits;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && v && !SF.isPlaceholder(v) && SF.isSecretInput('', k, null)) hits.push({type: 'snapshot', nodeId: at, field: k});
    else if (v && typeof v === 'object') scanNamedSecrets(v, `${at}.${k}`, hits);
  }
  return hits;
}
function sanitizeNamedSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeNamedSecrets);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && SF.isSecretInput('', k, null) ? '' : sanitizeNamedSecrets(v)]));
}
module.exports = {isSensitiveField, sanitizeFields, scanForm, sanitizeForm, scanNamedSecrets, sanitizeNamedSecrets};
