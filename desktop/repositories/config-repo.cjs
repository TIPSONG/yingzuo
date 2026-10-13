'use strict';
// S01：统一配置。带版本 JSON；校验返回问题清单而不是让主进程崩溃，错误配置可在设置页修复。
const fs = require('node:fs');
const path = require('node:path');
const {readVersionedJson, writeJsonAtomic, quarantine} = require('../core/fs-atomic.cjs');
const {AppError, CODES} = require('../core/errors.cjs');
const CONFIG_VERSION = 1;

function defaults(platform = process.platform) {
  const win = platform === 'win32';
  const comfyRoot = win ? 'D:\\agent\\ComfyUI' : '';
  return {
    version: CONFIG_VERSION,
    comfy: {
      root: comfyRoot,
      python: win && comfyRoot ? `${comfyRoot}\\.venv\\Scripts\\python.exe` : '',
      url: 'http://127.0.0.1:8188/',
      extraArgs: [],
      startTimeoutSec: 180,
      workflowsDir: '',   // 空表示 <root>/user/default/workflows
      outputDir: '',      // 空表示 <root>/output
      inputDir: '',       // 空表示 <root>/input
    },
    lmstudio: {url: 'http://127.0.0.1:1234/v1', cli: win ? '%USERPROFILE%\\.lmstudio\\bin\\lms.exe' : '', manageServer: true},
    gemma: {patchFile: win ? 'D:\\agent\\qwen-deployment\\lmstudio-local.patch' : '', contextLength: 8192, maxReferenceImages: 2},
    paths: {templates: '', favorites: '', downloads: '', backups: '', extraOutputDirs: []},
    defaults: {templateId: 'text'},
    downloads: {concurrency: 2, retries: 3},
    queue: {maxBatch: 100},
    tray: {closeToTray: true, showNotifications: true},
    ui: {startPage: 'home', theme: 'dark', skin: 'default'},
    updates: {channel: 'stable', checkFrequency: 'manual', appReleaseRepo: 'TIPSONG/yingzuo'},
    network: {onlineSources: true},
    output: {prefixMode: 'none'},
    maintenance: {keepBackups: 5},
  };
}
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function checkLocalUrl(value, {pathname} = {}) {
  let url;
  try { url = new URL(value); } catch { return '不是有效地址'; }
  if (url.protocol !== 'http:') return '只支持 http 本机地址';
  if (!LOCAL_HOSTS.has(url.hostname)) return '默认只连接本机服务（127.0.0.1 / localhost）';
  if (url.username || url.password) return '地址中不能包含账号密码';
  if (pathname && url.pathname !== pathname) return `路径必须为 ${pathname}`;
  return null;
}
/** 返回问题清单 [{field, message, severity}]；不抛异常。 */
function validate(config, {exists = p => fs.existsSync(p)} = {}) {
  const issues = [];
  const add = (field, message, severity = 'error') => issues.push({field, message, severity});
  const e1 = checkLocalUrl(config.comfy?.url, {pathname: '/'}); if (e1) add('comfy.url', e1);
  const e2 = checkLocalUrl(config.lmstudio?.url); if (e2) add('lmstudio.url', e2);
  if (!config.comfy?.root) add('comfy.root', '尚未设置 ComfyUI 目录；仍可连接已运行的服务。', 'warning');
  else if (!exists(config.comfy.root)) add('comfy.root', `目录不存在：${config.comfy.root}`, 'warning');
  if (config.comfy?.python && !exists(config.comfy.python)) add('comfy.python', `Python 不存在：${config.comfy.python}；无法按需启动 ComfyUI。`, 'warning');
  if (!Array.isArray(config.comfy?.extraArgs) || config.comfy.extraArgs.some(a => typeof a !== 'string' || a.length > 500) || config.comfy.extraArgs.length > 40) add('comfy.extraArgs', '启动参数必须是字符串列表（每项一个参数）。');
  if (!Number.isInteger(config.comfy?.startTimeoutSec) || config.comfy.startTimeoutSec < 10 || config.comfy.startTimeoutSec > 1800) add('comfy.startTimeoutSec', '启动超时应为 10–1800 秒。');
  if (!Number.isInteger(config.downloads?.concurrency) || config.downloads.concurrency < 1 || config.downloads.concurrency > 4) add('downloads.concurrency', '下载并发应为 1–4。');
  if (!['none', 'date', 'workflow', 'date-workflow'].includes(config.output?.prefixMode ?? 'none')) add('output.prefixMode', '输出前缀模式只能是 none / date / workflow / date-workflow。');
  if (!Number.isInteger(config.maintenance?.keepBackups ?? 5) || (config.maintenance?.keepBackups ?? 5) < 1 || (config.maintenance?.keepBackups ?? 5) > 100) add('maintenance.keepBackups', '保留备份数应为 1–100。');
  if (!Number.isInteger(config.queue?.maxBatch) || config.queue.maxBatch < 1 || config.queue.maxBatch > 1000) add('queue.maxBatch', '批量上限应为 1–1000。');
  if (config.gemma?.contextLength !== 8192) add('gemma.contextLength', 'Gemma 上下文须保持 8192（与现有补丁一致）。', 'warning');
  for (const key of ['templates', 'favorites', 'downloads', 'backups']) { const v = config.paths?.[key]; if (v && !path.isAbsolute(v) && !/^[a-zA-Z]:[\\/]/.test(v)) add(`paths.${key}`, '必须是绝对路径。'); }
  if (!Array.isArray(config.paths?.extraOutputDirs)) add('paths.extraOutputDirs', '必须是目录列表。');
  if (!['stable', 'beta'].includes(config.updates?.channel)) add('updates.channel', '渠道只能是 stable / beta。');
  if (!['manual', 'daily', 'weekly'].includes(config.updates?.checkFrequency)) add('updates.checkFrequency', '检查频率只能是 manual / daily / weekly。');
  if (!['dark', 'light', 'system'].includes(config.ui?.theme ?? 'dark')) add('ui.theme', '界面主题只能是 dark / light / system。');
  if (!['default', 'nasa-punk'].includes(config.ui?.skin ?? 'default')) add('ui.skin', '界面皮肤只能是 default / nasa-punk。');
  return issues;
}
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : {...base};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}
/** 只允许修改 defaults 中存在的键，防止写入任意字段。 */
function sanitizePatch(patch, shape) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError(CODES.INVALID_ARGUMENT, '配置修改必须是对象。');
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(shape, k) || k === 'version') throw new AppError(CODES.INVALID_ARGUMENT, `未知配置项：${k}`);
    const s = shape[k];
    if (s && typeof s === 'object' && !Array.isArray(s)) out[k] = sanitizePatch(v, s);
    else {
      if (Array.isArray(s) ? !Array.isArray(v) : typeof v !== typeof s) throw new AppError(CODES.INVALID_ARGUMENT, `配置项 ${k} 类型不正确。`);
      out[k] = v;
    }
  }
  return out;
}
class ConfigRepository {
  constructor(file, {platform = process.platform, legacyFile, exists} = {}) {
    this.file = file; this.platform = platform; this.legacyFile = legacyFile; this.exists = exists; this.loadError = null;
  }
  load() {
    let config;
    try {
      const result = readVersionedJson(this.file, {currentVersion: CONFIG_VERSION, defaults: () => this.initial()});
      config = deepMerge(defaults(this.platform), result.data);
      if (result.created) writeJsonAtomic(this.file, config);
    } catch (error) {
      // 损坏的配置保留副本，使用默认值启动并在设置页提示。
      this.loadError = error.message;
      if (fs.existsSync(this.file)) try { this.quarantined = quarantine(this.file, 'invalid'); } catch { /* 尽力 */ }
      config = defaults(this.platform);
    }
    this.config = config;
    return this.snapshot();
  }
  /** 首次创建：导入开发版 desktop/config.local.json（comfyRoot/comfyUrl）。 */
  initial() {
    const base = defaults(this.platform);
    if (this.legacyFile && fs.existsSync(this.legacyFile)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
        if (typeof legacy.comfyRoot === 'string') {
          base.comfy.root = path.resolve(legacy.comfyRoot);
          base.comfy.python = this.platform === 'win32' ? path.join(base.comfy.root, '.venv', 'Scripts', 'python.exe') : path.join(base.comfy.root, '.venv', 'bin', 'python');
        }
        if (typeof legacy.comfyUrl === 'string') base.comfy.url = legacy.comfyUrl;
      } catch { /* 旧配置损坏：使用默认值，问题会在校验中显示 */ }
    }
    return base;
  }
  snapshot() { return {config: structuredClone(this.config), issues: validate(this.config, {exists: this.exists}), loadError: this.loadError, file: this.file}; }
  update(patch) {
    const clean = sanitizePatch(patch, defaults(this.platform));
    const next = deepMerge(this.config, clean);
    const errors = validate(next, {exists: this.exists}).filter(i => i.severity === 'error');
    if (errors.length) throw new AppError(CODES.INVALID_ARGUMENT, errors.map(e => `${e.field}：${e.message}`).join('；'), {details: errors});
    writeJsonAtomic(this.file, next);
    this.config = next; this.loadError = null;
    return this.snapshot();
  }
  /** 派生路径（空值使用 ComfyUI 约定位置）。 */
  derived(layout) {
    const c = this.config, root = c.comfy.root;
    const join = (...p) => root ? path.join(root, ...p) : '';
    return {
      workflows: c.comfy.workflowsDir || join('user', 'default', 'workflows'),
      output: c.comfy.outputDir || join('output'),
      input: c.comfy.inputDir || join('input'),
      customNodes: join('custom_nodes'),
      models: join('models'),
      templates: c.paths.templates || layout.templates,
      favorites: c.paths.favorites || layout.favorites,
      downloads: c.paths.downloads || layout.downloads,
      backups: c.paths.backups || layout.backups,
    };
  }
}
module.exports = {ConfigRepository, defaults, validate, checkLocalUrl, deepMerge, sanitizePatch, CONFIG_VERSION};
