'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createGraphStoragePolicy, secretName} = require('../shared/graph-storage-policy.cjs');
const {PLACEHOLDER_PREFIX} = require('../shared/secret-fields.cjs');
const {migrateStoredGraphs} = require('../desktop/maintenance/secret-migration.cjs');

function fixture() {
  const vault = new Map(), items = {};
  const credentials = {
    available: () => true, get: ref => vault.get(ref), read: () => ({items}),
    set: (ref, value, flags) => { items[ref] = flags; vault.set(ref, value); },
  };
  return {credentials, policy: createGraphStoragePolicy({credentials})};
}
const workflow = value => ({
  nodes: [{id: 1, type: 'Connector', widgets_values: {api_key: value, prompt: 'normal text'},
    properties: {extension: {lastValue: value, label: 'connect to ABC service'}}}],
  links: [[1, 1, 0, 2, 0, 'ABC']],
  extra: {extension: {history: [value, 'ABC mode']}},
  definitions: {subgraphs: [{id: 'part', extra: {preview: value}, nodes: [
    {id: 1, type: 'ABC', widgets_values: [], properties: {display: value}},
  ]}]},
});
test('保存、内存还原与导出覆盖已识别 widget 的元数据镜像，保留图结构与普通文本', () => {
  const {policy} = fixture();
  const original = workflow('ABC');
  const {graph: disk, values} = policy.secureWithValues(original);
  const ref = PLACEHOLDER_PREFIX + values.get('ABC');
  assert.equal(ref, PLACEHOLDER_PREFIX + secretName('ABC'));
  assert.equal(disk.nodes[0].properties.extension.lastValue, ref);
  assert.equal(disk.extra.extension.history[0], ref);
  assert.equal(disk.definitions.subgraphs[0].extra.preview, ref);
  assert.equal(disk.definitions.subgraphs[0].nodes[0].properties.display, ref);
  assert.deepEqual(policy.scan(disk), []);
  assert.deepEqual(policy.resolveInMemory(disk).graph, original);
  const expected = workflow('');
  for (const input of [original, disk]) {
    const exported = policy.stripForExport(input);
    assert.deepEqual(exported.graph, expected);
    assert.deepEqual(exported.refill.map(field => field.field), ['api_key']);
  }
  assert.deepEqual(original, workflow('ABC'));
});
test('旧归档已有敏感 widget 引用时，扫描和迁移能单独清理属性中遗留的相同明文', t => {
  const {policy, credentials} = fixture();
  const value = 'fixture extension value';
  const stored = policy.secureForStorage(workflow(value));
  stored.nodes[0].properties.extension.lastValue = value;
  assert.deepEqual(policy.scan(stored).map(hit => hit.name), ['properties']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mirror-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const layout = {root, closed: path.join(root, 'closed-workflows'), migrations: path.join(root, 'migrations')};
  fs.mkdirSync(layout.closed);
  const file = path.join(layout.closed, 'example.json');
  fs.writeFileSync(file, JSON.stringify(stored));
  const report = migrateStoredGraphs({layout, policy, credentials});
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.migrated.map(item => item.kind), ['closed']);
  assert.ok(!JSON.stringify(report).includes(value));
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!JSON.stringify(disk).includes(value));
  assert.deepEqual(policy.resolveInMemory(disk).graph, workflow(value));
  // 即使没有本机凭据，也可用显式敏感字段已有的引用核对镜像。
  const fresh = createGraphStoragePolicy();
  assert.deepEqual(fresh.scan(stored).map(h => h.name), ['properties']);
  assert.throws(() => fresh.secureForStorage(stored), e => e.code === 'CREDENTIAL_UNAVAILABLE' && !JSON.stringify(e.fields).includes(value));
  assert.deepEqual(fresh.stripForExport(stored).graph, workflow(''));
});
