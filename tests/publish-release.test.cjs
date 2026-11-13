'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {artifactNames, writeManifest} = require('../tools/release-assets.cjs');
const {publishRelease} = require('../tools/publish-release.cjs');
const commit = 'a'.repeat(40);
const tag = 'v0.1.0-alpha.1';
const sha = data => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-publish-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const pkg = {version: '0.1.0-alpha.1', build: {productName: '映作'}, devDependencies: {electron: '44.4.3'}};
  for (const name of artifactNames(pkg.version)) fs.writeFileSync(path.join(directory, name), `binary fixture: ${name}`);
  writeManifest(directory, pkg);
  fs.writeFileSync(path.join(directory, 'smoke-result.json'), JSON.stringify({ok: true, checks: [
    {name: 'versions', ok: true, detail: {app: pkg.version}},
    {name: 'sqlite', ok: true, detail: {driver: 'better-sqlite3'}},
  ]}));
  fs.writeFileSync(path.join(directory, 'init-result.json'), JSON.stringify({ok: true}));
  const expected = fs.readdirSync(directory).map(name => {
    const data = fs.readFileSync(path.join(directory, name));
    return {name, size: data.length, digest: sha(data), state: 'uploaded'};
  });
  return {directory, expected};
}

function github({existing = false, tagRef = null, assets = [], mutateUpload, mutateFinalAssets, mutateFinalRelease, finalTagRef} = {}) {
  const calls = [];
  let tagReads = 0, assetReads = 0;
  let release = existing ? {id: 123, tag_name: tag, target_commitish: commit, draft: true, prerelease: true, ...existing} : null;
  const remote = assets.map(a => ({...a}));
  const response = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
  const fetchImpl = async (raw, options) => {
    const url = new URL(raw), method = options.method;
    calls.push({url, method, body: options.body});
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    if (url.hostname === 'api.github.com' && url.pathname.endsWith(`/git/ref/tags/${tag}`)) {
      const ref = ++tagReads > 1 && finalTagRef !== undefined ? finalTagRef : tagRef;
      return ref ? response(ref) : response({message: 'Not found'}, 404);
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases') && method === 'GET') return response(release ? [release] : []);
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases') && method === 'POST') {
      release = {id: 123, ...JSON.parse(options.body)};
      assert.equal(release.draft, true); assert.equal(release.prerelease, true);
      return response(release, 201);
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/123/assets')) {
      assetReads++;
      return response(assetReads > 1 && mutateFinalAssets ? mutateFinalAssets(remote.map(a => ({...a}))) : remote);
    }
    if (url.hostname === 'uploads.github.com' && url.pathname === '/repos/TIPSONG/yingzuo/releases/123/assets' && method === 'POST') {
      const asset = {name: url.searchParams.get('name'), size: options.body.length, digest: sha(options.body), state: 'uploaded'};
      if (mutateUpload) mutateUpload(asset);
      remote.push(asset); return response(asset, 201);
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/123') && method === 'GET') return response(mutateFinalRelease ? mutateFinalRelease({...release}, {assetCount: remote.length}) : release);
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/123') && method === 'PATCH') {
      release = {...release, ...JSON.parse(options.body)}; return response(release);
    }
    throw new Error(`Unexpected mocked endpoint: ${method} ${url.pathname}`);
  };
  return {calls, fetchImpl, state: () => ({release, assets: remote})};
}
const options = (f, api, overrides = {}) => ({directory: f.directory, tag, targetCommit: commit, token: 'test-token', fetchImpl: api.fetchImpl, ...overrides});
const writes = api => api.calls.filter(c => c.method !== 'GET');
const publishes = api => api.calls.filter(c => c.method === 'PATCH');

test('missing blockmap prevents every network request', async t => {
  const f = fixture(t), api = github();
  fs.unlinkSync(path.join(f.directory, artifactNames('0.1.0-alpha.1')[2]));
  await assert.rejects(publishRelease(options(f, api, {publish: true})), /ENOENT/);
  assert.equal(api.calls.length, 0);
});

