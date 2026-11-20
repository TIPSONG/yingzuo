'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Database} = require('../desktop/repositories/database.cjs');
const {createTaskService} = require('../desktop/services/task-service.cjs');

const infoA = {PrintLabel: {input: {required: {label: ['STRING']}}}};
const infoB = {PrintLabel: {input: {required: {caption: ['STRING']}}}};
const response = data => ({ok: true, text: async () => JSON.stringify(data)});
const offline = async () => { throw new Error('offline'); };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-object-info-'));
  const db = Database.open(path.join(root, 'data.db'));
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const layout = {root, 'task-snapshots': path.join(root, 'snapshots'), references: path.join(root, 'refs')};
  const comfy = {url: 'http://127.0.0.1:8188/', root: path.join(root, 'install-a')};
  const cacheFile = path.join(root, 'object-info-cache.json');
  const service = (fetchImpl, options = {}) => createTaskService({db, layout, configRepo: {config: {comfy}}, locks: {}, events: {emit() {}}, editor: {}, fetchImpl, ...options});
  return {comfy, cacheFile, service};
}

test('同环境离线重启可复用 live 定义，换安装目录或地址即失效（包括同步保存入口）', async t => {
  const {comfy, service} = fixture(t);
  const live = service(async () => response(infoA));
  await live.warmObjectInfo();
  const restarted = service(offline);
  assert.deepEqual(restarted.cachedObjectInfo(), infoA);
  assert.deepEqual(await restarted.warmObjectInfo(), infoA);
  const oldRoot = comfy.root;
  comfy.root = path.join(oldRoot, 'install-b');
  assert.equal(restarted.cachedObjectInfo(), null);
  assert.equal(await restarted.warmObjectInfo(), null);
  comfy.root = oldRoot;
  assert.deepEqual(restarted.cachedObjectInfo(), infoA);
  comfy.url = 'http://127.0.0.1:8199/';
  assert.equal(live.cachedObjectInfo(), null, '60 秒内的旧内存定义也不可复用');
  assert.equal(await restarted.warmObjectInfo(), null);
});

test('同端请求合并；旧请求晚返回时无法覆盖新端文件缓存或完成旧编译', async t => {
  const {comfy, cacheFile, service} = fixture(t);
  let releaseOld, requests = 0;
  const s = service(url => {
    requests++;
    return url.port === '8188' ? new Promise(resolve => { releaseOld = () => resolve(response(infoA)); }) : Promise.resolve(response(infoB));
  });
  const early = s.warmObjectInfo();
  assert.equal(s.warmObjectInfo(), early);
  comfy.url = 'http://127.0.0.1:8199/';
  assert.deepEqual(await s.warmObjectInfo(), infoB);
  releaseOld();
  await assert.rejects(early, {code: 'CONFLICT'});
  assert.equal(requests, 2);
  assert.deepEqual(s.cachedObjectInfo(), infoB);
  const disk = JSON.parse(fs.readFileSync(cacheFile));
  assert.deepEqual(disk.data, infoB);
  assert.equal(disk.environment.comfyUrl, 'http://127.0.0.1:8199');
});

test('旧版未绑定来源的节点定义需重新连接确认；原草稿凭据引用可保留，导出须确认字段', async t => {
  const {cacheFile, service} = fixture(t);
  fs.writeFileSync(cacheFile, JSON.stringify({data: infoA}));
  const placeholder = '__yz_credential__:node-secret:old-reference';
  const graph = {nodes: [{id: 1, type: 'PrintLabel', widgets_values: [placeholder]}]};
  const s = service(offline, {editor: {enqueue: fn => fn(), commands: {tabGraph: () => ({graph, tabId: 'tab'})}},
    credentials: {read: () => ({items: {}}), get: () => 'sample label', available: () => false}});
  assert.equal(s.cachedObjectInfo(), null);
  assert.equal(await s.warmObjectInfo(), null);
  assert.deepEqual(s.secrets.redactGraph(graph), graph);
  await assert.rejects(s.methods['tasks.exportPackage']('tab', {filePath: path.join(path.dirname(cacheFile), 'export.json')}), {code: 'INVALID_STATE'});
  const reconnected = service(async () => response(infoA));
  assert.deepEqual(await reconnected.warmObjectInfo(), infoA);
  assert.deepEqual(service(offline).cachedObjectInfo(), infoA);
});
