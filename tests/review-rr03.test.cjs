'use strict';
// RR03 / RR04：真实仓库与备份入口，虚构密钥；所有数据只写入测试临时目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {Database} = require('../desktop/repositories/database.cjs');
const {SnapshotStore, TaskRepository} = require('../desktop/repositories/task-repo.cjs');
const {TemplateRepository} = require('../desktop/repositories/template-repo.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');
const {createLocks} = require('../desktop/core/locks.cjs');
const {createGraphStoragePolicy, secretName} = require('../shared/graph-storage-policy.cjs');
const {migrateStoredGraphs} = require('../desktop/maintenance/secret-migration.cjs');
const {createMaintenanceService} = require('../desktop/services/maintenance-service.cjs');
const {resolveSecrets, PLACEHOLDER_PREFIX} = require('../shared/secret-fields.cjs');
const {secureSnapshot} = require('../desktop/services/snapshot-secrets.cjs');

const KEY = 'fictional-legacy-key';
const INFO = {PrivateNode: {input: {required: {access: ['STRING', {sensitive: true}], text: ['STRING', {}]}}}};
const emptyGraph = () => ({nodes: []});
const api = (name = 'api_key', value = KEY) => ({1: {class_type: 'PrivateNode', inputs: {[name]: value, text: 'ordinary prompt'}}});
const binding = (fieldName, defaultValue) => ({scopePath: [], nodeId: '1', nodeType: 'PrivateNode', fieldName, widgetType: 'string', constraints: {}, label: fieldName, defaultValue});
function env(t, available = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rr03-'));
  const layout = ensureLayout(root), db = Database.open(layout.database);
  const safeStorage = {isEncryptionAvailable: () => available, getSelectedStorageBackend: () => 'dpapi',
    encryptString: s => Buffer.from(s), decryptString: b => b.toString()};
  const credentials = new CredentialStore(path.join(root, 'credentials.json'), safeStorage);
  const policy = createGraphStoragePolicy({credentials, objectInfo: () => INFO});
  const repo = new TemplateRepository(db, layout.templates);
  const store = new SnapshotStore(layout['task-snapshots']);
  const tasks = new TaskRepository(db, store);
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const add = snapshot => tasks.create({workflowId: 'fixture', snapshot, clientId: 'fixture'});
  const migrate = () => migrateStoredGraphs({db, layout, repo, policy, credentials});
  const leases = [];
  const service = createMaintenanceService({db, layout, templateRepo: repo, credentials, locks: createLocks(), events: {emit() {}},
    configRepo: {config: {comfy: {root, url: 'http://127.0.0.1:1/'}, maintenance: {}}, derived: () => ({backups: layout.backups})},
    editor: {graphPolicy: () => policy, enqueue: f => f(), persist() {}},
    taskService: {hooks: {pauseSubmissions: () => { leases.push('pause'); return () => leases.push('resume'); }}},
    comfy: {}, fetchImpl: async () => { throw new Error('offline'); },
    pool: {run: async (op, {file}) => { assert.equal(op, 'sha256'); return {sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}; }}});
  const fileOf = task => path.join(layout['task-snapshots'], ...task.snapshotRef.split('/').slice(1));
  return {root, layout, db, credentials, policy, repo, store, tasks, add, migrate, service, leases, fileOf};
}
const filesUnder = dir => fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
const assertNoText = (dir, text) => { for (const f of filesUnder(dir)) assert.equal(fs.readFileSync(f).includes(Buffer.from(text)), false, f); };

test('RR03: API-only legacy snapshot is pending without encryption and actual appBackup refuses before copying', async t => {
  const e = env(t, false), task = e.add({uiGraph: emptyGraph(), apiPrompt: api()});
  const original = fs.readFileSync(e.fileOf(task));
  const report = e.migrate();
  assert.equal(report.migrated.length, 0);
  assert.equal(report.pending.length, 1);
  assert.equal(report.pending[0].kind, 'task-snapshot');
  assert.ok(report.pending[0].fields.some(f => f.includes('api_key')));
  assert.equal(JSON.stringify(report).includes(KEY), false);
  await assert.rejects(e.service.methods['maintenance.appBackup'](), error => error.code === 'CREDENTIAL_UNAVAILABLE' && error.details.pending.length === 1);
  assert.equal(fs.existsSync(path.join(e.layout.backups, 'app')), false);
  assert.deepEqual(fs.readFileSync(e.fileOf(task)), original);
});