for (const name of ['SHA256SUMS.txt', 'smoke-result.json', 'init-result.json', 'artifacts.json']) {
  test(`a changed ${name} between disk validation and freezing blocks all network requests`, async t => {
    const f = fixture(t), api = github(), file = path.join(f.directory, name);
    const originalRead = fs.readFileSync;
    let reads = 0;
    const changed = name === 'SHA256SUMS.txt' ? `${'0'.repeat(64)}  unexpected.exe\n`
      : name === 'artifacts.json' ? JSON.stringify({...JSON.parse(originalRead(file, 'utf8')), artifacts: []})
        : JSON.stringify({ok: false});
    t.mock.method(fs, 'readFileSync', function(filename, ...args) {
      if (String(filename) === file && ++reads === 2) fs.writeFileSync(file, changed);
      return originalRead.call(this, filename, ...args);
    });
    await assert.rejects(publishRelease(options(f, api, {publish: true})), /Checksum list|self-test failed|Manifest/);
    assert.equal(reads, 2);
    assert.equal(api.calls.length, 0);
  });
}

test('disk changes after networking starts cannot change the verified upload bytes', async t => {
  const f = fixture(t), api = github();
  const originals = new Map(f.expected.map(({name}) => [name, fs.readFileSync(path.join(f.directory, name))]));
  let changed = false;
  const fetchImpl = async (...args) => {
    if (!changed) {
      changed = true;
      for (const {name} of f.expected) fs.writeFileSync(path.join(f.directory, name), 'changed after freezing');
    }
    return api.fetchImpl(...args);
  };
  const result = await publishRelease(options(f, api, {fetchImpl, publish: true}));
  assert.equal(result.draft, false);
  const uploads = api.calls.filter(c => c.url.hostname === 'uploads.github.com');
  assert.equal(uploads.length, originals.size);
  for (const call of uploads) assert.deepEqual(call.body, originals.get(call.url.searchParams.get('name')));
  assert.deepEqual(api.state().assets.map(a => a.digest).sort(), f.expected.map(a => a.digest).sort());
});

test('all seven assets, including blockmap, upload and verify; default remains draft', async t => {
  const f = fixture(t), api = github();
  const result = await publishRelease(options(f, api));
  assert.equal(result.draft, true); assert.equal(result.files.length, 7);
  assert.ok(result.files.some(name => name.endsWith('.blockmap')));
  assert.deepEqual(api.state().assets.map(a => a.name).sort(), f.expected.map(a => a.name).sort());
  assert.equal(publishes(api).length, 0);
});

