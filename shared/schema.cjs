'use strict';
// F03：公共 schema、任务状态机、IPC 信封。纯 JS，可在主进程与测试中共用。
const SCHEMA_VERSION = 1;

/* ---------- 迷你校验器 ---------- */
const t = {
  string: ({min = 0, max = 10000, pattern, optional = false, nullable = false} = {}) => ({kind: 'string', min, max, pattern, optional, nullable}),
  int: ({min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, optional = false, nullable = false} = {}) => ({kind: 'int', min, max, optional, nullable}),
  number: ({min = -Infinity, max = Infinity, optional = false, nullable = false} = {}) => ({kind: 'number', min, max, optional, nullable}),
  bool: ({optional = false} = {}) => ({kind: 'bool', optional}),
  enum: (values, {optional = false, nullable = false} = {}) => ({kind: 'enum', values, optional, nullable}),
  array: (item, {max = 10000, optional = false} = {}) => ({kind: 'array', item, max, optional}),
  object: (shape, {optional = false, nullable = false, open = false} = {}) => ({kind: 'object', shape, optional, nullable, open}),
  any: ({optional = false} = {}) => ({kind: 'any', optional}),
};
function check(schema, value, at = '$', errors = []) {
  if (value === undefined) { if (!schema.optional) errors.push(`${at} 缺失`); return errors; }
  if (value === null) { if (!schema.nullable) errors.push(`${at} 不能为 null`); return errors; }
  switch (schema.kind) {
    case 'any': break;
    case 'string':
      if (typeof value !== 'string') errors.push(`${at} 应为字符串`);
      else if (value.length < schema.min || value.length > schema.max) errors.push(`${at} 长度应在 ${schema.min}–${schema.max}`);
      else if (schema.pattern && !schema.pattern.test(value)) errors.push(`${at} 格式不正确`);
      break;
    case 'int': if (!Number.isInteger(value) || value < schema.min || value > schema.max) errors.push(`${at} 应为 ${schema.min}–${schema.max} 的整数`); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value) || value < schema.min || value > schema.max) errors.push(`${at} 应为有效数字`); break;
    case 'bool': if (typeof value !== 'boolean') errors.push(`${at} 应为布尔值`); break;
    case 'enum': if (!schema.values.includes(value)) errors.push(`${at} 应为 ${schema.values.join('/')} 之一`); break;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${at} 应为数组`);
      else if (value.length > schema.max) errors.push(`${at} 超过 ${schema.max} 项`);
      else value.forEach((v, i) => check(schema.item, v, `${at}[${i}]`, errors));
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`${at} 应为对象`); break; }
      for (const [k, s] of Object.entries(schema.shape)) check(s, value[k], `${at}.${k}`, errors);
      if (!schema.open) for (const k of Object.keys(value)) if (!Object.hasOwn(schema.shape, k)) errors.push(`${at}.${k} 不是允许的字段`);
      break;
    default: errors.push(`${at} 未知 schema`);
  }
  return errors;
}
function assertValid(schema, value, name = '数据') {
  const errors = check(schema, value);
  if (errors.length) { const e = new Error(`${name} 校验失败：${errors.slice(0, 5).join('；')}`); e.code = 'INVALID_ARGUMENT'; e.details = errors; throw e; }
  return value;
}

/* ---------- 标识与常量 ---------- */
const ID = t.string({min: 1, max: 80, pattern: /^[A-Za-z0-9_-]+$/});
const ISO = t.string({min: 10, max: 40, pattern: /^\d{4}-\d{2}-\d{2}T/});
const HASH = t.string({min: 64, max: 64, pattern: /^[0-9a-f]{64}$/});
const TASK_STATES = ['draft', 'queued', 'preparing', 'submitting', 'submitted', 'running', 'succeeded', 'failed', 'cancelled', 'paused', 'reconciling', 'unknown'];
const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled'];
const TASK_KINDS = ['generate', 'enhance', 'enhance-only'];
// 允许的转移。unknown 只能由用户明确处理（核对/取消/手动重试为新任务）。
const TASK_TRANSITIONS = {
  draft: ['queued', 'cancelled'],
  queued: ['preparing', 'paused', 'cancelled'],
  paused: ['queued', 'cancelled'],
  preparing: ['submitting', 'failed', 'cancelled', 'paused'],
  submitting: ['submitted', 'failed', 'reconciling', 'unknown'],
  submitted: ['running', 'succeeded', 'failed', 'cancelled', 'reconciling', 'unknown'],
  running: ['succeeded', 'failed', 'cancelled', 'reconciling', 'unknown'],
  reconciling: ['submitted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'queued'],
  unknown: ['reconciling', 'cancelled', 'failed'],
  succeeded: [], failed: [], cancelled: [],
};
function canTransition(from, to) { return !!TASK_TRANSITIONS[from]?.includes(to); }
function assertTransition(from, to) {
  if (!canTransition(from, to)) { const e = new Error(`任务状态不能从 ${from} 变为 ${to}。`); e.code = 'INVALID_STATE'; throw e; }
}

/* ---------- 第 5.1 节核心记录 ---------- */
const schemas = {
  WorkspaceTab: t.object({
    id: ID, templateId: t.string({max: 120, optional: true, nullable: true}), revision: t.int({min: 0}), title: t.string({min: 1, max: 120}),
    mode: t.enum(['graph', 'parameters', 'app']), graphRef: t.string({max: 300}), graphHash: HASH, formSchemaId: t.string({max: 120, optional: true, nullable: true}),
    referenceIds: t.array(ID, {max: 64}), viewport: t.object({scale: t.number({min: 0.01, max: 100}), offset: t.array(t.number(), {max: 2})}, {nullable: true}),
    nativeIdentity: t.object({hostName: t.string({max: 300}), workflowPath: t.string({max: 1000, nullable: true}), documentId: t.string({max: 300, nullable: true})}, {nullable: true}),
  }),
  TemplateVersion: t.object({templateId: ID, versionId: ID, parentId: t.string({max: 80, optional: true, nullable: true}), graphRef: t.string({max: 300}), graphHash: HASH, formSchemaRef: t.string({max: 300, nullable: true}), source: t.string({max: 300}), savedAt: ISO}),
  ParameterBinding: t.object({
    scopePath: t.array(t.string({max: 120}), {max: 32}), nodeId: t.string({min: 1, max: 40}), nodeType: t.string({min: 1, max: 200}), fieldName: t.string({min: 1, max: 200}),
    widgetType: t.enum(['number', 'int', 'float', 'string', 'text', 'customtext', 'toggle', 'boolean', 'combo', 'image', 'seed']),
    constraints: t.object({min: t.number({optional: true}), max: t.number({optional: true}), step: t.number({optional: true}), values: t.array(t.any(), {optional: true, max: 2000}), multiline: t.bool({optional: true})}, {open: false}),
    label: t.string({max: 120, optional: true}), group: t.string({max: 120, optional: true}), order: t.int({optional: true}), defaultValue: t.any({optional: true}), slot: t.string({max: 40, optional: true}),
  }),
  Task: t.object({
    id: ID, kind: t.enum(TASK_KINDS), state: t.enum(TASK_STATES), workflowId: t.string({max: 120}), snapshotRef: t.string({max: 300}), inputRevision: t.int({min: 0}),
    requestId: ID, comfyPromptId: t.string({max: 120, optional: true, nullable: true}), clientId: t.string({max: 120}), groupId: t.string({max: 80, optional: true, nullable: true}),
    retryOf: t.string({max: 80, optional: true, nullable: true}), outputs: t.array(t.any(), {max: 1000}), error: t.any({optional: true}),
    timestamps: t.object({createdAt: ISO, updatedAt: ISO}, {open: true}),
  }),
  Asset: t.object({id: ID, canonicalPath: t.string({max: 2000}), kind: t.enum(['output', 'input', 'favorite', 'reference']), format: t.string({max: 20}), fileSize: t.int({min: 0}), mtime: t.number(), contentHash: t.string({max: 64, optional: true, nullable: true}), source: t.string({max: 200}), metadata: t.any(), missing: t.bool(), taskId: t.string({max: 80, optional: true, nullable: true})}),
  Resource: t.object({id: ID, role: t.string({max: 60}), architecture: t.string({max: 60, optional: true, nullable: true}), format: t.string({max: 20}), quantization: t.string({max: 40, optional: true, nullable: true}), path: t.string({max: 2000}), source: t.string({max: 300}), version: t.string({max: 120, optional: true, nullable: true}), capabilities: t.array(t.string({max: 60})), references: t.array(t.any())}),
  Download: t.object({id: ID, source: t.enum(['huggingface', 'civitai', 'url', 'template']), fileId: t.string({max: 500}), urlRef: t.string({max: 2000}), destination: t.string({max: 2000}), tempPath: t.string({max: 2000}), etag: t.string({max: 300, optional: true, nullable: true}), expectedHash: t.string({max: 128, optional: true, nullable: true}), receivedBytes: t.int({min: 0}), state: t.enum(['planned', 'queued', 'downloading', 'paused', 'verifying', 'completed', 'failed', 'cancelled']), error: t.any({optional: true})}),
  EnvironmentTransaction: t.object({id: ID, scope: t.string({max: 120}), beforeManifest: t.string({max: 300, nullable: true}), backupRef: t.string({max: 300, nullable: true}), targetManifest: t.any({optional: true}), phase: t.enum(['plan', 'backup', 'staging', 'apply', 'healthcheck', 'done', 'restore', 'restore-check', 'restored', 'failed']), ownedServiceStates: t.any(), journal: t.array(t.any()), error: t.any({optional: true})}),
};

/* ---------- IPC 信封（第 5.2 节） ---------- */
const API_GROUPS = ['services', 'workspace', 'tasks', 'assets', 'templates', 'resources', 'downloads', 'maintenance', 'settings'];
const METHOD = t.string({min: 3, max: 80, pattern: /^[a-z]+\.[a-zA-Z]+$/});
const commandSchema = t.object({requestId: ID, method: METHOD, args: t.array(t.any(), {max: 8}), expectedRevision: t.int({min: 0, optional: true})});
function validateCommand(message) {
  assertValid(commandSchema, message, 'IPC 命令');
  const group = message.method.split('.')[0];
  if (!API_GROUPS.includes(group)) { const e = new Error('未知的接口分组。'); e.code = 'FORBIDDEN'; throw e; }
  return message;
}
const okResult = (data, revision) => ({ok: true, data, ...(revision === undefined ? {} : {revision})});
const errResult = error => ({ok: false, error});

module.exports = {SCHEMA_VERSION, t, check, assertValid, schemas, TASK_STATES, TERMINAL_STATES, TASK_KINDS, TASK_TRANSITIONS, canTransition, assertTransition, API_GROUPS, validateCommand, okResult, errResult};