test('RR03: API definition-only sensitive field migrates, exact credential restores, shared references and lineage survive', async t => {
  const e = env(t), password = '  p4ss!  ';
  const first = e.add({uiGraph: emptyGraph(), apiPrompt: api('access', password)});
  e.tasks.transition(first.id, 'preparing'); e.tasks.transition(first.id, 'failed');
  const retry = e.tasks.retry(first.id), oldFile = e.fileOf(first);
  const events = e.db.all('SELECT * FROM task_events');
  assert.equal(first.snapshotRef, retry.snapshotRef);
  const report = e.migrate();
  assert.deepEqual(report.pending, []);
  assert.equal(report.migrated.filter(x => x.kind === 'task-snapshot').length, 1);
  const a = e.tasks.get(first.id), b = e.tasks.get(retry.id);
  assert.notEqual(a.snapshotRef, first.snapshotRef); assert.equal(a.snapshotRef, b.snapshotRef);
  assert.equal(fs.existsSync(oldFile), false);
  assert.deepEqual(e.tasks.lineage(retry.id), [first.id, retry.id]);
  assert.deepEqual(e.db.all('SELECT * FROM task_events'), events);
  const snapshot = e.tasks.snapshotOf(a);
  assert.equal(snapshot.apiPrompt[1].inputs.text, 'ordinary prompt');
  assert.equal((await resolveSecrets(snapshot.apiPrompt, name => e.credentials.get(name)))[1].inputs.access, password);
  assertNoText(e.layout['task-snapshots'], password);
  const backup = await e.service.methods['maintenance.appBackup']();
  assert.ok(fs.existsSync(path.join(backup.dir, 'COMPLETE')));
  assertNoText(path.join(backup.dir, 'data'), password);
  assert.deepEqual(e.leases, ['pause', 'resume']);
});

test('RR03/RR04: historical form defaults and pinned form values migrate without graph matches or encryption', async t => {
  const e = env(t, false), oldDefault = 'fictional-old-default', oldValue = 'fictional-old-value';
  const tpl = e.repo.create({name: 'legacy form', source: 'fixture', graph: emptyGraph(), formSchema: [binding('access', oldDefault), binding('text', 'normal default')]});
  const version = e.repo.current(tpl.id);
  const oldFormRef = e.db.get('SELECT form_schema_ref FROM template_versions WHERE version_id = ?', version.versionId).form_schema_ref;
  const task = e.add({uiGraph: emptyGraph(), apiPrompt: {}, form: {templateId: tpl.id, versionId: version.versionId, values: {0: oldValue, 1: 'normal value'}, requestedValues: {0: oldDefault, 1: 'normal request'}}});
  const report = e.migrate();
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.migrated.map(x => x.kind).sort(), ['task-snapshot', 'template-version']);
  const fields = e.repo.version(version.versionId).formSchema;
  assert.equal(fields[0].defaultValue, ''); assert.equal(fields[0].sensitive, true);
  assert.deepEqual(fields[1], binding('text', 'normal default'));
  assert.equal(fs.existsSync(path.join(e.repo.dir, ...oldFormRef.split('#')[0].split('/'))), false);
  const snapshot = e.tasks.snapshotOf(e.tasks.get(task.id));
  assert.equal(snapshot.form.fields[0].sensitive, true);
  assert.deepEqual(snapshot.form.values, {0: '', 1: 'normal value'});
  assert.deepEqual(snapshot.form.requestedValues, {0: '', 1: 'normal request'});
  for (const dir of [e.layout.templates, e.layout['task-snapshots']]) for (const text of [oldDefault, oldValue]) assertNoText(dir, text);
  const backup = await e.service.methods['maintenance.appBackup']();
  assert.ok(fs.existsSync(path.join(backup.dir, 'COMPLETE')));
});

