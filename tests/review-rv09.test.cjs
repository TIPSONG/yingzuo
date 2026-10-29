'use strict';
// RV09：模板目录固定在数据目录；paths.templates 不生效、给出警告、不可通过选择器设置，界面显示实际位置。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ConfigRepository, validate, defaults} = require('../desktop/repositories/config-repo.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');

test('RV09：派生模板目录始终等于模板仓库使用的 layout.templates；旧配置的自定义目录被忽略并警告', t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-rv09-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const layout = ensureLayout(d);
  const file = path.join(d, 'config.json');
  const repo = new ConfigRepository(file, {platform: 'linux'}); repo.load();
  repo.config.paths.templates = path.join(d, 'elsewhere');
  assert.equal(repo.derived(layout).templates, layout.templates);
  const issues = validate(repo.config, {exists: () => true});
  const w = issues.find(i => i.field === 'paths.templates');
  assert.equal(w?.severity, 'warning'); assert.match(w.message, /固定保存在数据目录/);
  assert.equal(validate(defaults('linux'), {exists: () => true}).some(i => i.field === 'paths.templates'), false);
});
test('RV09：设置页不再提供模板目录输入/选择器，路径选择白名单不含 paths.templates', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../desktop/ui/shell.js'), 'utf8');
  assert.match(ui, /\['paths\.templates', '模板', 'fixed'/);
  const api = fs.readFileSync(path.join(__dirname, '../desktop/services/api.cjs'), 'utf8');
  assert.doesNotMatch(api.match(/const pickable = new Set\(\[[^\]]*\]/)[0], /paths\.templates/);
});
