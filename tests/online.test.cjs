'use strict';
// O01–O04、O07：来源解析、分页、错误、下载规划（使用假 fetch；真实 API 另做过一次手动联网检查，见进度说明）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {HuggingFaceProvider, CivitaiProvider, createProviders} = require('../desktop/services/online/providers.cjs');
const {planDownload} = require('../desktop/services/online/online-service.cjs');

const jsonRes = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json', ...headers}});
test('O02：HF 链接解析、按固定 revision 列出具体文件与 sha256、下载地址指向具体文件', async () => {
  const calls = [];
  const h = new HuggingFaceProvider({fetchImpl: async (u, o) => { calls.push({u: String(u), auth: o.headers.authorization}); return String(u).includes('/revision/') ? jsonRes({id: 'org/m', sha: 'abc123', cardData: {license: 'apache-2.0'}, siblings: [{rfilename: 'README.md', size: 10}, {rfilename: 'vae/qwen_vae.safetensors', size: 100, lfs: {sha256: 'ff', size: 100}}]}) : jsonRes([{id: 'org/m'}], 200, {link: '<https://huggingface.co/api/models?cursor=xyz>; rel="next"'}); }, token: () => 'hf_secret'});
  assert.deepEqual(h.parseLink('https://huggingface.co/org/m/blob/main/vae/a.safetensors'), {provider: 'huggingface', repo: 'org/m', revision: 'main', path: 'vae/a.safetensors'});
  assert.equal(h.parseLink('https://huggingface.co/datasets/x/y'), null);
  const s = await h.search('qwen'); assert.equal(s.nextCursor, 'https://huggingface.co/api/models?cursor=xyz');
  await assert.rejects(h.search('q', {cursor: 'https://evil.example/api'}), /分页地址无效/);
  const d = await h.detail('org/m');
  assert.equal(d.revision, 'abc123'); assert.equal(d.license, 'apache-2.0');
  const w = d.files.find(f => f.isWeight); assert.equal(w.role, 'vae'); assert.equal(w.sha256, 'ff');
  assert.equal((await h.resolveDownload({repo: 'org/m', revision: d.revision, path: w.path})).url, 'https://huggingface.co/org/m/resolve/abc123/vae/qwen_vae.safetensors');
  await assert.rejects(h.resolveDownload({repo: 'org/m', revision: 'main'}), /具体文件/);
  assert.equal(calls[0].auth, 'Bearer hf_secret');
  await assert.rejects(h.detail('../etc'), /仓库名无效/);
});
test('O03：Civitai 版本/文件/底模/触发词；授权错误说明；429 退避后成功', async () => {
  let n = 0;
  const c = new CivitaiProvider({sleep: async () => {}, fetchImpl: async u => { n++; if (String(u).includes('/models/9') && n === 1) return new Response('', {status: 429, headers: {'retry-after': '1'}}); if (String(u).includes('/models/403')) return new Response('', {status: 403}); return jsonRes({id: 9, name: 'Style', type: 'LORA', allowCommercialUse: 'None', creator: {username: 'u'}, modelVersions: [{id: 77, name: 'v1', baseModel: 'Qwen', trainedWords: ['zzstyle'], files: [{id: 1, name: 'style.safetensors', sizeKB: 1024, hashes: {SHA256: 'ABC'}, primary: true, metadata: {format: 'SafeTensor'}}]}]}); }});
  assert.deepEqual(c.parseLink('https://civitai.com/models/9/style?modelVersionId=77'), {provider: 'civitai', modelId: 9, versionId: 77});
  const d = await c.detail(9);
  const f = d.versions[0].files[0];
  assert.equal(d.versions[0].baseModel, 'Qwen'); assert.deepEqual(d.versions[0].trainedWords, ['zzstyle']); assert.equal(f.role, 'lora'); assert.equal(f.sha256, 'abc'); assert.equal(f.size, 1048576); assert.ok(f.sizeApprox);
  await assert.rejects(c.detail(403), /同意该模型的许可|凭据/);
  assert.equal((await c.resolveDownload({versionId: 77})).url, 'https://civitai.com/api/download/models/77');
});
test('O01：通用 url 来源只接受 https；未知来源拒绝', async () => {
  const p = createProviders({fetchImpl: async () => jsonRes({})});
  await assert.rejects(p.resolve({provider: 'url', url: 'http://x/a'}), /https/);
  await assert.rejects(p.resolve({provider: 'nope'}), /未知来源/);
  assert.equal(p.parseLink('https://example.com/x'), null);
});
test('O04：按用途选目录、重名与空间检查、非法文件名', t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-plan-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const models = path.join(d, 'models');
  const p = planDownload({file: {path: 'sub/qwen.gguf', size: 100, sha256: 'x'}, role: 'diffusion', models, freeBytes: 10 * 1024 ** 3});
  assert.equal(p.destination, path.join(models, 'diffusion_models', 'qwen.gguf')); assert.equal(p.canDownload, true);
  fs.mkdirSync(path.join(models, 'diffusion_models'), {recursive: true}); fs.writeFileSync(p.destination, Buffer.alloc(100));
  const again = planDownload({file: {path: 'qwen.gguf', size: 100}, role: 'diffusion', models, freeBytes: 10 * 1024 ** 3});
  assert.equal(again.conflict, 'same-size'); assert.equal(again.canDownload, false);
  assert.equal(planDownload({file: {path: 'big.gguf', size: 20 * 1024 ** 3}, role: 'vae', models, freeBytes: 10 * 1024 ** 3}).enoughSpace, false);
  assert.throws(() => planDownload({file: {path: 'CON'}, role: 'vae', models}), /保留名称/);
  assert.throws(() => planDownload({file: {path: 'x.bin'}, role: null, models}), /用途/);
});
