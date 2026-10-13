'use strict';
// U05：更新检测（只读）。ComfyUI 与插件：git 当前 revision、分支、是否有本地改动、远端最新提交/标签与差异提交列表。
// U08：映作版本——读取 GitHub Releases，显式下载安装包并按 SHA256SUMS 校验，交付手动升级流程（无签名发布，不配置自动更新 feed）。
// 不执行任何更新；更新执行（U06）依赖环境事务（U01–U04，maint 分支）。
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {AppError, CODES} = require('../core/errors.cjs');

function git(cwd, args, {timeoutMs = 20000, gitPath = 'git'} = {}) {
  return new Promise((resolve, reject) => execFile(gitPath, ['-C', cwd, ...args], {shell: false, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (err, stdout, stderr) => err ? reject(Object.assign(new Error((stderr || err.message).trim()), {code: err.code})) : resolve(stdout.trim())));
}
async function inspectRepo(dir, {fetchRemote = false, gitPath} = {}) {
  const o = {gitPath};
  if (!fs.existsSync(path.join(dir, '.git'))) return {path: dir, git: false, note: '不是 git 仓库（可能是便携包或手动复制），无法检测版本差异。'};
  const r = {path: dir, git: true};
  try {
    r.head = await git(dir, ['rev-parse', 'HEAD'], o);
    r.branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], o);
    r.describe = await git(dir, ['describe', '--tags', '--always'], o).catch(() => null);
    const status = await git(dir, ['status', '--porcelain', '--untracked-files=no'], o);
    r.dirty = status.length > 0; r.dirtyFiles = status ? status.split('\n').map(l => l.slice(3)).slice(0, 50) : [];
    r.upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], o).catch(() => null);
    if (fetchRemote && r.upstream) {
      const remote = r.upstream.split('/')[0];
      try { await git(dir, ['fetch', '--quiet', '--tags', remote], {...o, timeoutMs: 60000}); r.fetchedAt = new Date().toISOString(); } catch (e) { r.fetchError = e.message; }
    }
    if (r.upstream) {
      r.remoteHead = await git(dir, ['rev-parse', r.upstream], o).catch(() => null);
      const behind = await git(dir, ['log', '--format=%H%x09%cI%x09%s', `HEAD..${r.upstream}`, '-n', '50'], o).catch(() => '');
      r.behind = behind ? behind.split('\n').map(l => { const [hash, date, ...s] = l.split('\t'); return {hash, date, subject: s.join('\t')}; }) : [];
      r.ahead = Number(await git(dir, ['rev-list', '--count', `${r.upstream}..HEAD`], o).catch(() => '0'));
    }
    r.updateAvailable = !!(r.behind && r.behind.length);
    r.canUpdateSafely = r.updateAvailable && !r.dirty && !r.ahead;
    r.blockers = [r.dirty ? '有本地改动（例如 Gemma 补丁），更新需先保存并在更新后重放，不会自动覆盖。' : null, r.ahead ? `本地有 ${r.ahead} 个未推送提交。` : null].filter(Boolean);
  } catch (e) { r.error = e.message; }
  return r;
}
async function checkEnvironment({comfyRoot, customNodesDir, fetchRemote, gitPath}) {
  const out = {checkedAt: new Date().toISOString(), comfy: null, plugins: []};
  if (comfyRoot && fs.existsSync(comfyRoot)) out.comfy = await inspectRepo(comfyRoot, {fetchRemote, gitPath});
  if (customNodesDir && fs.existsSync(customNodesDir)) {
    for (const name of fs.readdirSync(customNodesDir).sort()) {
      const dir = path.join(customNodesDir, name);
      if (!fs.statSync(dir).isDirectory() || name.startsWith('.') || name === '__pycache__') continue;
      out.plugins.push({name, ...(await inspectRepo(dir, {fetchRemote, gitPath}))});
    }
  }
  return out;
}
/** U08：比较语义版本（忽略前缀 v 与预发布后缀的细分）。 */
function compareVersions(a, b) {
  const p = v => String(v).replace(/^v/, '').split(/[.-]/).map(x => (/^\d+$/.test(x) ? Number(x) : x));
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const m = x[i] ?? 0, n = y[i] ?? 0; if (m === n) continue; if (typeof m === 'number' && typeof n === 'number') return m < n ? -1 : 1; return String(m) < String(n) ? -1 : 1; }
  return 0;
}
async function checkAppRelease({currentVersion, repo = 'TIPSONG/yingzuo', fetchImpl = fetch}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=10`, {headers: {accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(15000)});
  if (res.status === 404) return {currentVersion, latest: null, note: '发行来源不可访问（仓库可能是私有的）。请从开发者处获取安装包并手动升级。'};
  if (!res.ok) throw new AppError(CODES.SERVICE_UNAVAILABLE, `无法读取发行版本：HTTP ${res.status}`);
  const list = (await res.json()).filter(r => !r.draft);
  const latest = list.find(r => !r.prerelease) ?? null;
  if (!latest) return {currentVersion, latest: null, note: '还没有正式发行版本。'};
  const assets = latest.assets.map(a => ({name: a.name, size: a.size, url: a.browser_download_url}));
  return {currentVersion, latest: {version: latest.tag_name, name: latest.name, notes: latest.body ?? '', publishedAt: latest.published_at, assets, hasChecksums: assets.some(a => a.name === 'SHA256SUMS.txt')}, updateAvailable: compareVersions(currentVersion, latest.tag_name) < 0, signed: false, note: '安装包未签名：请下载后核对校验值，再手动运行安装程序或替换便携版文件夹。'};
}
function parseChecksums(text) { return Object.fromEntries(String(text).split('\n').map(l => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l.trim())).filter(Boolean).map(m => [m[2].trim(), m[1].toLowerCase()])); }
module.exports = {inspectRepo, checkEnvironment, checkAppRelease, compareVersions, parseChecksums, git};
/** 组装 maintenance.* 中的只读更新检测与应用安装包显式下载。 */
function createUpdateService({app, configRepo, layout, fetchImpl, online, electron}) {
  let lastRelease = null;
  return {methods: {
    'maintenance.checkUpdates': async ({fetchRemote = false} = {}) => {
      const d = configRepo.derived(layout);
      return checkEnvironment({comfyRoot: configRepo.config.comfy.root || null, customNodesDir: d.customNodes || null, fetchRemote: fetchRemote === true});
    },
    'maintenance.checkAppRelease': async () => (lastRelease = await checkAppRelease({currentVersion: app.getVersion?.() ?? '0.0.0', fetchImpl})),
    /** 显式下载安装包：必须有 SHA256SUMS.txt 且包含该文件的校验值。 */
    'maintenance.downloadAppRelease': async assetName => {
      const rel = lastRelease?.latest; if (!rel) throw new AppError(CODES.INVALID_STATE, '请先检查版本。');
      const asset = rel.assets.find(a => a.name === assetName); const sums = rel.assets.find(a => a.name === 'SHA256SUMS.txt');
      if (!asset) throw new AppError(CODES.NOT_FOUND, '发行版本中没有该文件。');
      if (!sums) throw new AppError(CODES.UNSUPPORTED, '该发行版本没有 SHA256SUMS.txt，无法校验，已拒绝下载。');
      const res = await fetchImpl(sums.url, {signal: AbortSignal.timeout(20000)}); if (!res.ok) throw new AppError(CODES.SERVICE_UNAVAILABLE, `读取校验文件失败：HTTP ${res.status}`);
      const hash = parseChecksums(await res.text())[asset.name]; if (!hash) throw new AppError(CODES.CORRUPT_DATA, '校验文件中没有该安装包的 sha256。');
      const dir = path.join(configRepo.derived(layout).downloads, 'app-updates', rel.version.replace(/[^\w.-]/g, '_'));
      fs.mkdirSync(dir, {recursive: true});
      return online.downloads.add({source: 'url', fileId: asset.name, urlRef: {provider: 'url', url: asset.url}, destination: path.join(dir, asset.name), expectedHash: hash, totalBytes: asset.size});
    },
    'maintenance.openAppUpdateFolder': async () => { const dir = path.join(configRepo.derived(layout).downloads, 'app-updates'); fs.mkdirSync(dir, {recursive: true}); const e = await electron.shell.openPath(dir); if (e) throw new AppError(CODES.INTERNAL, e); return {opened: dir}; },
  }};
}
module.exports.createUpdateService = createUpdateService;
