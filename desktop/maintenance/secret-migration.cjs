'use strict';
// 扫描不依赖加密可用性；失败和无法确定的字段留在 pending，备份不得复制它们。
// 内容寻址文件先写新副本，再事务更新引用；只删除已无引用的旧文件，不改变任务、事件或 lineage。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {writeFileAtomic} = require('../core/fs-atomic.cjs');
const SF = require('../../shared/secret-fields.cjs');
const {sanitizeFields, scanForm, scanNamedSecrets} = require('../../shared/form-secrets.cjs');
const {secureSnapshot, scanSnapshot} = require('../services/snapshot-secrets.cjs');
const {SnapshotStore} = require('../repositories/task-repo.cjs');

function migrateStoredGraphs({db, layout, repo, policy, credentials, persistDrafts = null, now = () => new Date().toISOString()}) {
  const canSecure = !!credentials?.available?.();
  const objectInfo = policy.getObjectInfo?.() ?? null;
  const report = {at: now(), canSecure, migrated: [], pending: []};
  const note = (kind, id, fields, done, reason = null) => (done ? report.migrated : report.pending).push({kind, id,
    fields: fields.map(f => `${f.type ?? 'data'}#${f.nodeId ?? '-'}.${f.field ?? f.input ?? f.name ?? f.path ?? 'values'}`), ...(reason ? {reason} : {})});
  // JSON 解析和第三方凭据错误可能包含原始内容，报告只保存固定的错误分类。
  const problem = (kind, id, reason, fields = []) => note(kind, id, fields, false, reason);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const graphCheck = graph => {
    if (!graph || !Array.isArray(graph.nodes)) throw new Error('invalid graph');
    return policy.scan(graph);
  };
  // 加密可用时核实已有引用也能解密；不可用时安全占位无需还原或改写。
  function checkRefs(value) {
    if (!canSecure) return;
    const names = new Set();
    const walk = v => {
      if (SF.isPlaceholder(v)) names.add(v.slice(SF.PLACEHOLDER_PREFIX.length));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(value);
    for (const name of names) if (!credentials?.get?.(name)) throw new Error('credential unresolved');
  }
  function files(dir, kind, visit) {
    if (!fs.existsSync(dir)) return;
    let entries; try { entries = fs.readdirSync(dir, {withFileTypes: true}); }
    catch { problem(kind, path.relative(layout.root, dir), 'READ_FAILED'); return; }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) problem(kind, path.relative(layout.root, file), 'UNSUPPORTED_FILE');
      else if (e.isDirectory()) files(file, kind, visit);
      else if (e.isFile()) visit(file);
      else problem(kind, path.relative(layout.root, file), 'UNSUPPORTED_FILE');
    }
  }
  function graphFiles(dir, kind) {
    files(dir, kind, file => {
      const id = path.relative(dir, file);
      if (kind === 'closed' && file.endsWith('.meta.json')) return;
      if (!file.endsWith('.json')) { problem(kind, id, 'UNSUPPORTED_FILE'); return; }
      let graph, hits;
      try { graph = readJson(file); hits = graphCheck(graph); checkRefs(graph); }
      catch { problem(kind, id, 'READ_OR_CREDENTIAL_FAILED'); return; }
      if (!hits.length) return;
      try {
        if (kind === 'draft') {
          if (!persistDrafts) throw new Error('draft writer unavailable');
          persistDrafts();
          if (graphCheck(readJson(file)).length) throw new Error('draft remains unresolved');
        } else {
          const secured = policy.secureForStorage(graph);
          if (graphCheck(secured).length) throw new Error('graph remains unresolved');
          writeFileAtomic(file, JSON.stringify(secured, null, 2));
        }
        note(kind, id, hits, true);
      } catch { problem(kind, id, 'MIGRATION_FAILED', hits); }
    });
  }
  graphFiles(layout.closed ?? path.join(layout.root, 'closed-workflows'), 'closed');
  graphFiles(path.join(layout.root, 'drafts'), 'draft');

  // 同一模板版本的图和表单一起预检、更新；表单默认值可以直接清除，不要求系统加密可用。
  if (db && repo) {
    let rows = [];
    try { rows = db.all('SELECT version_id, graph_ref, graph_hash, form_schema_ref FROM template_versions'); }
    catch { problem('template-version', 'database', 'READ_FAILED'); }
    for (const r of rows) {
      const [formRef, formHash] = (r.form_schema_ref ?? '').split('#');
      let graph, fields, hits;
      try {
        graph = repo._read(r.graph_ref, r.graph_hash);
        fields = formRef ? repo._read(formRef, formHash) : null;
        if (fields !== null && !Array.isArray(fields)) throw new Error('invalid form');
        hits = [...graphCheck(graph), ...scanForm({fields}, objectInfo)];
        checkRefs(graph);
      } catch { problem('template-version', r.version_id, 'READ_OR_CREDENTIAL_FAILED'); continue; }
      try {
        const nextGraph = policy.secureForStorage(graph);
        const nextFields = fields ? sanitizeFields(fields, {objectInfo}) : fields;
        if (graphCheck(nextGraph).length || scanForm({fields: nextFields}, objectInfo).length) throw new Error('still unresolved');
        if (same(graph, nextGraph) && same(fields, nextFields)) continue;
        const g = same(graph, nextGraph) ? {ref: r.graph_ref, hash: r.graph_hash} : repo._blob('graphs', nextGraph);
        const f = nextFields ? repo._blob('forms', nextFields) : null;
        // _blob 复用同名文件；必须验证它没有被损坏后才替换仍有效的旧引用。
        repo._read(g.ref, g.hash); if (f) repo._read(f.ref, f.hash);
        db.transaction(() => db.run('UPDATE template_versions SET graph_ref = ?, graph_hash = ?, form_schema_ref = ? WHERE version_id = ?',
          g.ref, g.hash, f ? `${f.ref}#${f.hash}` : null, r.version_id));
        if (g.ref !== r.graph_ref && !db.get('SELECT 1 AS x FROM template_versions WHERE graph_ref = ?', r.graph_ref)) fs.rmSync(path.join(repo.dir, ...r.graph_ref.split('/')), {force: true});
        if (formRef && f?.ref !== formRef && !db.get('SELECT 1 AS x FROM template_versions WHERE form_schema_ref LIKE ?', `${formRef}#%`)) fs.rmSync(path.join(repo.dir, ...formRef.split('/')), {force: true});
        note('template-version', r.version_id, hits, true);
      } catch { problem('template-version', r.version_id, 'MIGRATION_FAILED', hits); }
    }
  }

  function hydrateForm(snapshot) {
    const form = snapshot?.form;
    if (!form || Array.isArray(form.fields)) return snapshot;
    if (!form.versionId) {
      if ((form.templateId || snapshot.templateId) && [form.values, form.requestedValues].some(v => v && Object.keys(v).length)) throw new Error('pinned form unavailable');
      return snapshot;
    }
    if (!repo) throw new Error('pinned form unavailable');
    const version = repo.version(form.versionId);
    const templateId = form.templateId ?? snapshot.templateId;
    if (templateId && version.templateId !== templateId) throw new Error('pinned form mismatch');
    return {...snapshot, form: {...form, fields: version.formSchema ?? []}};
  }
  const snapDir = layout['task-snapshots'] ?? path.join(layout.root, 'task-snapshots');
  if (db) {
    let rows = [];
    try { rows = db.all('SELECT DISTINCT snapshot_ref, snapshot_hash FROM tasks'); }
    catch { problem('task-snapshot', 'database', 'READ_FAILED'); }
    const store = fs.existsSync(snapDir) ? new SnapshotStore(snapDir) : null;
    for (const r of rows) {
      let original, snapshot, hits;
      try {
        if (!store) throw new Error('snapshot directory missing');
        original = store.get(r.snapshot_ref, r.snapshot_hash);
        snapshot = hydrateForm(original);
        hits = scanSnapshot(snapshot, {policy, objectInfo});
      } catch { problem('task-snapshot', r.snapshot_ref, 'READ_OR_CREDENTIAL_FAILED'); continue; }
      try {
        // API-only / 表单-only 也扫描和处理；不可加密的 API 明文由统一边界拒绝。
        const secured = secureSnapshot(snapshot, {policy, credentials, objectInfo});
        checkRefs(secured);
        if (scanSnapshot(secured, {policy, objectInfo}).length) throw new Error('snapshot remains unresolved');
        if (same(secured, original)) { if (hits.length) problem('task-snapshot', r.snapshot_ref, 'UNRESOLVED', hits); continue; }
        const next = store.put(secured);
        store.get(next.ref, next.hash); // put 可能复用已存在文件，先核实再提交引用
        db.transaction(() => db.run('UPDATE tasks SET snapshot_ref = ?, snapshot_hash = ? WHERE snapshot_ref = ? AND snapshot_hash = ?', next.ref, next.hash, r.snapshot_ref, r.snapshot_hash));
        if (!db.get('SELECT 1 AS x FROM tasks WHERE snapshot_ref = ?', r.snapshot_ref)) fs.rmSync(path.join(snapDir, ...r.snapshot_ref.split('/').slice(1)), {force: true});
        note('task-snapshot', r.snapshot_ref, hits, true);
      } catch { problem('task-snapshot', r.snapshot_ref, 'MIGRATION_FAILED', hits); }
    }
  }

  // 备份复制整个目录。孤立旧文件也必须检查；不删除或改写没有数据库归属的数据。
  const referenced = new Set();
  if (db) {
    try {
      for (const r of db.all('SELECT graph_ref, form_schema_ref FROM template_versions')) {
        if (!repo) { problem('template-version', r.graph_ref, 'REPOSITORY_UNAVAILABLE'); continue; }
        referenced.add(path.resolve(repo?.dir ?? layout.templates ?? path.join(layout.root, 'templates'), ...r.graph_ref.split('/')));
        if (r.form_schema_ref) referenced.add(path.resolve(repo?.dir ?? layout.templates ?? path.join(layout.root, 'templates'), ...r.form_schema_ref.split('#')[0].split('/')));
      }
      for (const r of db.all('SELECT snapshot_ref FROM tasks')) referenced.add(path.resolve(snapDir, ...r.snapshot_ref.split('/').slice(1)));
    } catch { problem('orphan-data', 'database', 'READ_FAILED'); }
  }
  function orphanFiles(dir, kind, inspect) {
    files(dir, kind, file => {
      if (referenced.has(path.resolve(file))) return;
      const id = path.relative(layout.root, file);
      try {
        if (!/^[0-9a-f]{64}\.json$/.test(path.basename(file))) throw new Error('unknown file');
        const text = fs.readFileSync(file, 'utf8');
        if (`${crypto.createHash('sha256').update(text).digest('hex')}.json` !== path.basename(file)) throw new Error('hash mismatch');
        const value = JSON.parse(text), hits = inspect(value);
        checkRefs(value);
        if (hits.length) problem(kind, id, 'UNREFERENCED_SENSITIVE_DATA', hits);
      } catch { problem(kind, id, 'READ_OR_CREDENTIAL_FAILED'); }
    });
  }
  const templateDir = repo?.dir ?? layout.templates ?? path.join(layout.root, 'templates');
  orphanFiles(path.join(templateDir, 'graphs'), 'orphan-template', graphCheck);
  orphanFiles(path.join(templateDir, 'forms'), 'orphan-form', fields => {
    if (!Array.isArray(fields)) throw new Error('invalid form');
    return scanForm({fields}, objectInfo);
  });
  orphanFiles(snapDir, 'orphan-snapshot', snapshot => scanSnapshot(hydrateForm(snapshot), {policy, objectInfo}));
  // 旧提交记录复制了快照 params；它们不参与重试，不改历史记录，只阻止未处理明文进入备份。
  files(path.join(layout.root, 'task-submissions'), 'task-submission', file => {
    const id = path.relative(layout.root, file);
    try {
      if (!file.endsWith('.json')) throw new Error('unknown file');
      const hits = scanNamedSecrets(readJson(file));
      if (hits.length) problem('task-submission', id, 'SENSITIVE_DATA', hits);
    } catch { problem('task-submission', id, 'READ_FAILED'); }
  });
  try {
    const dir = layout.migrations ?? path.join(layout.root, 'migrations'); fs.mkdirSync(dir, {recursive: true});
    writeFileAtomic(path.join(dir, 'secret-scan.json'), JSON.stringify(report, null, 2));
  } catch { problem('scan-report', 'secret-scan.json', 'WRITE_FAILED'); }
  return report;
}
module.exports = {migrateStoredGraphs};
