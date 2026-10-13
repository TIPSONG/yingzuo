'use strict';
// 批次 1 底座单元测试：schema/状态机、锁、事件、路径、原子 JSON、迁移、配置、SQLite、日志、凭据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../shared/schema.cjs');
const {Mutex, SerialQueue, CancelToken, withTimeout} = require('../desktop/core/locks.cjs');
const {EventBus, createSequenceTracker} = require('../desktop/core/events.cjs');
const P = require('../desktop/core/paths.cjs');
const A = require('../desktop/core/fs-atomic.cjs');
const {Logger, redact, redactString} = require('../desktop/core/logger.cjs');
const {CredentialStore} = require('../desktop/core/credentials.cjs');
const {resolveDataRoot, ensureLayout, importLegacy} = require('../desktop/repositories/data-root.cjs');
const {ConfigRepository, validate, defaults} = require('../desktop/repositories/config-repo.cjs');
const {Database} = require('../desktop/repositories/database.cjs');
const Store = require('../desktop/workspace-store.cjs');
// Windows：数据库句柄在后注册的 after 钩子里关闭，删除失败时推迟到进程退出再删。
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-f-')); t.after(() => { try { fs.rmSync(d, {recursive: true, force: true}); } catch { process.once('exit', () => { try { fs.rmSync(d, {recursive: true, force: true}); } catch { /* 留给系统清理 */ } }); } }); return d; };
const graph = p => ({version: 0.4, nodes: [{id: 1, type: 'CLIPTextEncode', widgets_values: [p]}], links: [], extra: {}});