test('RR03: corrupt, missing, unavailable pinned forms and undecryptable snapshots remain pending and unchanged', t => {
  const e = env(t), broken = e.add({uiGraph: emptyGraph(), apiPrompt: api()}), missing = e.add({uiGraph: emptyGraph(), apiPrompt: {}, tag: 'missing'});
  fs.writeFileSync(e.fileOf(broken), `{"secret":"${KEY}"`);
  fs.rmSync(e.fileOf(missing));
  const missingForm = e.add({uiGraph: emptyGraph(), apiPrompt: {}, form: {templateId: 'tpl_missing', versionId: 'tv_missing', values: {0: KEY}}});
  const ref = secretName(KEY); e.credentials.set(ref, KEY);
  const encrypted = e.add({uiGraph: emptyGraph(), apiPrompt: api('api_key', PLACEHOLDER_PREFIX + ref)});
  const get = e.credentials.get.bind(e.credentials); e.credentials.get = name => { if (name === ref) throw new Error(`decrypt failed: ${KEY}`); return get(name); };
  const before = e.db.all('SELECT id, snapshot_ref, snapshot_hash FROM tasks');
  const report = e.migrate();
  assert.equal(report.migrated.length, 0); assert.equal(report.pending.length, 4);
  assert.equal(JSON.stringify(report).includes(KEY), false);
  assert.deepEqual(e.db.all('SELECT id, snapshot_ref, snapshot_hash FROM tasks'), before);
  for (const task of [broken, missingForm, encrypted]) assert.ok(fs.existsSync(e.fileOf(task)));
  assert.equal(fs.existsSync(e.fileOf(missing)), false);
});

test('RR03: unresolved short widget mapping is pending even when encryption is available', t => {
  const e = env(t), graph = {nodes: [{id: 1, type: 'PrivateNode', widgets_values: ['p4ss!', 'model.gguf', true]}]};
  const task = e.add({uiGraph: graph, apiPrompt: {}}), before = fs.readFileSync(e.fileOf(task));
  const report = e.migrate();
  assert.equal(report.pending.length, 1); assert.equal(report.migrated.length, 0);
  assert.deepEqual(fs.readFileSync(e.fileOf(task)), before);
  assert.equal(fs.existsSync(e.credentials.file), false);
});

test('RR03: orphan sensitive or corrupt files block backup; ordinary orphan graphs remain allowed and nothing is deleted', async t => {
  const e = env(t, false), orphan = e.store.put({uiGraph: emptyGraph(), apiPrompt: api()});
  const form = e.repo._blob('forms', [binding('access', 'fictional-orphan-default')]);
  const clean = e.repo._blob('graphs', {nodes: [{id: 2, type: 'Text', widgets_values: ['ordinary long prompt']} ]});
  const bad = path.join(e.layout['task-snapshots'], 'interrupted.tmp'); fs.writeFileSync(bad, KEY);
  const report = e.migrate();
  assert.equal(report.pending.length, 3);
  assert.ok(report.pending.some(x => x.kind === 'orphan-form'));
  assert.ok(report.pending.some(x => x.kind === 'orphan-snapshot' && x.reason === 'UNREFERENCED_SENSITIVE_DATA'));
  assert.equal(report.pending.some(x => x.id.includes(clean.hash)), false);
  await assert.rejects(e.service.methods['maintenance.appBackup']());
  assert.ok(fs.existsSync(path.join(e.layout['task-snapshots'], ...orphan.ref.split('/').slice(1))));
  assert.ok(fs.existsSync(path.join(e.repo.dir, ...form.ref.split('/'))));
  assert.ok(fs.existsSync(bad));
});

test('RR03: failed snapshot reference transaction keeps original file and pointers; the next pass can safely finish', t => {
  const e = env(t), task = e.add({uiGraph: emptyGraph(), apiPrompt: api()});
  const transaction = e.db.transaction.bind(e.db);
  e.db.transaction = () => { throw new Error('simulated transaction failure'); };
  const failed = e.migrate();
  assert.equal(failed.pending.length, 1); assert.equal(failed.migrated.length, 0);
  assert.equal(e.tasks.get(task.id).snapshotRef, task.snapshotRef); assert.ok(fs.existsSync(e.fileOf(task)));
  e.db.transaction = transaction;
  const next = e.migrate();
  assert.deepEqual(next.pending, []); assert.equal(next.migrated.length, 1);
  assert.equal(fs.existsSync(e.fileOf(task)), false);
});

