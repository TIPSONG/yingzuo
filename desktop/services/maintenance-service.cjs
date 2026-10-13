'use strict';
const {TrashStore} = require('../maintenance/trash-store.cjs');
const {WorkerPool} = require('../core/worker-pool.cjs');
const appBackup = require('../maintenance/app-backup.cjs');
// 接入 maint 分支模块：maintenance.*（U01–U07）与 resources.*（R01–R08）。
// 所有改动环境的操作都走 MaintenanceTransaction（环境锁 createLocks().environment、暂停队列并等待空闲、
// 只停止本应用拥有的服务、备份、staging、apply、检查，失败自动恢复），结果写入 env_transactions 表（U07）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {AppError, CODES} = require('../core/errors.cjs');
const {sha256File} = require('../core/fs-atomic.cjs');
const {MaintenanceTransaction} = require('../maintenance/transaction.cjs');
const {createBackup, readBackup, verifyBackup} = require('../maintenance/backup.cjs');
const {RestoreEngine} = require('../maintenance/restore.cjs');
const {collectManifest} = require('../maintenance/env-manifest.cjs');
const ops = require('../maintenance/plugin-ops.cjs');
const {buildFolderMap, scanModels} = require('../resources/model-scan.cjs');
const {describeResource, ResourceNotes} = require('../resources/resource-details.cjs');
const {ReferenceIndex} = require('../resources/reference-index.cjs');
const {planQuickUse, applyPlan} = require('../resources/quick-use.cjs');
const {listPlugins, disablePlugin, enablePlugin} = require('../resources/plugin-inventory.cjs');
const {detectManager} = require('./online/dependency-plan.cjs');

function dirSize(dir) { let n = 0; try { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { const p = path.join(dir, e.name); n += e.isDirectory() ? dirSize(p) : e.isFile() ? fs.statSync(p).size : 0; } } catch { /* 忽略 */ } return n; }

function nodeTypesOf(graph) {
  if (Array.isArray(graph?.nodes)) return [...graph.nodes, ...(graph.definitions?.subgraphs ?? []).flatMap(g => g.nodes ?? [])].map(n => n.type);
  return Object.values(graph ?? {}).map(n => n?.class_type);
}

