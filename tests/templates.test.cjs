'use strict';
// T01–T04：模板仓库、版本、表单 schema 与映射失效。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {TemplateRepository} = require('../desktop/repositories/template-repo.cjs');
const F = require('../shared/form-schema.cjs');
const B = require('../shared/bindings.cjs');

function repo(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-tpl-')); t.after(() => { try { db.close(); } catch { /* 已关闭 */ } fs.rmSync(d, {recursive: true, force: true}); }); // Windows：先关库再删目录
  const db = Database.open(path.join(d, 'y.sqlite'));
  let n = 0; return {r: new TemplateRepository(db, path.join(d, 'templates'), {now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString()}), d};
}
const graph = (title = 'a') => ({nodes: [{id: 1, type: 'KSampler', title}], links: []});
const prompt = () => ({7: {class_type: 'KSampler', inputs: {seed: 1, steps: 20, cfg: 3, positive: ['4', 0], latent_image: ['6', 0]}}, 4: {class_type: 'CLIPTextEncode', inputs: {text: '猫'}}, 6: {class_type: 'EmptyLatentImage', inputs: {width: 512, height: 512, batch_size: 1}}, 9: {class_type: 'KSampler', inputs: {seed: 2, steps: 10}}});

test('T01：创建、搜索、文件夹、标签、收藏；模板 ID 与工作副本不同', t => {
  const {r} = repo(t);
  const a = r.create({name: '水彩猫', graph: graph(), folder: '插画/水彩', tags: ['文生图', '文生图', ''], source: 'local'});
  r.create({name: '人像编辑', graph: graph(), folder: '编辑', tags: ['图像编辑'], source: 'local'});
  assert.match(a.id, /^tpl_/); assert.deepEqual(a.tags, ['文生图']);
  assert.equal(r.list({search: '水彩'}).length, 1); assert.equal(r.list({folder: '插画'}).length, 1); assert.equal(r.list({tag: '图像编辑'}).length, 1);
  r.update(a.id, {favorite: true, folder: '../../etc'});
  assert.equal(r.list({favorite: true})[0].id, a.id); assert.equal(r.get(a.id).folder, 'etc', '路径段清洗');
  assert.deepEqual(r.folders(), ['etc', '编辑']);
  assert.throws(() => r.create({name: 'x', graph: {prompt: {}}}), /UI 格式/);
});
test('T02：版本只追加；恢复旧版生成新版本；另存为新模板；文件被篡改时拒绝', t => {
  const {r, d} = repo(t);
  const a = r.create({name: 'A', graph: graph('v1'), source: 'local'});
  const v2 = r.saveVersion(a.id, {graph: graph('v2'), note: '改'});
  assert.equal(r.versions(a.id).length, 2); assert.equal(r.current(a.id).graph.nodes[0].title, 'v2');
  const v1 = r.versions(a.id).at(-1);
  r.restore(a.id, v1.versionId);
  assert.equal(r.versions(a.id).length, 3); assert.equal(r.current(a.id).graph.nodes[0].title, 'v1'); assert.equal(r.version(v2.versionId).graph.nodes[0].title, 'v2');
  assert.throws(() => r.saveVersion(a.id, {graph: graph(), expectedCurrent: v2.versionId}), /别处更新/);
  const b = r.saveAs(a.id, {name: 'B', graph: graph('b')});
  assert.notEqual(b.id, a.id); assert.equal(r.versions(b.id).length, 1);
  const files = fs.readdirSync(path.join(d, 'templates', 'graphs'), {recursive: true}).filter(f => f.endsWith('.json'));
  fs.writeFileSync(path.join(d, 'templates', 'graphs', files[0]), '{"nodes":[]}');
  assert.ok([a.id, b.id].some(id => { try { r.versions(id).forEach(v => r.version(v.versionId)); return false; } catch (e) { return e.code === 'CORRUPT_DATA'; } }));
});
test('T03：由绑定生成默认表单，schema 校验（重复绑定、范围）', () => {
  const fields = F.fromBindings(B.inferBindings(prompt()));
  assert.deepEqual(fields.map(f => f.label), ['提示词', '宽度', '高度', '每次张数', 'seed', '步数', 'CFG']);
  assert.deepEqual(F.validateSchema(fields), []);
  assert.match(F.validateSchema([...fields, fields[0]]).join(), /同一个输入/);
  assert.match(F.validateSchema([{...fields[1], constraints: {min: 9, max: 1}}]).join(), /最小值大于最大值/);
  assert.ok(F.validateSchema([{...fields[0], widgetType: 'bogus'}]).length);
});
test('T04：映射失效——删除、改类、改连线；只允许同类型同字段重新绑定，不错绑同号节点', () => {
  const fields = F.fromBindings(B.inferBindings(prompt()));
  const steps = fields.findIndex(f => f.fieldName === 'steps');
  const p = prompt(); delete p[4]; p[6].class_type = 'EmptySD3LatentImage'; p[7].inputs.steps = ['9', 0];
  const m = F.validateMapping(fields, p);
  assert.equal(m[0].status, 'missing-node'); assert.equal(m[1].status, 'type-changed'); assert.equal(m[steps].status, 'linked');
  assert.deepEqual(m[steps].candidates, ['9']);
  assert.equal(F.rebind(fields[steps], p, '9').nodeId, '9');
  assert.throws(() => F.rebind(fields[steps], p, '6'), /类型/);
  assert.throws(() => F.applyForm(fields, p, {[steps]: 30}), /映射失效/);
  assert.equal(F.applyForm(fields, prompt(), {[steps]: 30})[7].inputs.steps, 30);
  assert.throws(() => F.applyForm(fields, prompt(), {[steps]: 999}), /超出范围/);
});