test('explicit publish occurs only after re-reading all assets and matching the tag', async t => {
  const f = fixture(t), api = github({tagRef: {object: {type: 'commit', sha: commit}}});
  const result = await publishRelease(options(f, api, {publish: true}));
  assert.equal(result.draft, false); assert.equal(result.prerelease, true);
  assert.equal(api.calls.at(-1).method, 'PATCH');
  assert.equal(api.calls.at(-2).method, 'GET');
  assert.match(api.calls.at(-2).url.pathname, /git\/ref\/tags\//);
  assert.equal(publishes(api).length, 1);
});

for (const field of ['size', 'digest']) test(`wrong uploaded ${field} leaves a draft and never publishes`, async t => {
  const f = fixture(t), api = github({mutateUpload: asset => {asset[field] = field === 'size' ? asset.size + 1 : 'sha256:' + '0'.repeat(64);}});
  await assert.rejects(publishRelease(options(f, api, {publish: true})), /Remote asset verification failed/);
  assert.equal(api.state().release.draft, true); assert.equal(publishes(api).length, 0);
});

test('published release is never changed', async t => {
  const f = fixture(t), api = github({existing: {draft: false}});
  await assert.rejects(publishRelease(options(f, api, {publish: true})), /already published/);
  assert.equal(writes(api).length, 0);
});

test('a draft published by someone else during upload blocks all remaining uploads', async t => {
  const f = fixture(t), api = github({mutateFinalRelease: (release, {assetCount}) => assetCount ? {...release, draft: false} : release});
  await assert.rejects(publishRelease(options(f, api, {publish: true})), /already published/);
  assert.equal(api.calls.filter(c => c.url.hostname === 'uploads.github.com').length, 1);
  assert.equal(publishes(api).length, 0);
});

test('conflicting or annotated tags and a draft pointing elsewhere are never changed', async t => {
  const f = fixture(t);
  for (const object of [{type: 'commit', sha: 'b'.repeat(40)}, {type: 'tag', sha: commit}]) {
    const api = github({tagRef: {object}});
    await assert.rejects(publishRelease(options(f, api)), /Tag already exists/);
    assert.equal(writes(api).length, 0);
  }
  const api = github({existing: {target_commitish: 'b'.repeat(40)}});
  await assert.rejects(publishRelease(options(f, api)), /target commit/);
  assert.equal(writes(api).length, 0);
});

test('retry skips only already verified complete assets', async t => {
  const f = fixture(t), api = github({existing: true, assets: f.expected.slice(0, 2)});
  await publishRelease(options(f, api, {publish: true}));
  assert.equal(api.calls.filter(c => c.url.hostname === 'uploads.github.com').length, 5);
  assert.equal(api.calls.filter(c => c.method === 'POST' && c.url.hostname === 'api.github.com').length, 0);
  const bad = github({existing: true, assets: [{...f.expected[0], state: 'starter'}]});
  await assert.rejects(publishRelease(options(f, bad)), /Remote asset verification failed/);
  assert.equal(writes(bad).length, 0);
});

test('unexpected or duplicate remote assets block publishing', async t => {
  const f = fixture(t);
  for (const extra of [{...f.expected[0], name: 'unexpected.exe'}, f.expected[0]]) {
    const api = github({mutateFinalAssets: assets => [...assets, extra]});
    await assert.rejects(publishRelease(options(f, api, {publish: true})), /unexpected or duplicate/);
    assert.equal(publishes(api).length, 0);
  }
});

test('missing or modified final remote assets block publishing despite successful upload responses', async t => {
  const f = fixture(t);
  for (const mutateFinalAssets of [assets => assets.slice(1), assets => assets.map((a, i) => i ? a : {...a, digest: 'sha256:' + 'f'.repeat(64)})]) {
    const api = github({mutateFinalAssets});
    await assert.rejects(publishRelease(options(f, api, {publish: true})), /incomplete|verification failed/);
    assert.equal(publishes(api).length, 0);
  }
});

test('a tag or release target changed during upload prevents publication', async t => {
  const f = fixture(t);
  for (const behavior of [{finalTagRef: {object: {type: 'commit', sha: 'b'.repeat(40)}}}, {mutateFinalRelease: (r, {assetCount}) => assetCount ? {...r, target_commitish: 'b'.repeat(40)} : r}]) {
    const api = github(behavior);
    await assert.rejects(publishRelease(options(f, api, {publish: true})), /Tag already exists|target commit/);
    assert.equal(publishes(api).length, 0);
  }
});

test('invalid CLI inputs and missing credentials fail before network access', async t => {
  const f = fixture(t), api = github();
  for (const overrides of [{tag: 'v0.2.0'}, {targetCommit: 'main'}, {token: ''}, {publish: 'yes'}]) await assert.rejects(publishRelease(options(f, api, overrides)));
  assert.equal(api.calls.length, 0);
});

test('network error text cannot echo credentials into the CLI error', async t => {
  const f = fixture(t), api = github();
  await assert.rejects(publishRelease(options(f, api, {fetchImpl: async () => {throw new Error('test-token');}})), error => !error.message.includes('test-token') && /request failed/.test(error.message));
});
