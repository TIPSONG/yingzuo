'use strict';
// Publish only a complete, verified Windows bundle; never replace an existing asset or release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {verifyBundle, verifyBundleBytes} = require('./release-assets.cjs');
const REPOSITORY = 'TIPSONG/yingzuo';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const digest = data => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;

async function publishRelease({directory, tag, targetCommit, token, fetchImpl = fetch, publish = false}) {
  const verified = verifyBundle(directory, {requireResults: true, exact: true});
  if (tag !== `v${verified.version}`) throw new Error('Tag must match the verified bundle version');
  if (typeof targetCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(targetCommit)) throw new Error('Target commit must be a full 40-character SHA');
  if (typeof token !== 'string' || !token.trim()) throw new Error('GITHUB_TOKEN is required');
  if (typeof publish !== 'boolean') throw new Error('publish must be a boolean');
  targetCommit = targetCommit.toLowerCase();
  // Freeze the bytes before any network request, including metadata and self-test evidence.
  const files = verified.files.map(name => {
    const data = fs.readFileSync(path.join(directory, name));
    return {name, data, size: data.length, digest: digest(data)};
  });
  // Validate exactly what will be uploaded, including both self-test results and checksums.
  verifyBundleBytes(files, {requireResults: true, exact: true, expectedVersion: verified.version});

  const headers = {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
  async function request(url, {method = 'GET', body, binary = false, allow404 = false} = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(300000),
        headers: {...headers, ...(body === undefined ? {} : {'Content-Type': binary ? 'application/octet-stream' : 'application/json'})},
        ...(body === undefined ? {} : {body: binary ? body : JSON.stringify(body)}),
      });
    } catch { throw new Error(`GitHub ${method} request failed`); }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} failed: HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('Invalid GitHub JSON response'); }
  }
  async function list(endpoint) {
    const result = [];
    for (let page = 1; ; page++) {
      const items = await request(`${API}${endpoint}?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error('Invalid GitHub list response');
      result.push(...items);
      if (items.length < 100) return result;
    }
  }
  async function verifyTag() {
    const ref = await request(`${API}/git/ref/tags/${encodeURIComponent(tag)}`, {allow404: true});
    if (ref && (ref.object?.type !== 'commit' || ref.object?.sha?.toLowerCase() !== targetCommit)) {
      throw new Error('Tag already exists with a different target or is not a lightweight commit tag');
    }
  }
  function verifyRelease(release, draft = true) {
    if (release?.draft === false && draft) throw new Error('Release is already published; refusing to modify it');
    if (!Number.isSafeInteger(release?.id) || release.id <= 0 || release.tag_name !== tag || release.target_commitish?.toLowerCase() !== targetCommit || release.draft !== draft || release.prerelease !== true) {
      throw new Error('Release tag, target commit or draft/prerelease state does not match');
    }
  }
  function verifyAsset(asset, file) {
    if (asset?.name !== file.name || asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== file.digest) {
      throw new Error(`Remote asset verification failed: ${file.name}`);
    }
  }
  function verifyAssets(assets, exact) {
    const seen = new Set();
    for (const asset of assets) {
      const file = files.find(f => f.name === asset?.name);
      if (!file || seen.has(asset.name)) throw new Error('Remote assets contain an unexpected or duplicate file');
      verifyAsset(asset, file);
      seen.add(asset.name);
    }
    if (exact && seen.size !== files.length) throw new Error('Remote assets are incomplete');
    return seen;
  }

  await verifyTag();
  const matching = (await list('/releases')).filter(r => r.tag_name === tag);
  if (matching.length > 1) throw new Error('Multiple releases use the requested tag');
  let release = matching[0];
  if (release) verifyRelease(release);
  else {
    release = await request(`${API}/releases`, {method: 'POST', body: {
      tag_name: tag, target_commitish: targetCommit, name: `映作 ${verified.version} · Windows Alpha`,
      body: `Windows Alpha 预发布版。构建提交：${targetCommit}。\n\n包含安装版、便携版、blockmap、SHA256 清单和打包自检结果。自动自检不代表真机人工验收已完成。`,
      draft: true, prerelease: true, make_latest: 'false',
    }});
    verifyRelease(release);
  }
  const endpoint = `/releases/${release.id}`;
  const existing = verifyAssets(await list(`${endpoint}/assets`), false);
  for (const file of files) {
    if (existing.has(file.name)) continue;
    // Stop if another publisher has changed the draft since the previous request.
    verifyRelease(await request(`${API}${endpoint}`));
    const url = `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`;
    const asset = await request(url, {method: 'POST', body: file.data, binary: true});
    verifyAsset(asset, file);
  }
  // Re-read server state rather than trusting upload responses or stale release.assets.
  release = await request(`${API}${endpoint}`);
  verifyRelease(release);
  verifyAssets(await list(`${endpoint}/assets`), true);
  await verifyTag();
  if (publish) {
    release = await request(`${API}${endpoint}`, {method: 'PATCH', body: {draft: false, prerelease: true, make_latest: 'false'}});
    verifyRelease(release, false);
  }
  return {tag, targetCommit, draft: release.draft, prerelease: true, url: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`, files: files.map(f => f.name)};
}

if (require.main === module) {
  (async () => {
    const [directory, tag, targetCommit, option, ...extra] = process.argv.slice(2);
    if (!directory || !tag || !targetCommit || extra.length || (option !== undefined && option !== '--publish')) {
      throw new Error('Usage: GITHUB_TOKEN=<token> node tools/publish-release.cjs <release-directory> <tag> <commit-sha> [--publish]');
    }
    const result = await publishRelease({directory: path.resolve(directory), tag, targetCommit, token: process.env.GITHUB_TOKEN, publish: option === '--publish'});
    console.log(`${result.draft ? 'Draft verified' : 'Prerelease published'}: ${result.tag} (${result.files.length} assets)`);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = {publishRelease};
