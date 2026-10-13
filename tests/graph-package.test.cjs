'use strict';
// S08：图 + 参考素材包的导出与导入校验（隔离临时目录；虚构图片字节）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {buildPackage, parsePackage} = require('../desktop/services/graph-package.cjs');
const {ReferenceStore} = require('../desktop/services/task-service.cjs');

function fixture(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-gp-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const src = path.join(d, '参考 图.png'); fs.writeFileSync(src, Buffer.from('fictional-png-bytes'));
  const store = new ReferenceStore(path.join(d, 'refs'));
  const ref = store.importFile(src);
  return {d, store, ref};
}
const graph = {nodes: [{id: 5, type: 'LoadImage', widgets_values: ['x.png']}, {id: 6, type: 'LMStudioPromptEnhancer', widgets_values: ['猫', '__yz_credential__:node-secret:0123456789abcdef']}]};

test('S08：导出→在新数据根导入，内容与关系一致；中文名保留；凭据占位不导出；缺失素材如实标出', t => {
  const {d, store, ref} = fixture(t);
  const pkg = buildPackage({title: '中文 标签', graph, template: {templateId: 'tpl', versionId: 'v1', formSchema: null}, relations: [{nodeId: '5', input: 'image', refId: ref.id, name: '参考 图.png'}, {nodeId: '7', input: 'image', refId: 'a'.repeat(64) + '.png', name: '已丢失.png'}], readRef: id => store.pathOf(id)});
  const text = JSON.stringify(pkg);
  assert.ok(!text.includes('__yz_credential__'));
  const p = parsePackage(text);
  assert.equal(p.title, '中文 标签');
  assert.equal(p.references[0].name, '参考 图.png'); assert.ok(p.references[1].missing);
  const fresh = new ReferenceStore(path.join(d, 'other-root'));
  fresh.importBuffer(p.references[0].buffer, p.references[0].refId);
  assert.ok(fresh.has(ref.id));
  assert.deepEqual(fs.readFileSync(fresh.pathOf(ref.id)), fs.readFileSync(store.pathOf(ref.id)));
});
test('S08：损坏素材、错误编号、目录穿越、错误版本整体拒绝', t => {
  const {store, ref} = fixture(t);
  const good = buildPackage({title: 'x', graph, relations: [{nodeId: '5', input: 'image', refId: ref.id, name: 'a'}], readRef: id => store.pathOf(id)});
  const bad = mut => { const c = structuredClone(good); mut(c); return JSON.stringify(c); };
  assert.throws(() => parsePackage(bad(c => { c.references[0].data = Buffer.from('tampered-bytes-xx').toString('base64'); c.references[0].size = 17; })), e => e.code === 'INTEGRITY');
  assert.throws(() => parsePackage(bad(c => { c.references[0].refId = '../../evil.png'; })), /内容编号无效/);
  assert.throws(() => parsePackage(bad(c => { c.references[0].nodeId = '../x'; })), /槽位无效/);
  assert.throws(() => parsePackage(bad(c => { c.version = 9; })), e => e.code === 'UNSUPPORTED');
  assert.throws(() => parsePackage('{"kind":"other"}'), /不是映作图包/);
  assert.throws(() => new ReferenceStore(path.join(os.tmpdir(), 'yz-gp-unused-' + crypto.randomBytes(4).toString('hex'))).importBuffer(Buffer.from('x'), ref.id), e => e.code === 'INTEGRITY');
});
