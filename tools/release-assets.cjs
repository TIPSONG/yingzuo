'use strict';
// One manifest, one validated directory: CI archives this exact release payload.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const METADATA = ['artifacts.json', 'SHA256SUMS.txt', 'smoke-result.json', 'init-result.json'];

function artifactNames(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  const setup = `Yingzuo-Setup-${version}-x64.exe`;
  return [`Yingzuo-Portable-${version}-x64.exe`, setup, `${setup}.blockmap`];
}

function regularFile(dir, name) {
  if (!name || path.basename(name) !== name || /[\\/:]/.test(name) || name === '.' || name === '..') throw new Error(`Unsafe asset name: ${name}`);
  const file = path.join(dir, name);
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Asset is not a regular file: ${name}`);
  return {file, bytes: st.size};
}

function checksum(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function checkNames(actual, expected, description) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(n => !expected.includes(n))) {
    throw new Error(`${description} must contain exactly: ${expected.join(', ')}`);
  }
}

function writeManifest(dir, pkg) {
  const names = artifactNames(pkg.version);
  checkNames(fs.readdirSync(dir).filter(n => /\.(exe|blockmap)$/i.test(n)), names, 'Build outputs');
  const artifacts = names.map(file => {
    const item = regularFile(dir, file);
    if (!item.bytes) throw new Error(`Empty asset: ${file}`);
    return {file, bytes: item.bytes, sha256: checksum(item.file)};
  });
  const manifest = {
    name: pkg.build.productName, version: pkg.version, builtAt: new Date().toISOString(), platform: 'win32-x64',
    electron: pkg.devDependencies.electron, signed: false,
    note: '未进行代码签名。Windows SmartScreen 可能提示未知发布者。升级不会覆盖 userData；便携版数据在 exe 旁的 data/ 目录（需 portable.flag）。',
    artifacts,
  };
  fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), artifacts.map(a => `${a.sha256}  ${a.file}`).join('\n') + '\n');
  verifyBundle(dir);
  return manifest;
}

// Share the same rules between streamed disk validation and frozen upload bytes.
function verifyContents(source, {requireResults = false, exact = false, expectedVersion} = {}) {
  const manifest = JSON.parse(source.readText('artifacts.json'));
  if (manifest.platform !== 'win32-x64' || (expectedVersion && manifest.version !== expectedVersion)) throw new Error('Release version/platform mismatch');
  const names = artifactNames(manifest.version);
  if (!Array.isArray(manifest.artifacts)) throw new Error('Invalid artifacts manifest');
  checkNames(manifest.artifacts.map(a => a?.file), names, 'Manifest');
  const sums = new Map();
  const text = source.readText('SHA256SUMS.txt');
  for (const line of text.trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error('Invalid or duplicate checksum entry');
    sums.set(match[2], match[1]);
  }
  checkNames([...sums.keys()], names, 'Checksum list');
  for (const a of manifest.artifacts) {
    const actual = source.inspect(a.file);
    if (!Number.isSafeInteger(a.bytes) || a.bytes <= 0 || actual.bytes !== a.bytes) throw new Error(`Size mismatch: ${a.file}`);
    if (!/^[a-f0-9]{64}$/.test(a.sha256) || sums.get(a.file) !== a.sha256 || actual.sha256 !== a.sha256) throw new Error(`SHA256 mismatch: ${a.file}`);
  }
  if (requireResults) {
    const smoke = JSON.parse(source.readText('smoke-result.json'));
    const init = JSON.parse(source.readText('init-result.json'));
    if (smoke.ok !== true || init.ok !== true || !Array.isArray(smoke.checks) || smoke.checks.some(c => c.ok !== true)) throw new Error('Packaged self-test failed');
    if (smoke.checks.find(c => c.name === 'versions')?.detail?.app !== manifest.version) throw new Error('Self-test version mismatch');
    if (smoke.checks.find(c => c.name === 'sqlite')?.detail?.driver !== 'better-sqlite3') throw new Error('Packaged SQLite driver mismatch');
  }
  const files = [...names, ...(requireResults ? METADATA : METADATA.slice(0, 2))];
  if (exact) checkNames(source.list(), files, 'Release directory');
  return {version: manifest.version, files};
}

function verifyBundle(dir, options = {}) {
  return verifyContents({
    readText: name => fs.readFileSync(regularFile(dir, name).file, 'utf8'),
    inspect: name => {
      const item = regularFile(dir, name);
      return {bytes: item.bytes, sha256: checksum(item.file)};
    },
    list: () => fs.readdirSync(dir),
  }, options);
}

function verifyBundleBytes(files, options = {}) {
  const entries = new Map();
  if (!Array.isArray(files)) throw new Error('Invalid frozen bundle');
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !Buffer.isBuffer(file.data) || entries.has(file.name)) throw new Error('Invalid or duplicate frozen asset');
    entries.set(file.name, file.data);
  }
  function read(name) {
    if (!entries.has(name)) throw new Error(`Missing frozen asset: ${name}`);
    return entries.get(name);
  }
  return verifyContents({
    readText: name => read(name).toString('utf8'),
    inspect: name => {
      const data = read(name);
      return {bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex')};
    },
    list: () => [...entries.keys()],
  }, options);
}

function stageBundle(source, destination) {
  const result = verifyBundle(source, {requireResults: true});
  // A fresh directory prevents stale assets and partial previous runs from being published.
  fs.mkdirSync(destination);
  for (const name of result.files) fs.copyFileSync(path.join(source, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  return verifyBundle(destination, {requireResults: true, exact: true, expectedVersion: result.version});
}

if (require.main === module) {
  try {
    const [command, source, destination] = process.argv.slice(2);
    let result;
    if (command === 'stage' && source && destination) result = stageBundle(path.resolve(source), path.resolve(destination));
    else if (command === 'verify' && source && !destination) result = verifyBundle(path.resolve(source), {requireResults: true, exact: true});
    else throw new Error('Usage: node tools/release-assets.cjs stage <dist> <new-directory> | verify <release-directory>');
    console.log(`Verified release ${result.version}: ${result.files.length} files`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {artifactNames, writeManifest, verifyBundle, verifyBundleBytes, stageBundle};
