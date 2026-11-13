'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {updatePlan} = require('../desktop/maintenance/plugin-ops.cjs');
const {createOnlineService} = require('../desktop/services/online/online-service.cjs');
const {createTemplateService} = require('../desktop/services/template-service.cjs');
const {migrateStoredGraphs} = require('../desktop/maintenance/secret-migration.cjs');
const {Database} = require('../desktop/repositories/database.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');
const {createGraphStoragePolicy} = require('../shared/graph-storage-policy.cjs');

const env = {...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {env, stdio: 'pipe'}).toString().trim();
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-nov13-resources-'));
  const closers = [];
  t.after(() => { for (const close of closers) close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {dir, closers};
}
function put(dir, name, data) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, data); return file; }
function updateFixture(t, upstream, local, {ignored = false, platform = process.platform} = {}) {
  const {dir} = temp(t); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  put(repo, 'a.py', 'x = 1\n'); if (ignored) put(repo, '.gitignore', `${local}\n`);
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'v1'); const before = git(repo, 'rev-parse', 'HEAD');
  put(repo, upstream, 'UPSTREAM\n'); git(repo, 'add', '-f', '--', upstream); git(repo, 'commit', '-qm', 'v2'); const target = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '--detach', before); const file = put(repo, local, 'USER DATA\n');
  const plan = updatePlan({repoDir: repo, revision: target, patchesDir: path.join(dir, 'patches'), updateDeps: false, fetch: false, platform});
  return {repo, file, before, plan, ctx: {log: []}};
}
for (const [name, upstream, local, options] of [
  ['file-to-directory', 'local/upstream.py', 'local', {}],
  ['directory-to-file', 'local', 'local/user.py', {}],
  ['ignored file', 'settings.json', 'settings.json', {ignored: true}],
  ['Windows case alias', 'settings.json', 'SETTINGS.json', {platform: 'win32'}],
  ['Chinese filename', '用户设置.json', '用户设置.json', {}],
]) {
  test(`更新预检保护本地 ${name} 冲突`, async t => {
    const f = updateFixture(t, upstream, local, options);
    await assert.rejects(f.plan.stage(f.ctx), e => e.code === 'CONFLICT');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.before);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'USER DATA\n');
  });
}
test('更新允许同目录内无冲突的 ignored 文件，并保留内容', async t => {
  const f = updateFixture(t, 'settings/upstream.py', 'settings/local.json', {ignored: true});
  await f.plan.stage(f.ctx); await f.plan.apply(f.ctx); assert.equal(await f.plan.check(f.ctx), true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'USER DATA\n');
});

const secret = 'fictional-nov13-api-key';
const graph = () => ({nodes: [{id: 1, type: 'LLM', widgets_values: {api_key: secret, prompt: '普通提示词'}}], links: [], version: 0.4});
function onlineFixture(t, encrypted = true) {
  const {dir, closers} = temp(t), layout = ensureLayout(dir), db = Database.open(layout.database); closers.push(() => db.close());
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'), {isEncryptionAvailable: () => encrypted, getSelectedStorageBackend: () => 'dpapi', encryptString: s => Buffer.from(`enc:${s}`), decryptString: b => b.toString().slice(4)});
  const policy = createGraphStoragePolicy({credentials, objectInfo: () => ({LLM: {input: {required: {api_key: ['STRING', {password: true}], prompt: ['STRING']}}}})});
  const templates = createTemplateService({db, layout, editor: {secureDisk: policy.secureForStorage, graphPolicy: () => policy}});
  const service = createOnlineService({db, layout, configRepo: {config: {}}, credentials, templateRepo: templates.repo, fetchImpl: async () => new Response(JSON.stringify(graph()), {status: 200})});
  const cache = path.join(dir, 'downloads', 'online-templates');
  return {dir, layout, db, credentials, policy, repo: templates.repo, service, cache};
}
test('在线导入只保存安全模板，不创建原文缓存', async t => {
  const f = onlineFixture(t); const result = await f.service.methods['templates.importOnline']('https://example.invalid/workflow.json');
  assert.equal(JSON.stringify(f.repo.current(result.template.id).graph).includes(secret), false);
  assert.equal(fs.existsSync(f.cache) ? fs.readdirSync(f.cache).length : 0, 0);
});
test('在线导入加密失败时不留下原文文件', async t => {
  const f = onlineFixture(t, false);
  await assert.rejects(f.service.methods['templates.importOnline']('https://example.invalid/workflow.json'), e => e.code === 'CREDENTIAL_UNAVAILABLE');
  assert.equal(fs.existsSync(f.cache) ? fs.readdirSync(f.cache).length : 0, 0);
});
test('旧在线缓存迁移安全图及包装图，保留索引与缩略图', t => {
  const f = onlineFixture(t);
  const raw = put(f.cache, '1700000000000-old.json', JSON.stringify(graph()));
  const wrapped = put(f.cache, '1700000000001-wrapped.json', JSON.stringify({workflow: graph(), prompt: {1: {class_type: 'LLM', inputs: {api_key: secret}}}}));
  const index = put(f.cache, 'index-custom.json', '[]'); const thumb = put(f.cache, 'thumbs/1.webp', 'image-fixture');
  const report = migrateStoredGraphs(f);
  assert.equal(report.pending.length, 0);
  assert.equal(report.migrated.filter(x => x.kind === 'online-template-cache').length, 2);
  for (const file of [raw, wrapped]) {
    const text = fs.readFileSync(file, 'utf8'); assert.equal(text.includes(secret), false);
    assert.equal(f.policy.resolveInMemory(JSON.parse(text)).graph.nodes[0].widgets_values.api_key, secret);
  }
  assert.equal(fs.readFileSync(index, 'utf8'), '[]'); assert.equal(fs.readFileSync(thumb, 'utf8'), 'image-fixture');
  assert.equal(migrateStoredGraphs(f).migrated.length, 0);
});
test('旧在线缓存无法加密时保留原文件并明确登记 pending', t => {
  const f = onlineFixture(t, false), file = put(f.cache, '1700000000000-old.json', JSON.stringify(graph()));
  const report = migrateStoredGraphs(f);
  assert.ok(report.pending.some(x => x.kind === 'online-template-cache'));
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(graph()));
  assert.equal(JSON.stringify(report).includes(secret), false);
});