test('任务状态机：合法转移、终态不可变、unknown 不能自动回到 queued', () => {
  assert.ok(S.canTransition('draft', 'queued'));
  assert.ok(S.canTransition('submitting', 'unknown'));
  assert.ok(!S.canTransition('unknown', 'queued'), 'unknown 只能核对/取消/判失败，不能直接重排队重发');
  assert.ok(!S.canTransition('succeeded', 'running'));
  for (const s of S.TERMINAL_STATES) assert.deepEqual(S.TASK_TRANSITIONS[s], []);
  assert.throws(() => S.assertTransition('failed', 'queued'), /不能从 failed/);
  for (const s of S.TASK_STATES) assert.ok(Array.isArray(S.TASK_TRANSITIONS[s]), s);
});
test('schema 校验核心记录并拒绝多余字段与非法 IPC 命令', () => {
  const task = {id: 't1', kind: 'generate', state: 'queued', workflowId: 'w', snapshotRef: 'task-snapshots/t1.json', inputRevision: 3, requestId: 'r1', clientId: 'c', outputs: [], timestamps: {createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z'}};
  assert.deepEqual(S.check(S.schemas.Task, task), []);
  assert.ok(S.check(S.schemas.Task, {...task, state: 'done'}).length);
  assert.ok(S.check(S.schemas.Task, {...task, extra: 1}).some(e => e.includes('不是允许的字段')));
  const binding = {scopePath: ['sub-1'], nodeId: '5', nodeType: 'KSampler', fieldName: 'steps', widgetType: 'number', constraints: {min: 1, max: 150}};
  assert.deepEqual(S.check(S.schemas.ParameterBinding, binding), []);
  assert.ok(S.validateCommand({requestId: 'a1', method: 'services.status', args: []}));
  assert.throws(() => S.validateCommand({requestId: 'a1', method: 'fs.readFile', args: []}), /分组/);
  assert.throws(() => S.validateCommand({requestId: 'a1', method: 'services.status', args: 'x'}));
  assert.throws(() => S.validateCommand({requestId: '../x', method: 'services.status', args: []}));
});
test('Mutex：FIFO、超时、取消，释放后下一个获得', async () => {
  const m = new Mutex('GPU');
  const order = [];
  const r1 = await m.acquire({owner: 'a'});
  const p2 = m.acquire({owner: 'b'}).then(r => { order.push('b'); return r; });
  const p3 = m.acquire({owner: 'c'}).then(r => { order.push('c'); return r; });
  await assert.rejects(m.acquire({owner: 'd', timeoutMs: 20}), e => e.code === 'LOCKED');
  const token = new CancelToken();
  const p5 = m.acquire({owner: 'e', token}); token.cancel('用户取消');
  await assert.rejects(p5, e => e.code === 'CANCELLED');
  r1(); (await p2)(); (await p3)();
  assert.deepEqual(order, ['b', 'c']); assert.equal(m.locked, false);
  r1(); assert.equal(m.locked, false, '重复释放无副作用');
});
test('SerialQueue 串行且失败不阻塞后续；withTimeout 超时', async () => {
  const q = new SerialQueue(); const seen = [];
  const a = q.enqueue(async () => { await new Promise(r => setTimeout(r, 10)); seen.push(1); throw new Error('x'); });
  const b = q.enqueue(async () => { seen.push(2); return 2; });
  await assert.rejects(a); assert.equal(await b, 2); assert.deepEqual(seen, [1, 2]);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), e => e.code === 'TIMEOUT');
});
test('事件序号、间隙检测、订阅取消', () => {
  const bus = new EventBus({history: 3}); const got = [];
  const off = bus.subscribe(e => got.push(e.sequence));
  for (let i = 0; i < 5; i++) bus.emit('x', null, {i});
  off(); bus.emit('x');
  assert.deepEqual(got, [1, 2, 3, 4, 5]); assert.equal(bus.listenerCount, 0);
  assert.equal(bus.since(1), null, '缓冲丢失时要求重新同步');
  assert.deepEqual(bus.since(4).map(e => e.sequence), [5, 6]);
  const tr = createSequenceTracker(0);
  assert.equal(tr.accept({sequence: 1}), 'ok'); assert.equal(tr.accept({sequence: 3}), 'gap'); assert.equal(tr.accept({sequence: 1}), 'duplicate');
});
test('路径校验：穿越、保留名、尾随点、绝对路径、大小写、中文', () => {
  const root = 'C:\\Users\\a\\输出';
  assert.equal(P.resolveInside(root, '2026/猫.png', {platform: 'win32'}), 'C:\\Users\\a\\输出\\2026\\猫.png');
  for (const bad of ['../x', 'a/../../x', 'CON', 'nul.txt', 'com1.png', 'a./b', 'a /b', 'C:\\x', '\\\\srv\\share', '/etc/passwd', 'a:b', 'x\0y', ''])
    assert.throws(() => P.resolveInside(root, bad, {platform: 'win32'}), /路径|相对/, bad);
  assert.ok(P.isInside('C:\\Data', 'c:\\data\\X', 'win32'), 'Windows 不区分大小写');
  assert.ok(!P.isInside('/data', '/Data/x', 'linux'));
  assert.ok(!P.isInside('C:\\Data', 'C:\\Data2\\x', 'win32'), '前缀相同的兄弟目录不算在内');
  const reg = new P.RootRegistry('linux'); reg.register('output', '/srv/out', {writable: false});
  assert.throws(() => reg.resolve('output', 'a.png', {write: true}), /只读/);
  assert.equal(reg.locate('/srv/out/x/y.png').relative, 'x/y.png');
  assert.throws(() => reg.get('nope'), /未登记/);
});
test('符号链接逃逸被 realpath 检查拦截', t => {
  const d = tmp(t); const inside = path.join(d, 'root'); fs.mkdirSync(inside); fs.mkdirSync(path.join(d, 'secret'));
  fs.symlinkSync(path.join(d, 'secret'), path.join(inside, 'link'));
  assert.throws(() => P.resolveInside(inside, 'link', {realpath: true}), e => e.code === 'PATH_OUTSIDE_ROOT');
});
test('uniqueName 生成不覆盖的文件名', t => {
  const d = tmp(t); fs.writeFileSync(path.join(d, 'a.png'), ''); fs.writeFileSync(path.join(d, 'a (2).png'), '');
  assert.equal(P.uniqueName(d, 'a.png'), 'a (3).png');
});
test('带版本 JSON：迁移链、未来版本只读、损坏报告', t => {
  const d = tmp(t), f = path.join(d, 'c.json');
  A.writeJsonAtomic(f, {version: 1, a: 1});
  const r = A.readVersionedJson(f, {currentVersion: 3, migrations: {1: x => ({...x, version: 2, b: 2}), 2: x => ({...x, version: 3, c: 3})}});
  assert.deepEqual(r.data, {version: 3, a: 1, b: 2, c: 3}); assert.equal(r.from, 1);
  A.writeJsonAtomic(f, {version: 9});
  assert.throws(() => A.readVersionedJson(f, {currentVersion: 3}), e => e.code === 'UNSUPPORTED');
  fs.writeFileSync(f, '{bad');
  assert.throws(() => A.readVersionedJson(f, {currentVersion: 3}), e => e.code === 'CORRUPT_DATA');
  const q = A.quarantine(f); assert.equal(fs.readFileSync(q, 'utf8'), '{bad'); assert.ok(fs.existsSync(f), '隔离是复制，不删除原文件');
  A.writeJsonAtomic(f, {version: 1});
  assert.throws(() => A.readVersionedJson(f, {currentVersion: 2, migrations: {}}), e => e.code === 'MIGRATION_FAILED');
});
test('数据根：开发/安装/便携/覆盖', t => {
  const d = tmp(t);
  assert.equal(resolveDataRoot({isPackaged: false, devRoot: d, env: {}}).root, path.join(d, '.local', 'data'));
  assert.equal(resolveDataRoot({isPackaged: true, exePath: path.join(d, 'y.exe'), userData: path.join(d, 'ud'), env: {}}).mode, 'installed');
  fs.writeFileSync(path.join(d, 'portable.flag'), '');
  const portable = resolveDataRoot({isPackaged: true, exePath: path.join(d, 'y.exe'), userData: path.join(d, 'ud'), env: {}});
  assert.equal(portable.mode, 'portable'); assert.equal(portable.root, path.join(d, 'data'));
  assert.equal(resolveDataRoot({isPackaged: true, env: {YINGZUO_DATA_ROOT: d}}).mode, 'override');
});
test('旧 .local 导入：复制不删源、只导入一次、冲突先备份', t => {
  const d = tmp(t), legacy = path.join(d, '.local'), layout = ensureLayout(path.join(d, 'data'));
  fs.mkdirSync(path.join(legacy, 'closed-workflows'), {recursive: true});
  const ws = {version: 1, activeId: 'a', tabs: [{id: 'a', title: '文生图', mode: 'graph', graph: graph('旧草稿')}]};
  fs.writeFileSync(path.join(legacy, 'desktop-workspace.json'), JSON.stringify(ws));
  fs.writeFileSync(path.join(legacy, 'closed-workflows', 'x.json'), '{"nodes":[]}');
  // 目标已有工作区：必须先备份
  Store.writeWorkspace(layout.workspace, {version: 2, activeId: null, tabs: []});
  const r = importLegacy({legacyDir: legacy, layout, writeWorkspace: Store.writeWorkspace, readLegacyWorkspace: Store.readWorkspace, now: () => '2026-10-13T00:00:00.000Z'});
  assert.equal(r.status, 'imported'); assert.ok(r.marker.backup && fs.existsSync(path.join(r.marker.backup, 'workspace.json')));
  assert.equal(Store.readWorkspace(layout.workspace).tabs[0].graph.nodes[0].widgets_values[0], '旧草稿');
  assert.ok(fs.existsSync(path.join(legacy, 'desktop-workspace.json')), '源文件保留');
  assert.ok(fs.existsSync(path.join(layout['closed-workflows'], 'x.json')));
  assert.equal(importLegacy({legacyDir: legacy, layout, writeWorkspace: Store.writeWorkspace, readLegacyWorkspace: Store.readWorkspace}).status, 'already-imported');
});
test('旧数据导入失败时回滚并保留源文件', t => {
  const d = tmp(t), legacy = path.join(d, '.local'), layout = ensureLayout(path.join(d, 'data'));
  fs.mkdirSync(legacy, {recursive: true}); fs.writeFileSync(path.join(legacy, 'desktop-workspace.json'), '{broken');
  Store.writeWorkspace(layout.workspace, {version: 2, activeId: null, tabs: [{id: 'keep', title: 'k', mode: 'graph', graph: graph('k')}]});
  const before = fs.readFileSync(layout.workspace);
  assert.throws(() => importLegacy({legacyDir: legacy, layout, writeWorkspace: Store.writeWorkspace, readLegacyWorkspace: Store.readWorkspace}), e => e.code === 'MIGRATION_FAILED');
  assert.deepEqual(fs.readFileSync(layout.workspace), before);
  assert.equal(fs.readFileSync(path.join(legacy, 'desktop-workspace.json'), 'utf8'), '{broken');
  assert.ok(!fs.existsSync(path.join(layout.migrations, 'legacy-local-import.json')), '失败不写标记，可修复后重试');
});
test('工作区 v2：图保存在 drafts/，哈希校验，revision 随内容变化', t => {
  const d = tmp(t), file = path.join(d, 'workspace.json');
  const w = Store.emptyWorkspace(); const tab = Store.addTab(w, 't', graph('a')); w.activeId = tab.id;
  assert.equal(Store.setGraph(tab, graph('a')), false); assert.equal(tab.revision, 0);
  assert.equal(Store.setGraph(tab, graph('b')), true); assert.equal(tab.revision, 1);
  tab.viewport = {scale: 1.5, offset: [10, -4]}; tab.workflowPath = 'workflows/x.json'; tab.documentId = 'doc';
  Store.writeWorkspace(file, w);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.tabs[0].graph, undefined); assert.equal(disk.tabs[0].nativeIdentity.documentId, 'doc');
  const back = Store.readWorkspace(file);
  assert.deepEqual(back.tabs[0].viewport, {scale: 1.5, offset: [10, -4]}); assert.equal(back.tabs[0].revision, 1);
  fs.writeFileSync(path.join(d, 'drafts', `${tab.id}.json`), JSON.stringify(graph('tampered')));
  assert.throws(() => Store.readWorkspace(file), /校验不一致/);
});
test('配置：默认值、问题清单、补丁白名单、损坏文件隔离后以默认值启动', t => {
  const d = tmp(t), file = path.join(d, 'config.json');
  const legacy = path.join(d, 'config.local.json'); fs.writeFileSync(legacy, JSON.stringify({comfyRoot: path.join(d, 'Comfy'), comfyUrl: 'http://127.0.0.1:8190/'}));
  const repo = new ConfigRepository(file, {platform: 'linux', legacyFile: legacy});
  const snap = repo.load();
  assert.equal(snap.config.comfy.url, 'http://127.0.0.1:8190/'); assert.equal(snap.config.comfy.root, path.join(d, 'Comfy'));
  assert.ok(snap.issues.some(i => i.field === 'comfy.root' && i.severity === 'warning'));
  assert.throws(() => repo.update({comfy: {url: 'http://example.com:8188/'}}), /本机/);
  assert.throws(() => repo.update({evil: {x: 1}}), /未知配置项/);
  assert.throws(() => repo.update({comfy: {extraArgs: '--x'}}), /类型/);
  repo.update({comfy: {extraArgs: ['--lowvram']}, tray: {closeToTray: false}});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).comfy.extraArgs, ['--lowvram']);
  fs.writeFileSync(file, '{oops');
  const r2 = new ConfigRepository(file, {platform: 'linux'}).load();
  assert.match(r2.loadError, /JSON/); assert.equal(r2.config.comfy.url, 'http://127.0.0.1:8188/');
  assert.ok(fs.readdirSync(d).some(f => f.startsWith('config.json.invalid-')));
  assert.ok(validate({...defaults('linux'), gemma: {contextLength: 4096}}).some(i => i.field === 'gemma.contextLength'));
  assert.equal(defaults('linux').ui.theme, 'dark');
  assert.ok(validate({...defaults('linux'), ui: {startPage: 'home', theme: 'neon'}}).some(i => i.field === 'ui.theme'));
  const themeFile = path.join(d, 'config-theme.json');
  const themeRepo = new ConfigRepository(themeFile, {platform: 'linux'});
  themeRepo.load();
  assert.equal(themeRepo.update({ui: {theme: 'light'}}).config.ui.theme, 'light');
  assert.equal(JSON.parse(fs.readFileSync(themeFile, 'utf8')).ui.theme, 'light');
  assert.equal(themeRepo.update({ui: {theme: 'system'}}).config.ui.theme, 'system');
  assert.ok(!validate({...defaults('linux'), ui: {startPage: 'home', theme: 'system'}}).some(i => i.field === 'ui.theme'));
});
for (const driver of ['better-sqlite3', 'node:sqlite']) {
  test(`SQLite（${driver}）：迁移、事务回滚、嵌套保存点、一致性备份、未来版本拒绝`, t => {
    const d = tmp(t), file = path.join(d, 'y.sqlite');
    const db = Database.open(file, {driver});
    t.after(() => db.close());
    assert.equal(db.schemaVersion, 1);
    assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
    const row = (id) => ['INSERT INTO tasks(id,kind,state,workflow_id,snapshot_ref,request_id,client_id,seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, 'generate', 'queued', 'w', 's', 'req-' + id, 'c', 1, 'now', 'now'];
    assert.throws(() => db.transaction(() => { db.run(...row('a')); throw new Error('boom'); }));
    assert.equal(db.get('SELECT count(*) n FROM tasks').n, 0, '失败事务回滚');
    db.transaction(() => { db.run(...row('b')); try { db.transaction(() => { db.run(...row('c')); throw new Error('inner'); }); } catch { /* 内层回滚 */ } });
    assert.deepEqual(db.all('SELECT id FROM tasks').map(r => r.id), ['b']);
    const backup = db.backupTo(path.join(d, 'backup', 'y.sqlite'));
    const copy = Database.open(backup, {driver, readonly: true}); assert.equal(copy.get('SELECT count(*) n FROM tasks').n, 1); copy.close();
    assert.throws(() => db.backupTo(backup), e => e.code === 'CONFLICT');
    db.exec('PRAGMA user_version = 99');
    assert.throws(() => db.migrate(), e => e.code === 'UNSUPPORTED');
  });
}
test('SQLite 损坏文件以只读或明确错误打开，不覆盖原文件', t => {
  const d = tmp(t), file = path.join(d, 'bad.sqlite');
  fs.writeFileSync(file, Buffer.alloc(4096, 7));
  const before = fs.readFileSync(file);
  let db; try { db = Database.open(file); } catch (e) { assert.equal(e.code, 'CORRUPT_DATA'); }
  if (db) { assert.ok(db.corrupt); assert.throws(() => db.run('DELETE FROM tasks'), e => e.code === 'READ_ONLY'); db.close(); }
  assert.deepEqual(fs.readFileSync(file), before);
});
test('日志：脱敏令牌/签名/用户名，轮转保留数量，写失败不抛', t => {
  const d = tmp(t);
  assert.equal(redactString('Authorization: Bearer abc.def'), 'Authorization: Bearer [已脱敏]');
  assert.match(redactString('https://x/y?sig=SECRET&a=1'), /sig=\[已脱敏\]&a=1/);
  assert.match(redactString('C:\\Users\\admin\\x'), /\[用户\]/);
  assert.match(redactString('token hf_abcdefghijklmnop'), /hf_\[已脱敏\]/);
  assert.deepEqual(redact({apiKey: 'k', nested: {password: 'p', ok: 1}}), {apiKey: '[已脱敏]', nested: {password: '[已脱敏]', ok: 1}});
  const log = new Logger(d, {maxBytes: 200, keep: 2});
  for (let i = 0; i < 30; i++) log.info('line ' + i, {token: 'x'});
  const files = fs.readdirSync(d).sort();
  assert.ok(files.length <= 3, files.join());
  assert.ok(!fs.readFileSync(log.file, 'utf8').includes('"x"'));
  const blocked = new Logger(path.join(d, 'yingzuo.log', 'nested'));
  assert.doesNotThrow(() => blocked.info('x')); assert.ok(blocked.failures > 0);
});
test('凭据：系统加密不可用时拒绝保存，不降级明文；状态不泄露内容', t => {
  const d = tmp(t), file = path.join(d, 'cred.json');
  const none = new CredentialStore(file, {isEncryptionAvailable: () => false});
  assert.throws(() => none.set('huggingface', 'hf_secret'), e => e.code === 'CREDENTIAL_UNAVAILABLE');
  assert.ok(!fs.existsSync(file));
  const basic = new CredentialStore(file, {isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text'});
  assert.throws(() => basic.set('civitai', 'x'), e => e.code === 'CREDENTIAL_UNAVAILABLE');
  const fake = {isEncryptionAvailable: () => true, encryptString: s => Buffer.from([...s].reverse().join('')), decryptString: b => [...b.toString()].reverse().join('')};
  const ok = new CredentialStore(file, fake); ok.set('huggingface', 'hf_secret_value');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('hf_secret_value'));
  assert.equal(ok.get('huggingface'), 'hf_secret_value');
  assert.deepEqual(ok.status().configured, {huggingface: true, civitai: false});
  assert.throws(() => ok.set('github', 'x'), /未知/);
});
