'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {TemplateRepository} = require('../desktop/repositories/template-repo.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {writeFileAtomic} = require('../desktop/core/fs-atomic.cjs');
const {migrateStoredGraphs} = require('../desktop/maintenance/secret-migration.cjs');
const {createGraphStoragePolicy} = require('../shared/graph-storage-policy.cjs');
const {createOnlineService} = require('../desktop/services/online/online-service.cjs');
const {readLimitedBody} = require('../desktop/services/online/limited-body.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-import-'));
  const layout = ensureLayout(root);
  const db = Database.open(layout.database);
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {layout, db, repo: new TemplateRepository(db, layout.templates)};
}
function online(f, fetchImpl) {
  return createOnlineService({db: f.db, layout: f.layout, configRepo: {config: {}}, templateRepo: f.repo,
    credentials: {get: () => 'example-test-value'}, fetchImpl}).methods;
}
const graph = {nodes: [{id: 1, type: 'Example', widgets_values: []}], links: [], version: 0.4};

test('导入及旧版迁移只在请求期间保留完整链接，模板与历史使用展示地址', async t => {
  const f = fixture(t);
  const source = 'https://example.invalid/model.json';
  const link = source + '?ticket=fixture#preview';
  let requested;
  const methods = online(f, async (url, {headers}) => {
    requested = url;
    assert.equal(new Headers(headers).has('authorization'), false);
    return Response.json(graph);
  });
  const {template} = await methods['templates.importOnline'](link);
  assert.equal(requested, link);
  assert.equal(template.source, 'url:' + source);
  assert.equal(f.repo.versions(template.id)[0].source, template.source);
  f.db.run('UPDATE templates SET source=?', 'url:' + link);
  f.db.run('UPDATE template_versions SET source=?', 'url:' + link);
  const migrate = () => migrateStoredGraphs({...f, policy: createGraphStoragePolicy()});
  const report = migrate();
  assert.deepEqual(report.pending, []);
  assert.ok(report.migrated.some(item => item.kind === 'template-source'));
  assert.ok(!JSON.stringify(report).includes('ticket'));
  assert.equal(f.repo.get(template.id).source, 'url:' + source);
  assert.equal(f.repo.versions(template.id)[0].source, 'url:' + source);
  assert.deepEqual(migrate().migrated, []);
});

test('下载固定版本的 Hugging Face 模板时保留提供方认证', async t => {
  const f = fixture(t);
  const methods = online(f, async (url, {headers}) => {
    assert.ok(new Headers(headers).has('authorization'));
    if (new URL(url).pathname.includes('/revision/')) return Response.json({id: 'org/test', sha: '123abc'});
    assert.equal(String(url), 'https://huggingface.co/org/test/resolve/123abc/form.json');
    return Response.json(graph);
  });
  const r = await methods['templates.importOnline']('https://huggingface.co/org/test/blob/main/form.json');
  assert.equal(r.template.source, 'huggingface:org/test@123abc/form.json');
});

test('读取响应按实际字节数限制，可接受恰好到边界的 UTF-8 文本', async () => {
  assert.equal((await readLimitedBody(new Response('图'), 3)).toString(), '图');
  assert.equal(await readLimitedBody(new Response('图'), 2), null);
  assert.equal((await readLimitedBody(new Response(null), 0)).length, 0);
  let cancelled = false;
  const stream = new ReadableStream({cancel() { cancelled = true; }});
  assert.equal(await readLimitedBody(new Response(stream, {headers: {'Content-Length': '4'}}), 3), null);
  assert.ok(cancelled);
});

test('刷新收到无效的索引格式时可继续使用上次的索引，重启后仍有效', async t => {
  const f = fixture(t);
  let index = [{templates: [{name: 'sample', title: '示例模板'}]}];
  const methods = online(f, () => Response.json(index));
  const list = () => methods['templates.browseOnline']('comfy-official', {refresh: true});
  assert.equal((await list()).items[0].name, 'sample');
  index = {message: 'service under maintenance'};
  const stale = await list();
  assert.ok(stale.stale);
  assert.equal(stale.items[0].name, 'sample');
  const reopened = online(f, () => { throw new Error('offline'); });
  assert.equal((await reopened['templates.browseOnline']('comfy-official')).items[0].name, 'sample');
});

test('延迟外键在提交失败时回滚，后续嵌套事务仍可用', t => {
  const {db} = fixture(t);
  db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
  assert.throws(() => db.transaction(() => db.transaction(() => db.run('INSERT INTO child VALUES(1)'))), /foreign key/i);
  assert.equal(db.depth, 0);
  assert.deepEqual(db.all('SELECT * FROM child'), []);
  db.transaction(() => {
    db.run('INSERT INTO parent VALUES(1)');
    db.transaction(() => db.run('INSERT INTO child VALUES(1)'));
  });
  assert.deepEqual(db.all('SELECT * FROM child'), [{id: 1}]);
});

test('同步写入失败保留上一版文件并清理中间文件', t => {
  const {layout} = fixture(t);
  const dir = path.join(layout.root, 'atomic-test');
  const dest = path.join(dir, 'saved.json');
  writeFileAtomic(dest, 'old');
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('disk unavailable'); });
  assert.throws(() => writeFileAtomic(dest, 'next'), /disk unavailable/);
  assert.deepEqual(fs.readdirSync(dir), ['saved.json']);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'old');
});

test('并发刷新、筛选共用在途的模板索引，失败后能再次刷新', async t => {
  const f = fixture(t);
  const index = name => Response.json([{templates: [{name}]}]);
  let requests = 0, release;
  const methods = online(f, async () => {
    requests++;
    if (requests === 1) return index('old');
    if (requests === 2) return new Promise(resolve => { release = resolve; });
    if (requests === 3) return new Response(null, {status: 503});
    return index('restored');
  });
  const browse = options => methods['templates.browseOnline']('comfy-official', options);
  await browse();
  const results = Promise.all([browse({refresh: true}), browse({refresh: true}), browse({query: 'new'})]);
  release(index('new'));
  for (const result of await results) {
    assert.equal(result.items[0].name, 'new');
    assert.equal(result.stale, false);
  }
  assert.equal(requests, 2);
  const offline = await browse({refresh: true});
  assert.equal(offline.items[0].name, 'new');
  assert.equal(offline.stale, true);
  assert.equal((await browse({refresh: true})).items[0].name, 'restored');
});
