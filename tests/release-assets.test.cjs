'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {artifactNames, writeManifest, verifyBundle, stageBundle} = require('../tools/release-assets.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-release-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dist = path.join(root, 'dist'); fs.mkdirSync(dist);
  const pkg = {version: '0.1.0-alpha.1', build: {productName: '映作'}, devDependencies: {electron: '44.4.3'}};
  const names = artifactNames(pkg.version);
  for (const name of names) fs.writeFileSync(path.join(dist, name), `binary fixture: ${name}`);
  const manifest = writeManifest(dist, pkg);
  const smoke = {ok: true, checks: [
    {name: 'versions', ok: true, detail: {app: pkg.version}},
    {name: 'sqlite', ok: true, detail: {driver: 'better-sqlite3'}},
  ]};
  fs.writeFileSync(path.join(dist, 'smoke-result.json'), JSON.stringify(smoke));
  fs.writeFileSync(path.join(dist, 'init-result.json'), JSON.stringify({ok: true}));
  return {root, dist, pkg, names, manifest, smoke, output: path.join(root, 'release')};
}

test('release staging includes NSIS blockmap and verifies the exact payload', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dist, 'builder-debug.yml'), 'not a distributed asset');
  const result = stageBundle(f.dist, f.output);
  assert.equal(result.files.length, 7);
  assert.ok(result.files.includes(f.names[2]));
  assert.deepEqual(fs.readdirSync(f.output).sort(), result.files.sort());
  for (const name of result.files) assert.deepEqual(fs.readFileSync(path.join(f.output, name)), fs.readFileSync(path.join(f.dist, name)));
  assert.equal(verifyBundle(f.output, {requireResults: true, exact: true}).version, f.pkg.version);
});

test('the alpha.1 defect (listed but missing blockmap) blocks staging', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.dist, f.names[2]));
  assert.throws(() => stageBundle(f.dist, f.output), /ENOENT/);
  assert.equal(fs.existsSync(f.output), false);
});

test('build manifest requires both installers and their expected blockmap, and rejects stale versions', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.dist, f.names[0]));
  assert.throws(() => writeManifest(f.dist, f.pkg), /Build outputs/);
  fs.writeFileSync(path.join(f.dist, f.names[0]), 'portable');
  fs.writeFileSync(path.join(f.dist, 'Yingzuo-Setup-0.0.1-x64.exe'), 'stale');
  assert.throws(() => writeManifest(f.dist, f.pkg), /Build outputs/);
});

test('same-size tampering fails SHA256 and truncated files fail size validation', t => {
  const f = fixture(t), file = path.join(f.dist, f.names[0]);
  const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => stageBundle(f.dist, f.output), /SHA256 mismatch/);
  fs.writeFileSync(file, bytes.subarray(1));
  assert.throws(() => stageBundle(f.dist, f.output), /Size mismatch/);
});

test('checksum list must match the manifest exactly, without omissions or duplicates', t => {
  const f = fixture(t), file = path.join(f.dist, 'SHA256SUMS.txt');
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n');
  assert.throws(() => stageBundle(f.dist, f.output), /Checksum list/);
  fs.writeFileSync(file, [...lines, lines[0]].join('\n') + '\n');
  assert.throws(() => stageBundle(f.dist, f.output), /duplicate/);
});

test('manifest path injection, duplicate entries and invalid versions are rejected', t => {
  const f = fixture(t), file = path.join(f.dist, 'artifacts.json');
  f.manifest.artifacts[0].file = '../secret.exe'; fs.writeFileSync(file, JSON.stringify(f.manifest));
  assert.throws(() => stageBundle(f.dist, f.output), /Manifest/);
  f.manifest.artifacts[0] = f.manifest.artifacts[1]; fs.writeFileSync(file, JSON.stringify(f.manifest));
  assert.throws(() => stageBundle(f.dist, f.output), /Manifest/);
  assert.throws(() => artifactNames('../0.1.0'), /version/);
});

test('failed init, wrong smoke version and wrong native driver block publishing', t => {
  const f = fixture(t), smokePath = path.join(f.dist, 'smoke-result.json');
  fs.writeFileSync(path.join(f.dist, 'init-result.json'), JSON.stringify({ok: false}));
  assert.throws(() => stageBundle(f.dist, f.output), /self-test failed/);
  fs.writeFileSync(path.join(f.dist, 'init-result.json'), JSON.stringify({ok: true}));
  f.smoke.checks[0].detail.app = '0.0.0'; fs.writeFileSync(smokePath, JSON.stringify(f.smoke));
  assert.throws(() => stageBundle(f.dist, f.output), /version mismatch/);
  f.smoke.checks[0].detail.app = f.pkg.version; f.smoke.checks[1].detail.driver = 'node:sqlite'; fs.writeFileSync(smokePath, JSON.stringify(f.smoke));
  assert.throws(() => stageBundle(f.dist, f.output), /driver mismatch/);
});

test('a stale destination is never overwritten and unexpected publication files fail', t => {
  const f = fixture(t); stageBundle(f.dist, f.output);
  fs.writeFileSync(path.join(f.output, 'unexpected.exe'), 'stale');
  assert.throws(() => stageBundle(f.dist, f.output), /EEXIST/);
  assert.throws(() => verifyBundle(f.output, {requireResults: true, exact: true}), /Release directory/);
});

test('release metadata and self-test results must exist as files', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.dist, 'smoke-result.json'));
  fs.mkdirSync(path.join(f.dist, 'smoke-result.json'));
  assert.throws(() => stageBundle(f.dist, f.output), /not a regular file/);
});
