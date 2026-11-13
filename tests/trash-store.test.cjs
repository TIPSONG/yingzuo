'use strict';
// R14：回收区登记、恢复、清理计划与保护（仅隔离临时目录）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {TrashStore} = require('../desktop/maintenance/trash-store.cjs');

function env(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-tr-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let clock = 1000; const trash = new TrashStore({trashDir: path.join(root, 'trash'), now: () => clock});
  const mk = (rel, bytes = 100) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), {recursive: true}); fs.writeFileSync(p, Buffer.alloc(bytes)); return p; };
  return {root, trash, mk, tick: ms => { clock += ms; }};
}

test('R14：移入登记、列表含真实大小、恢复到原位置；原位置冲突拒绝', t => {
  const {root, trash, mk} = env(t);
  mk('backups/b1/a.bin', 300); mk('backups/b1/b.bin', 200);
  const e = trash.move(path.join(root, 'backups/b1'), {kind: 'backup'});
  assert.equal(trash.list()[0].bytes, 500); assert.ok(!fs.existsSync(path.join(root, 'backups/b1')));
  trash.restore(e.id); assert.ok(fs.existsSync(path.join(root, 'backups/b1/a.bin'))); assert.equal(trash.list().length, 0);
  const e2 = trash.move(path.join(root, 'backups/b1')); mk('backups/b1/new.bin');
  assert.throws(() => trash.restore(e2.id), {code: 'CONFLICT'});
  assert.throws(() => trash.move(trash.dir), {code: 'INVALID_PATH'});
});

test('R14：清理计划按时间选择并跳过受保护条目；无确认不删除；执行时再次核对保护', t => {
  const {root, trash, mk, tick} = env(t);
  const old = trash.move(mk('x/old.bin', 1000), {kind: 'backup'}); tick(10_000);
  const inUse = trash.move(mk('x/inuse.bin', 50), {kind: 'backup'}); tick(10_000);
  trash.move(mk('x/new.bin', 10));
  const protect = e => e.id === inUse.id ? '在用备份/未完成恢复' : null;
  const plan = trash.planPurge({olderThanMs: 5_000, isProtected: protect});
  assert.deepEqual(plan.items.map(i => i.id), [old.id]); assert.equal(plan.bytes, 1000);
  assert.deepEqual(plan.skipped.map(s => s.id), [inUse.id]);
  assert.throws(() => trash.purge(plan), {code: 'CONFIRM_REQUIRED'});
  assert.ok(fs.existsSync(old.stored));
  const r = trash.purge(plan, {confirm: true, isProtected: e => e.id === old.id ? '刚被引用' : null});
  assert.deepEqual(r.purged, []); assert.ok(fs.existsSync(old.stored));
  assert.deepEqual(trash.purge(plan, {confirm: true}).purged, [old.id]); assert.ok(!fs.existsSync(old.stored));
  assert.equal(trash.purge(plan, {confirm: true}).skipped[0].reason, '已不在登记中（可能已清理）');
});

test('R14：登记路径越界或链接越出回收区拒绝删除；已消失文件仅注销', t => {
  const {root, trash, mk} = env(t);
  const outside = mk('precious/original.png');
  const e = trash.move(mk('y/a.bin'));
  const reg = JSON.parse(fs.readFileSync(trash.file, 'utf8')); reg.items[0].stored = outside; fs.writeFileSync(trash.file, JSON.stringify(reg));
  const p = trash.planPurge({});
  assert.equal(p.items.length, 0); assert.match(p.skipped[0].reason, /不在回收区/);
  assert.match(trash.purge({items: [{id: e.id}]}, {confirm: true}).skipped[0].reason, /不在回收区/);
  assert.ok(fs.existsSync(outside), '外部原图不得被删除');
  const g = trash.move(mk('z/gone.bin')); fs.rmSync(g.stored);
  assert.equal(trash.list().find(x => x.id === g.id).exists, false);
  assert.deepEqual(trash.purge(trash.planPurge({ids: [g.id]}), {confirm: true}).purged, [g.id]);
});