test('RR03: inconsistent expected hashes cannot be silently repaired by another task sharing the same ref', t => {
  const e = env(t), snapshot = {uiGraph: emptyGraph(), apiPrompt: api()};
  const a = e.add(snapshot), b = e.add(snapshot), badHash = '0'.repeat(64);
  e.db.run('UPDATE tasks SET snapshot_hash = ? WHERE id = ?', badHash, b.id);
  const report = e.migrate();
  assert.equal(report.migrated.length, 1); assert.equal(report.pending.length, 1);
  assert.notEqual(e.tasks.get(a.id).snapshotRef, a.snapshotRef);
  assert.equal(e.tasks.get(b.id).snapshotRef, b.snapshotRef); assert.equal(e.tasks.get(b.id).snapshotHash, badHash);
  assert.ok(fs.existsSync(e.fileOf(b)), 'still referenced original must remain');
});

test('RR03: legacy submission params are checked and safe ordinary submissions are accepted', async t => {
  const e = env(t, false), dir = path.join(e.root, 'task-submissions'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({attempts: [{params: {api_key: KEY}}]}));
  fs.writeFileSync(path.join(dir, 'normal.json'), JSON.stringify({attempts: [{params: {prompt: 'ordinary prompt', steps: 20}}]}));
  const report = e.migrate();
  assert.equal(report.pending.length, 1); assert.equal(report.pending[0].kind, 'task-submission');
  assert.equal(JSON.stringify(report).includes(KEY), false);
  await assert.rejects(e.service.methods['maintenance.appBackup']());
  assert.ok(fs.readFileSync(path.join(dir, 'old.json'), 'utf8').includes(KEY), 'historical source preserved');
});

test('RR03: a missing template repository cannot certify referenced template files as safe', t => {
  const e = env(t, false);
  e.repo.create({name: 'legacy', source: 'fixture', graph: {nodes: [{id: 1, type: 'PrivateNode', widgets_values: [KEY, 'normal']} ]}});
  const report = migrateStoredGraphs({db: e.db, layout: e.layout, policy: e.policy, credentials: e.credentials});
  assert.ok(report.pending.some(x => x.reason === 'REPOSITORY_UNAVAILABLE'));
  assert.ok(report.pending.some(x => x.kind === 'orphan-template'));
});

test('RR03: corrupt pre-existing destination cannot replace a valid original snapshot during migration', t => {
  const e = env(t), snapshot = {uiGraph: emptyGraph(), apiPrompt: api()}, task = e.add(snapshot);
  const secured = secureSnapshot(snapshot, {policy: e.policy, credentials: e.credentials, objectInfo: INFO});
  const hash = crypto.createHash('sha256').update(JSON.stringify(secured)).digest('hex');
  const target = path.join(e.layout['task-snapshots'], hash.slice(0, 2), `${hash}.json`);
  fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, 'corrupted target');
  const report = e.migrate();
  assert.ok(report.pending.some(x => x.kind === 'task-snapshot'));
  assert.equal(report.migrated.length, 0);
  assert.equal(e.tasks.get(task.id).snapshotRef, task.snapshotRef);
  assert.deepEqual(e.tasks.snapshotOf(e.tasks.get(task.id)), snapshot);
  assert.equal(fs.readFileSync(target, 'utf8'), 'corrupted target');
});

test('RR03: template-associated values without fields or a pinned version are unresolved, never guessed from latest', t => {
  const e = env(t, false);
  const tpl = e.repo.create({name: 'legacy', source: 'fixture', graph: emptyGraph()});
  const task = e.add({uiGraph: emptyGraph(), apiPrompt: {}, form: {templateId: tpl.id, values: {0: KEY}}});
  const report = e.migrate();
  assert.equal(report.pending.length, 1); assert.equal(report.migrated.length, 0);
  assert.equal(e.tasks.get(task.id).snapshotRef, task.snapshotRef);
});
