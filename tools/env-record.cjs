'use strict';
// F01：命令行生成开发环境记录（不含凭据）。用法：node tools/env-record.cjs [config.json] > record.json
const path = require('node:path');
const os = require('node:os');
const {ConfigRepository} = require('../desktop/repositories/config-repo.cjs');
const {ensureLayout} = require('../desktop/repositories/data-root.cjs');
const {collectEnvironmentRecord} = require('../desktop/services/environment-record.cjs');
const root = path.resolve(__dirname, '..');
const layout = ensureLayout(path.join(os.tmpdir(), 'yingzuo-env-record'));
const repo = new ConfigRepository(process.argv[2] ? path.resolve(process.argv[2]) : layout.config, {legacyFile: path.join(root, 'desktop', 'config.local.json')});
repo.load();
collectEnvironmentRecord({root, configRepo: repo, layout}).then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n'), e => { console.error(e.message); process.exit(1); });