function createMaintenanceService({db, layout, configRepo, locks, events, logger, comfy, taskService, templateRepo, editor, fetchImpl, onlineService}) {
  const backupsDir = () => configRepo.derived(layout).backups;
  const restore = new RestoreEngine({journalDir: path.join(layout.root, 'restore-journal')});
  const notes = new ResourceNotes(path.join(layout.root, 'resource-notes.json'));
  const comfyRoot = () => { const r = configRepo.config.comfy.root; if (!r || !fs.existsSync(r)) throw new AppError(CODES.NOT_FOUND, '请先在设置中配置 ComfyUI 目录。'); return r; };
  const now = () => new Date().toISOString();
  let lastScan = null;

  /* ---------- U07：事务记录 ---------- */
  function record(id, patch) {
    const exists = db.get('SELECT id FROM env_transactions WHERE id = ?', id);
    const cols = {scope: patch.scope, backup_ref: patch.backupRef, phase: patch.phase, journal: patch.journal && JSON.stringify(patch.journal), error: patch.error && JSON.stringify(patch.error), target_manifest: patch.target && JSON.stringify(patch.target), before_manifest: patch.before};
    if (!exists) db.run('INSERT INTO env_transactions (id, scope, phase, journal, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, patch.scope ?? 'maintenance', patch.phase ?? 'plan', '[]', now(), now());
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length) db.run(`UPDATE env_transactions SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...set.map(([, v]) => v), now(), id);
  }
  const listTransactions = () => db.all('SELECT * FROM env_transactions ORDER BY created_at DESC LIMIT 100').map(r => ({id: r.id, scope: r.scope, phase: r.phase, backupRef: r.backup_ref, target: r.target_manifest ? JSON.parse(r.target_manifest) : null, journal: JSON.parse(r.journal || '[]'), error: r.error ? JSON.parse(r.error) : null, createdAt: r.created_at, updatedAt: r.updated_at}));

  /* ---------- U04：事务执行 ---------- */
  async function services() {
    const running = await fetchImpl(new URL('system_stats', configRepo.config.comfy.url), {signal: AbortSignal.timeout(3000)}).then(r => r.ok, () => false);
    return [{id: 'comfy', running, owned: running ? await comfy.verifyOwned() : false, roots: configRepo.config.comfy.root ? [configRepo.config.comfy.root] : undefined}];
  }
  /* ---------- D05/D06/PR11-R01/R02：恢复失败后保持暂停；所有恢复走同一受保护路径 ---------- */
  const holds = [];
  function holdAfterFailure(h) { holds.push(h); logger?.error('维护恢复失败：保持任务暂停、不启动服务', {id: h.id}); events.emit('maintenance.hold', h.id, {stopped: h.stopped}); }
  function releaseHolds() { for (const h of holds.splice(0)) if (typeof h.lease === 'function') h.lease(); }
  async function guardedRestore(run) {
    const release = locks.environment.tryAcquire('restore'); if (!release) throw new AppError(CODES.LOCKED, '环境维护锁正被占用。');
    let lease = null, ok = false;
    try {
      if ((await services()).some(s => s.running && !s.owned)) throw new AppError(CODES.NOT_OWNED, '外部启动的 ComfyUI 仍在运行，请先关闭后再恢复。');
      lease = taskService?.hooks.pauseSubmissions('restore') ?? null;
      await taskService?.hooks.waitForIdle({timeoutMs: 600000});
      if (await comfy.verifyOwned()) await comfy.stop();
      const r = await run();
      ok = true; releaseHolds();
      return r;
    } finally {
      // 恢复未完成：保留租约（任务继续暂停），等待用户再次恢复
      if (ok || !lease) lease?.(); else holdAfterFailure({id: 'restore', lease, stopped: []});
      release();
    }
  }
  async function runTransaction(plan) {
    if (holds.length) throw new AppError(CODES.INVALID_STATE, '上一次维护恢复失败，环境处于不确定状态。请先在“维护”页完成恢复。');
    const id = `mt-${crypto.randomBytes(5).toString('hex')}`;
    record(id, {scope: plan.kind ?? 'maintenance', phase: 'plan', target: {title: plan.title, target: plan.target}});
    const journal = [];
    const tx = new MaintenanceTransaction({
      locks, services,
      stopService: async () => { await comfy.stop(); },
      startService: async () => { await comfy.ensureRunning(configRepo.config); },
      queue: taskService ? {pauseSubmissions: r => taskService.hooks.pauseSubmissions(r), waitForIdle: o => taskService.hooks.waitForIdle(o)} : null,
      onHold: h => holdAfterFailure(h),
      backup: async p => { const r = await createBackup({backupRoot: backupsDir(), manifest: await collectManifest({comfyRoot: configRepo.config.comfy.root, python: configRepo.config.comfy.python}).catch(() => null), sources: p.roots.filter(fs.existsSync).map((r, i) => ({id: `r${i}-${path.basename(r)}`, path: r})), id: `bk-${id}`, hashImpl: hashFile}); return {dir: r.dir}; },
      restore: async dir => { const j = await restore.prepare(dir); return restore.run(j.id); },
      onEvent: e => { journal.push(e); record(id, {phase: ['plan', 'disk', 'services', 'lock', 'pause', 'stop'].includes(e.phase) ? 'plan' : e.phase === 'backup' ? 'backup' : e.phase === 'staging' ? 'staging' : e.phase === 'apply' ? 'apply' : e.phase === 'check' ? 'healthcheck' : e.phase === 'done' ? 'done' : e.phase === 'restore' ? 'restore' : e.phase === 'restore-check' ? (e.state === 'done' ? 'restored' : 'failed') : 'failed', journal}); events.emit('maintenance.progress', id, e); },
    });
    const ctxLog = [];
    const wrapped = {...plan, id, stage: plan.stage && (c => { c.log = ctxLog; return plan.stage(c); }), apply: c => { c.log = ctxLog; return plan.apply(c); }};
    let result;
    try { result = await tx.execute(wrapped); }
    finally { try { plan.cleanup?.(); } catch { /* 忽略 */ } }
    record(id, {backupRef: result.backupDir ?? null, phase: result.status === 'done' ? 'done' : result.status === 'restored' ? 'restored' : 'failed', error: result.error ?? null, journal: [...journal, {log: ctxLog}]});
    logger?.info('maintenance transaction', {id, status: result.status, title: plan.title});
    return {...result, log: ctxLog, result: result.status === 'done' ? plan.result?.() ?? null : null};
  }

  /* ---------- R03：引用索引（草稿 + 模板 + 最近任务快照） ---------- */
  function sources() {
    const out = [];
    for (const t of editor?.workspace?.tabs ?? []) out.push({kind: 'draft', id: t.id, title: `草稿：${t.title}`, graph: t.graph});
    if (templateRepo) for (const t of templateRepo.list()) { try { out.push({kind: 'template', id: t.id, title: `模板：${t.name}`, graph: templateRepo.current(t.id).graph}); } catch { /* 损坏的版本跳过 */ } }
    if (taskService) for (const t of taskService.tasks.list({limit: 200})) { try { out.push({kind: 'task', id: t.id, title: `任务 #${t.seq ?? t.id}`, graph: taskService.tasks.snapshotOf(t).apiPrompt}); } catch { /* 快照缺失 */ } }
    return out;
  }
  function buildIndex() { const idx = new ReferenceIndex(); for (const s of sources()) idx.add(s); return idx; }
  function folderMap() {
    return buildFolderMap({comfyRoot: comfyRoot()});
  }
  const findItem = id => { const it = lastScan?.items.find(i => i.id === id); if (!it) throw new AppError(CODES.NOT_FOUND, '资源不存在，请重新扫描。'); return it; };
  async function objectInfo() { try { const r = await fetchImpl(new URL('object_info', configRepo.config.comfy.url), {signal: AbortSignal.timeout(10000)}); return r.ok ? r.json() : null; } catch { return null; } }

  const trash = new TrashStore({trashDir: layout.trash});
  /* ---------- R06：跨盘移动中断后的启动核对 ---------- */
  const movesDir = path.join(layout.root, 'model-moves');
  /**
   * S04：启动核对。原则：任何唯一副本或后来变化的内容都不删除。
   * - journal 路径必须位于已登记模型根内、tmp 必须是 dest 的固定临时名，否则只报告不动文件；
   * - 删除源前重新计算源 hash，必须等于 journal 记录的被移动文件；源变了就两份保留、标冲突；
   * - 唯一副本只有 tmp（源和目标都不在）且 hash 正确时，把 tmp 改名为目标；
   * - 取得与维护相同的环境锁和暂停租约；有任务运行时推迟，journal 保留到下次。
   */
  function journalValid(j) {
    const roots = Object.values(folderMap()).flat().map(r => path.resolve(r));
    const inRoot = p => typeof p === 'string' && path.isAbsolute(p) && roots.some(r => { const rel = path.relative(r, path.resolve(p)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
    return j && typeof j.sha256 === 'string' && /^[0-9a-f]{64}$/.test(j.sha256) && inRoot(j.src) && inRoot(j.dest) && j.tmp === `${j.dest}.yz-moving`;
  }
  async function recoverModelMoves() {
    if (!fs.existsSync(movesDir)) return [];
    const files = fs.readdirSync(movesDir).filter(n => n.endsWith('.json'));
    if (!files.length) return [];
    const release = locks.environment.tryAcquire('model-move-recover');
    if (!release) return files.map(f => ({file: f, action: 'deferred', reason: '环境锁被占用'}));
    const lease = taskService?.hooks.pauseSubmissions('model-move-recover') ?? null;
    const out = [];
    try {
      if (taskService?.hooks.activeTasks().length) return files.map(f => ({file: f, action: 'deferred', reason: '有任务运行中，可能正在加载模型'}));
      for (const f of files) {
        const file = path.join(movesDir, f);
        const keep = (action, extra = {}) => { out.push({file: f, action, ...extra}); };
        const drop = (action, extra = {}) => { fs.rmSync(file, {force: true}); out.push({file: f, action, ...extra}); };
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (j.conflict) { keep('conflict', {src: j.src, dest: j.dest, reason: j.conflict}); continue; }
          if (!journalValid(j)) { keep('needs-attention', {reason: '移动记录的路径不在已登记模型目录内，未处理任何文件'}); continue; }
          const has = p => fs.existsSync(p);
          const ok = async p => has(p) && await hashFile(p) === j.sha256;
          const destOk = await ok(j.dest), tmpOk = await ok(j.tmp);
          const srcHas = has(j.src), srcSame = srcHas && await hashFile(j.src) === j.sha256;
          if (srcHas && !srcSame) {
            // 源路径出现了新内容：两份都保留
            if (destOk && has(j.tmp)) fs.rmSync(j.tmp, {force: true});
            const reason = '源路径的文件已变化（不是当初移动的文件），两份都已保留，请手动决定。';
            fs.writeFileSync(file, JSON.stringify({...j, conflict: reason}));
            keep('conflict', {src: j.src, dest: j.dest, reason}); continue;
          }
          if (srcSame && destOk) { if (has(j.tmp)) fs.rmSync(j.tmp, {force: true}); fs.rmSync(j.src); drop('completed', {dest: j.dest}); continue; }
          if (srcSame && !has(j.dest)) { if (has(j.tmp)) fs.rmSync(j.tmp, {force: true}); drop('rolled-back', {src: j.src}); continue; }
          if (srcSame) { keep('conflict', {src: j.src, dest: j.dest, reason: '目标路径有不同内容，两份都已保留。'}); continue; }
          // 源不存在
          if (destOk) { if (has(j.tmp)) fs.rmSync(j.tmp, {force: true}); drop('already-done', {dest: j.dest}); continue; }
          if (!has(j.dest) && tmpOk) { fs.renameSync(j.tmp, j.dest); drop('completed-from-temp', {dest: j.dest}); continue; }
          keep('needs-attention', {reason: '源已不存在且目标/临时文件不完整，已保留现场。', src: j.src, dest: j.dest});
        } catch (e) { logger?.warn('模型移动核对失败', {file, error: e.message}); keep('needs-attention', {error: e.message}); }
      }
      return out;
    } finally { lease?.(); release(); }
  }
  // R17：大文件 sha256 在 worker 中计算，不阻塞主进程
  const pool = new WorkerPool({size: 2});
  const hashFile = async p => (await pool.run('sha256', {file: p})).sha256;
  const trashProtected = e => (restore.pending().some(j => path.resolve(j.backupDir) === path.resolve(e.stored)) ? '未完成的恢复正在使用' : null);
  /* ---------- U07：备份保留 ---------- */
  function listBackups() {
    const dir = backupsDir(); if (!fs.existsSync(dir)) return [];
    const inUse = new Set([...restore.pending().map(j => path.resolve(j.backupDir)), ...listTransactions().filter(t => !['done', 'restored', 'failed'].includes(t.phase)).map(t => t.backupRef && path.resolve(t.backupRef))].filter(Boolean));
    return fs.readdirSync(dir).filter(n => !n.endsWith('.partial')).map(n => path.join(dir, n)).filter(p => fs.existsSync(path.join(p, 'backup.json'))).map(p => { const r = readBackup(p); return {dir: p, id: r.id, createdAt: r.createdAt, sources: r.sources.map(s => s.originalPath), sizeBytes: dirSize(p), inUse: inUse.has(path.resolve(p)), complete: fs.existsSync(path.join(p, 'COMPLETE'))}; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** 保留最近 keep 份；每个来源至少保留最近一份完整备份（最近已知可恢复基线）；使用中的不删。 */
  function planPrune(keep = 5) {
    const list = listBackups(); const keepSet = new Set(list.slice(0, keep).map(b => b.dir));
    const seen = new Set(); for (const b of list) { if (!b.complete) continue; for (const s of b.sources) if (!seen.has(s)) { seen.add(s); keepSet.add(b.dir); } }
    return list.filter(b => !keepSet.has(b.dir) && !b.inUse);
  }

  const methods = {
    // ----- U01–U04、U07 -----
    'maintenance.manifest': async () => collectManifest({comfyRoot: comfyRoot(), python: configRepo.config.comfy.python}),
    'maintenance.backups': async () => ({backups: listBackups(), prunable: planPrune(configRepo.config.maintenance?.keepBackups ?? 5).map(b => b.dir)}),
    'maintenance.createBackup': async () => runTransaction({title: '手动备份 ComfyUI', kind: 'backup', roots: [comfyRoot()], requiredBytes: 0, apply: async () => {}}),
    'maintenance.verifyBackup': async dir => { const b = listBackups().find(x => x.dir === dir); if (!b) throw new AppError(CODES.NOT_FOUND, '备份不存在。'); return verifyBackup(dir); },
    'maintenance.restoreBackup': async dir => {
      const b = listBackups().find(x => x.dir === dir); if (!b) throw new AppError(CODES.NOT_FOUND, '备份不存在。');
      return guardedRestore(async () => { const j = await restore.prepare(dir); return restore.run(j.id); });
    },
    'maintenance.pendingRestores': async () => restore.pending(),
    // ----- R13：应用数据备份（与环境备份分开；恢复在下次启动、打开数据库之前执行） -----
    'maintenance.appBackup': async () => { const r = await appBackup.createAppBackup({layout, hashImpl: hashFile}); return {dir: r.dir, sources: r.record.sources.map(s => s.id), databases: r.record.databases.map(d => d.id)}; },
    'maintenance.appBackups': async () => ({backups: appBackup.listAppBackups(layout), lastRestore: globalThis.__yzAppRestore ?? null}),
    'maintenance.scheduleAppRestore': async dir => appBackup.scheduleAppRestore(layout, dir),
    'maintenance.resumeRestore': async id => guardedRestore(() => restore.resume(id)),
    'maintenance.holds': async () => holds.map(h => ({id: h.id, stopped: h.stopped})),
    'maintenance.transactions': async () => listTransactions(),
    'maintenance.pruneBackups': async () => { const list = planPrune(configRepo.config.maintenance?.keepBackups ?? 5); const moved = list.map(b => trash.move(b.dir, {kind: 'backup', note: b.createdAt})); return {moved: list.map(b => b.dir), to: trash.dir, items: moved.map(e => e.id)}; },
    // ----- R14：回收区（只管理本应用登记条目；永久清理需确认并逐项再核对） -----
    'trash.list': async () => { const items = trash.list(); return {items, bytes: items.reduce((n, e) => n + e.bytes, 0)}; },
    'trash.restore': async id => trash.restore(id),
    'trash.planPurge': async (opts = {}) => trash.planPurge({olderThanMs: opts.olderThanDays != null ? opts.olderThanDays * 86400000 : null, ids: opts.ids ?? null, isProtected: trashProtected}),
    'trash.purge': async (opts = {}) => { const plan = trash.planPurge({olderThanMs: opts.olderThanDays != null ? opts.olderThanDays * 86400000 : null, ids: opts.ids ?? null, isProtected: trashProtected}); return trash.purge(plan, {confirm: opts.confirm === true, isProtected: trashProtected}); },
    // ----- U06：执行更新 -----
    'maintenance.updateComfy': async ({revision, updateDeps = true} = {}) => { if (!revision) throw new AppError(CODES.INVALID_ARGUMENT, '请指定目标版本（提交或标签）。'); return runTransaction(ops.updatePlan({repoDir: comfyRoot(), revision, python: configRepo.config.comfy.python, patchesDir: path.join(layout.root, 'patches'), title: `更新 ComfyUI 到 ${revision}`, kind: 'comfy-update', updateDeps})); },
    'maintenance.updatePlugin': async (name, {revision, updateDeps = true} = {}) => { if (!/^[\w.-]+$/.test(name ?? '')) throw new AppError(CODES.INVALID_ARGUMENT, '插件名无效。'); if (!revision) throw new AppError(CODES.INVALID_ARGUMENT, '请指定目标版本。'); return runTransaction(ops.updatePlan({repoDir: path.join(comfyRoot(), 'custom_nodes', name), revision, python: configRepo.config.comfy.python, patchesDir: path.join(layout.root, 'patches'), title: `更新插件 ${name} 到 ${revision}`, kind: 'plugin-update', updateDeps})); },
    // ----- R01–R05 -----
    'resources.scan': async () => { lastScan = scanModels({folderMap: folderMap()}); return {count: lastScan.items.length, duplicates: lastScan.duplicates, folders: lastScan.folders, items: lastScan.items.map(i => ({id: i.id, folder: i.folder, name: i.name, size: i.size, format: i.format, symlink: i.symlink}))}; },
    'resources.detail': async id => { const it = findItem(id); const d = describeResource(it, notes.get(id)); const idx = buildIndex(); return {...d, references: idx.referencesTo(it)}; },
    'resources.setNote': async (id, patch) => { findItem(id); return notes.set(id, patch ?? {}); },
    'resources.hash': async id => { const it = findItem(id); it.sha256 = await hashFile(it.path); return {id, sha256: it.sha256}; },
    'resources.references': async () => { const idx = buildIndex(); return lastScan ? idx.diagnose(lastScan.items) : {missing: [], relocated: [], ok: true, note: '请先扫描资源。'}; },
    'resources.impact': async (id, action = 'remove') => buildIndex().impact(findItem(id), action),
    'resources.quickUse': async (id, tabId, opts = {}) => {
      if (!taskService) throw new AppError(CODES.SERVICE_UNAVAILABLE, '任务服务不可用。');
      const it = findItem(id); const res = describeResource(it, notes.get(id));
      const c = await taskService.compile(tabId);
      const plan = planQuickUse(c.apiPrompt, res, opts);
      if (!plan.available || !opts.run) return plan;
      return {plan, task: taskService.queue.enqueue({workflowId: c.tabId, inputRevision: c.revision, snapshot: {uiGraph: c.uiGraph, apiPrompt: applyPlan(c.apiPrompt, plan), title: c.title, params: {quickUse: it.name}, references: []}})};
    },
    'resources.plugins': async () => ({plugins: await listPlugins({comfyRoot: comfyRoot(), objectInfo: await objectInfo()}), manager: detectManager(path.join(comfyRoot(), 'custom_nodes'))}),
    'resources.disablePlugin': async (name, reason) => runTransaction({title: `禁用插件 ${name}`, kind: 'plugin-disable', target: name, roots: [path.join(comfyRoot(), 'custom_nodes')], requiredBytes: 0, apply: async c => { c.log.push(disablePlugin({comfyRoot: comfyRoot(), name, reason}).message); }}),
    'resources.enablePlugin': async name => runTransaction({title: `启用插件 ${name}`, kind: 'plugin-enable', target: name, roots: [path.join(comfyRoot(), 'custom_nodes')], requiredBytes: 0, apply: async c => { c.log.push(enablePlugin({comfyRoot: comfyRoot(), name}).message); }}),
    // ----- R06/R07 -----
    'resources.installPlugin': async ({url, revision = null, installDeps = false}) => runTransaction(ops.installPlan({comfyRoot: comfyRoot(), url, revision, python: configRepo.config.comfy.python, installDeps, stagingRoot: path.join(layout.root, 'staging')})),
    /** 移除前做引用检查：仍被草稿/模板/任务引用的节点类型会先返回影响清单，需 confirm=true 才执行。 */
    'resources.removePlugin': async (name, {confirm = false} = {}) => {
      const info = await objectInfo();
      const types = info ? Object.entries(info).filter(([, d]) => String(d.python_module ?? '').split('.')[1] === name).map(([t]) => t) : null;
      const users = types ? sources().filter(s => nodeTypesOf(s.graph).some(t => types.includes(t))).map(s => s.title) : null;
      if (!confirm) return {needsConfirm: true, nodeTypes: types, usedBy: users, note: types ? '' : 'ComfyUI 未运行，无法确认该插件提供的节点类型；移除后可从回收区恢复。'};
      return runTransaction(ops.removePlan({comfyRoot: comfyRoot(), name, trashDir: layout.trash, trash}));
    },
    // ----- R08：模型位置 -----
    'resources.modelRoots': async () => { const m = folderMap(); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.map(d => ({dir: d, exists: fs.existsSync(d)}))])); },
    /** 在同一用途的已登记根目录之间移动（Comfy 相对名不变，引用不需要改写）。跨盘：复制 → 校验 hash → 切换 → 删除源。 */
    'resources.moveModel': async (id, targetRoot) => {
      const it = findItem(id); const roots = folderMap()[it.folder] ?? [];
      if (!roots.some(r => path.resolve(r) === path.resolve(targetRoot))) throw new AppError(CODES.INVALID_ARGUMENT, '目标必须是该用途已登记的模型目录（可在 extra_model_paths.yaml 中添加）。');
      if (it.symlink) throw new AppError(CODES.UNSUPPORTED, '这是链接文件，请移动其实际文件。');
      const dest = path.join(targetRoot, ...it.name.split('/'));
      if (path.resolve(dest) === path.resolve(it.path)) throw new AppError(CODES.INVALID_ARGUMENT, '已在目标目录。');
      if (fs.existsSync(dest)) throw new AppError(CODES.CONFLICT, `目标已有同名文件：${dest}`);
      const free = (() => { try { const s = fs.statfsSync(targetRoot); return s.bavail * s.bsize; } catch { return null; } })();
      if (free !== null && free < it.size + 1024 ** 3) throw new AppError(CODES.DISK_SPACE, '目标磁盘空间不足。');
      // D12/PR11-R06：与维护/恢复共用环境锁；暂停提交后再核对任务，复制期间不会有新任务开始
      const release = locks.environment.tryAcquire('model-move'); if (!release) throw new AppError(CODES.LOCKED, '环境维护锁正被占用，请等维护完成后再移动。');
      const lease = taskService?.hooks.pauseSubmissions('model-move') ?? null;
      try {
        if (taskService?.hooks.activeTasks().length) throw new AppError(CODES.INVALID_STATE, '有任务运行中，模型可能正被使用，请稍后再移动。');
        if ((await services()).some(s => s.running && !s.owned)) throw new AppError(CODES.NOT_OWNED, '外部启动的 ComfyUI 正在运行，可能正在使用该模型；请先关闭后再移动。');
        fs.mkdirSync(path.dirname(dest), {recursive: true});
        try { fs.renameSync(it.path, dest); lastScan = null; return {moved: dest, method: 'rename', referencesChanged: false}; }
        catch (e) { if (e.code !== 'EXDEV') throw e; }
        const tmp = `${dest}.yz-moving`; fs.mkdirSync(movesDir, {recursive: true}); const journal = path.join(movesDir, `${crypto.randomBytes(6).toString('hex')}.json`);
        const srcHash = await hashFile(it.path);
        fs.writeFileSync(journal, JSON.stringify({src: it.path, dest, tmp, sha256: srcHash, at: new Date().toISOString()}));
        try {
          fs.copyFileSync(it.path, tmp, fs.constants.COPYFILE_EXCL);
          if (await hashFile(tmp) !== srcHash) throw new AppError(CODES.CORRUPT_DATA, '复制后校验不一致，已放弃移动，原文件未动。');
          fs.renameSync(tmp, dest);
        } catch (e) { fs.rmSync(tmp, {force: true}); fs.rmSync(journal, {force: true}); throw e; }
        fs.rmSync(it.path); fs.rmSync(journal, {force: true}); lastScan = null;
        return {moved: dest, method: 'copy-verify', sha256: srcHash, referencesChanged: false};
      } finally { lease?.(); release(); }
    },
    // ----- O08 插件部分：依赖计划中的插件按 Git 地址安装 -----
    'templates.installMissingPlugins': async items => {
      if (!Array.isArray(items) || !items.length) throw new AppError(CODES.INVALID_ARGUMENT, '请先选择要安装的插件并填写仓库地址。');
      const results = [];
      for (const it of items) { const r = await methods['resources.installPlugin']({url: it.url, revision: it.revision ?? null, installDeps: !!it.installDeps}).catch(e => ({status: 'blocked', error: {message: e.message}})); results.push({url: it.url, status: r.status, error: r.error ?? null, log: r.log ?? []}); }
      return {results, note: '插件安装后需重启 ComfyUI，再重新诊断。'};
    },
  };
  return {methods, runTransaction, buildIndex, listBackups, planPrune, restore, recoverModelMoves};
}
module.exports = {createMaintenanceService, nodeTypesOf};
