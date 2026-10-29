'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {compareVersions, checkAppRelease} = require('../desktop/services/update-check.cjs');

const release = (tag_name, prerelease = false) => ({tag_name, prerelease, draft: false, assets: []});
const fetchReleases = releases => async () => new Response(JSON.stringify(releases));

test('Alpha users are offered the stable release of the same version, including on the beta channel', async () => {
  const releases = [release('v0.1.0-rc.2', true), release('v0.1.0')];
  for (const channel of ['stable', 'beta']) {
    const result = await checkAppRelease({currentVersion: '0.1.0-alpha.1', channel, fetchImpl: fetchReleases(releases)});
    assert.equal(result.latest.version, 'v0.1.0');
    assert.equal(result.updateAvailable, true);
  }
});

test('version precedence respects prerelease identifiers and ignores build metadata', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
  assert.equal(compareVersions('v1.0.0+local.9', '1.0.0+ci.10'), 0);
  assert.equal(compareVersions('1.0.0-beta.9', '1.0.0-beta.10'), -1);
});

test('release selection uses the newest valid version rather than publication order or a non-version tag', async () => {
  const releases = [release('v0.1.1'), release('nightly', true), release('v0.3.0'), release('v0.4.0-beta.1', true)];
  const stable = await checkAppRelease({currentVersion: '0.2.0', fetchImpl: fetchReleases(releases)});
  assert.equal(stable.latest.version, 'v0.3.0');
  assert.equal(stable.updateAvailable, true);
  const beta = await checkAppRelease({currentVersion: '0.2.0', channel: 'beta', fetchImpl: fetchReleases(releases)});
  assert.equal(beta.latest.version, 'v0.4.0-beta.1');
});
