'use strict';
// U05/U08：只读更新检测（临时 git 仓库）、版本比较、校验和解析。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {inspectRepo, checkEnvironment, compareVersions, parseChecksums, checkAppRelease} = require('../desktop/services/update-check.cjs');

const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {stdio: 'pipe'}).toString().trim();
let hasGit = true; try { execFileSync('git', ['--version']); } catch { hasGit = false; }
test('U05：检测落后提交、本地改动阻止安全更新；非 git 目录如实说明', {skip: !hasGit}, async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-up-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const origin = path.join(d, 'origin'); fs.mkdirSync(origin); g(origin, 'init', '-q', '-b', 'master'); fs.writeFileSync(path.join(origin, 'a.py'), '1'); g(origin, 'add', '.'); g(origin, 'commit', '-qm', 'one');
  const root = path.join(d, 'ComfyUI'); execFileSync('git', ['clone', '-q', origin, root]);
  fs.writeFileSync(path.join(origin, 'a.py'), '2'); g(origin, 'commit', '-qam', 'two: 新功能');
  const r = await inspectRepo(root, {fetchRemote: true});
  assert.equal(r.updateAvailable, true); assert.equal(r.behind[0].subject, 'two: 新功能'); assert.equal(r.canUpdateSafely, true);
  fs.writeFileSync(path.join(root, 'a.py'), 'gemma patch');
  const dirty = await inspectRepo(root);
  assert.equal(dirty.dirty, true); assert.equal(dirty.canUpdateSafely, false); assert.match(dirty.blockers[0], /本地改动/);
  assert.equal(g(root, 'rev-parse', 'HEAD'), dirty.head, '检测不修改仓库');
  fs.mkdirSync(path.join(root, 'custom_nodes', 'plain'), {recursive: true});
  const env = await checkEnvironment({comfyRoot: root, customNodesDir: path.join(root, 'custom_nodes')});
  assert.equal(env.plugins[0].git, false); assert.match(env.plugins[0].note, /不是 git/);
});
test('U08：版本比较、校验和、发行来源不可访问时给手动流程', async () => {
  assert.equal(compareVersions('0.9.0', 'v0.10.0'), -1); assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.deepEqual(parseChecksums('aa'.repeat(32) + '  映作-Setup.exe\n' + 'bb'.repeat(32) + ' *portable.zip\nbad line'), {'映作-Setup.exe': 'aa'.repeat(32), 'portable.zip': 'bb'.repeat(32)});
  const r = await checkAppRelease({currentVersion: '0.1.0', fetchImpl: async () => new Response('', {status: 404})});
  assert.equal(r.latest, null); assert.match(r.note, /手动升级/);
  const ok = await checkAppRelease({currentVersion: '0.1.0', fetchImpl: async () => new Response(JSON.stringify([{tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [{name: 'SHA256SUMS.txt', size: 1, browser_download_url: 'https://x'}]}]))});
  assert.equal(ok.updateAvailable, true); assert.equal(ok.latest.hasChecksums, true); assert.equal(ok.signed, false);
});

test('U05：频率判断与渠道（beta 含预发布）', async () => {
  const {dueForCheck, checkAppRelease} = require('../desktop/services/update-check.cjs');
  const now = Date.parse('2026-10-13T00:00:00Z');
  assert.equal(dueForCheck('manual', null, now), false);
  assert.equal(dueForCheck('daily', null, now), true);
  assert.equal(dueForCheck('daily', '2026-10-12T12:00:00Z', now), false);
  assert.equal(dueForCheck('weekly', '2026-10-05T00:00:00Z', now), true);
  const rel = [{tag_name: 'v0.3.0-beta.1', prerelease: true, draft: false, assets: [], published_at: 'x'}, {tag_name: 'v0.2.0', prerelease: false, draft: false, assets: [], published_at: 'x'}];
  const fetchImpl = async () => new Response(JSON.stringify(rel), {status: 200});
  assert.equal((await checkAppRelease({currentVersion: '0.2.0', channel: 'stable', fetchImpl})).latest.version, 'v0.2.0');
  const b = await checkAppRelease({currentVersion: '0.2.0', channel: 'beta', fetchImpl});
  assert.equal(b.latest.version, 'v0.3.0-beta.1'); assert.equal(b.updateAvailable, true);
  await assert.rejects(checkAppRelease({currentVersion: '0', repo: '../x', fetchImpl}), /owner\/repo/);
});
