'use strict';
// A01–A08：作品索引、任务输出关联、输出前缀、缩略图/查看器、文件入口、原图/分享导出、收藏板。
// 使用真实临时目录、真实 SQLite 与 sharp 生成的真实图片；ComfyUI 输出以 history 结构替身表示（非真实 ComfyUI 验收）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const sharp = require('sharp');
const {Database} = require('../desktop/repositories/database.cjs');
const meta = require('../desktop/core/image-meta.cjs');
const {AssetIndex, resolveComfyOutput} = require('../desktop/services/asset-index.cjs');
const {applyOutputPrefix, prefixDir} = require('../desktop/services/output-prefix.cjs');
const {AssetFiles} = require('../desktop/services/asset-files.cjs');
const {FavoritesBoard, arrangeAlbum} = require('../desktop/services/favorites.cjs');
const {createAssetsMethods} = require('../desktop/services/assets-api.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yz-assets-'));
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 在 IEND 前插入 chunk（模拟 ComfyUI 写入的 prompt/workflow 文本块）。 */
function injectPng(buf, chunks) { const iend = buf.length - 12; return Buffer.concat([buf.subarray(0, iend), ...chunks, buf.subarray(iend)]); }
const PROMPT = {3: {class_type: 'KSampler', inputs: {seed: 123456789, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0]}}, 4: {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: 'sdxl.safetensors'}}, 6: {class_type: 'CLIPTextEncode', inputs: {text: '一只猫 secret-prompt'}}, 9: {class_type: 'SaveImage', inputs: {filename_prefix: 'ComfyUI', images: ['8', 0]}}};
async function comfyPng({alpha = true} = {}) {
  const raw = await sharp({create: {width: 64, height: 48, channels: alpha ? 4 : 3, background: {r: 200, g: 30, b: 90, alpha: 0.5}}}).withIccProfile('p3').png().toBuffer();
  const itxt = Buffer.concat([Buffer.from('workflow\0\0\0\0\0', 'latin1'), Buffer.from(JSON.stringify({nodes: [{id: 1, type: '中文节点'}]}), 'utf8')]);
  const exif = pngChunk('eXIf', Buffer.from('MM\0*private-gps', 'latin1'));
  return injectPng(raw, [pngChunk('tEXt', Buffer.from(`prompt\0${asciiJson(PROMPT)}`, 'latin1')), pngChunk('iTXt', itxt), pngChunk('tIME', Buffer.alloc(7)), exif]);
}
// ComfyUI 以 Python json.dumps（ensure_ascii）写 tEXt，非 ASCII 字符为 \uXXXX。
const asciiJson = v => JSON.stringify(v).replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const pixels = async buf => (await sharp(buf).raw().toBuffer({resolveWithObject: true}));

test('A07 PNG：chunk 过滤移除生成信息/EXIF，像素、透明度与 ICC 不变，字节非重编码', async () => {
  const src = await comfyPng();
  assert.ok(meta.pngText(src).prompt);
  const {buffer, removed, format} = meta.stripForShare(src);
  assert.equal(format, 'png');
  assert.deepEqual(removed.sort(), ['eXIf', 'iTXt', 'tEXt', 'tIME']);
  assert.deepEqual(meta.pngText(buffer), {});
  assert.ok(!buffer.includes(Buffer.from('secret-prompt')) && !buffer.includes(Buffer.from('private-gps')));
  const [a, b] = [await pixels(src), await pixels(buffer)];
  assert.equal(b.info.channels, 4); assert.ok(a.data.equals(b.data));
  assert.ok((await sharp(buffer).metadata()).icc, 'ICC 保留');
  const idat = c => Buffer.concat(meta.pngChunks(c).filter(x => x.type === 'IDAT').map(x => x.data));
  assert.ok(idat(src).equals(idat(buffer)), 'IDAT 原样保留');
});

test('A07 JPEG：移除 EXIF/XMP/COM，保留 JFIF/ICC 与扫描数据', async () => {
  const src = await sharp({create: {width: 40, height: 30, channels: 3, background: '#3366aa'}}).withIccProfile('srgb').withExif({IFD0: {ImageDescription: 'secret-prompt', Artist: 'Tenhi'}}).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">secret-xmp</x:xmpmeta>').jpeg().toBuffer();
  const withCom = Buffer.concat([src.subarray(0, 2), Buffer.from([0xff, 0xfe, 0x00, 0x10]), Buffer.from('comment-secret', 'latin1'), src.subarray(2)]);
  const {buffer, removed} = meta.stripForShare(withCom);
  assert.ok(removed.includes('COM') && removed.includes('APP1-Exif') && removed.includes('APP1-XMP'), removed.join());
  for (const s of ['secret-prompt', 'secret-xmp', 'comment-secret', 'Tenhi']) assert.ok(!buffer.includes(Buffer.from(s)), s);
  const m = await sharp(buffer).metadata();
  assert.ok(m.icc && !m.exif && !m.xmp);
  assert.ok((await pixels(src)).data.equals((await pixels(buffer)).data), '解码像素完全一致（未重编码）');
});

test('A07 WebP：移除 EXIF/XMP chunk 并清除 VP8X 标志，透明度/ICC 保留', async () => {
  const src = await sharp({create: {width: 33, height: 21, channels: 4, background: {r: 1, g: 200, b: 3, alpha: 0.3}}}).withIccProfile('p3').withExif({IFD0: {ImageDescription: 'secret-prompt'}}).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">secret-xmp</x:xmpmeta>').webp({lossless: true}).toBuffer();
  const {buffer, removed} = meta.stripForShare(src);
  assert.deepEqual(removed.sort(), ['EXIF', 'XMP']);
  assert.ok(!buffer.includes(Buffer.from('secret-prompt')) && !buffer.includes(Buffer.from('secret-xmp')));
  assert.equal(buffer[20] & 0x0c, 0);
  const m = await sharp(buffer).metadata();
  assert.ok(m.icc && m.hasAlpha && !m.exif && !m.xmp);
  assert.ok((await pixels(src)).data.equals((await pixels(buffer)).data));
});

test('A07 不支持/损坏格式明确拒绝，不伪称已清除', async () => {
  const gif = await sharp({create: {width: 4, height: 4, channels: 3, background: '#fff'}}).gif().toBuffer();
  assert.equal(meta.shareSupport('gif').supported, false);
  assert.throws(() => meta.stripForShare(gif), e => e.code === 'UNSUPPORTED');
  const png = await comfyPng();
  assert.throws(() => meta.stripForShare(png.subarray(0, png.length - 20)), e => e.code === 'UNSUPPORTED');
  const jpeg = await sharp({create: {width: 4, height: 4, channels: 3, background: '#fff'}}).jpeg().toBuffer();
  assert.throws(() => meta.stripForShare(jpeg.subarray(0, 30)), e => e.code === 'UNSUPPORTED');
});

test('A04 生成信息读取：ComfyUI PNG 有提示词/seed/参数/工作流；普通图标注缺失', async () => {
  const info = meta.readGenerationInfo(await comfyPng());
  assert.equal(info.source, 'comfyui'); assert.equal(info.seed, '123456789'); assert.equal(info.samplers[0].steps, 20);
  assert.ok(info.prompts[0].text.includes('一只猫')); assert.ok(info.hasWorkflow); assert.deepEqual(info.missing, []);
  const plain = meta.readGenerationInfo(await sharp({create: {width: 4, height: 4, channels: 3, background: '#fff'}}).png().toBuffer());
  assert.deepEqual(plain.missing, ['prompts', 'seed', 'parameters', 'workflow']);
});

async function setup() {
  const dir = tmp();
  const out = path.join(dir, 'ComfyUI', 'output'), data = path.join(dir, 'data');
  for (const d of [out, path.join(out, 'sub'), path.join(data, 'thumbnails'), path.join(data, 'favorites'), path.join(data, 'trash')]) fs.mkdirSync(d, {recursive: true});
  const db = Database.open(path.join(data, 'y.sqlite'));
  const index = new AssetIndex({db, roots: [{id: 'output', path: out}], thumbsDir: path.join(data, 'thumbnails'), batch: 2});
  return {dir, out, data, db, index};
}

test('A01 扫描：分页、增量、文件消失标记、不移动原图、批次让出事件循环', async t => {
  const {out, db, index} = await setup(); t.after(() => db.close());
  const png = await comfyPng();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(out, `img_${i}.png`), png);
  fs.writeFileSync(path.join(out, 'sub', 'x.png'), png);
  fs.writeFileSync(path.join(out, 'notes.txt'), 'x');
  let ticks = 0; const timer = setInterval(() => ticks++, 0);
  const s1 = await index.scan();
  clearInterval(timer);
  assert.equal(s1.seen, 6); assert.equal(s1.indexed, 6);
  const p1 = index.list({limit: 4});
  assert.equal(p1.total, 6); assert.equal(p1.items.length, 4); assert.equal(p1.nextOffset, 4);
  assert.equal(index.list({offset: 4, limit: 4}).items.length, 2);
  assert.ok(fs.existsSync(path.join(out, 'img_0.png')), '原图未移动');
  const s2 = await index.scan();
  assert.equal(s2.indexed, 0, '未变化文件不重复解析');
  fs.rmSync(path.join(out, 'img_1.png'));
  const s3 = await index.scan();
  assert.equal(s3.missing, 1);
  assert.equal(index.list().total, 5);
  assert.equal(index.list({includeMissing: true}).items.filter(i => i.missing).length, 1);
  assert.equal(index.list({query: 'sub'}).total, 1);
  assert.equal(index.list({query: '一只猫'}).total, 5, '可按提示词搜索');
  assert.equal(index.list({query: '100%_'}).total, 0, 'LIKE 通配符已转义');
  fs.writeFileSync(path.join(out, 'img_1.png'), png);
  await index.scan();
  assert.equal(index.list().total, 6, '文件恢复后取消缺失标记');
});

test('A02 任务输出：按 filename/subfolder/type 解析，拒绝穿越，未配置目录不猜', async t => {
  const {out, db, index} = await setup(); t.after(() => db.close());
  fs.writeFileSync(path.join(out, 'sub', 'ComfyUI_00001_.png'), await comfyPng());
  assert.equal(resolveComfyOutput({filename: '../evil.png', subfolder: '', type: 'output'}, {output: out}).status, 'rejected');
  assert.equal(resolveComfyOutput({filename: 'a.png', subfolder: '../..', type: 'output'}, {output: out}).status, 'rejected');
  assert.equal(resolveComfyOutput({filename: 'a.png', subfolder: '', type: 'temp'}, {output: out}).status, 'unresolved');
  db.run(`INSERT INTO tasks (id, kind, state, workflow_id, snapshot_ref, request_id, client_id, seq, created_at, updated_at) VALUES ('t1','draw','succeeded','wf','s','r1','c',1,'x','x')`);
  const res = index.linkTaskOutputs({id: 't1', outputs: [
    {kind: 'image', nodeId: '9', filename: 'ComfyUI_00001_.png', subfolder: 'sub', type: 'output'},
    {kind: 'image', nodeId: '9', filename: 'gone.png', subfolder: '', type: 'output'},
    {kind: 'image', nodeId: '10', filename: 'p.png', subfolder: '', type: 'temp'},
    {kind: 'text', nodeId: '11', text: 'hi'}]}, {outputRoots: {output: out}});
  assert.deepEqual(res.map(r => r.status), ['linked', 'missing', 'unresolved']);
  const detail = index.get(res[0].assetId);
  assert.equal(detail.task.id, 't1'); assert.equal(detail.taskOutput.nodeId, '9'); assert.equal(detail.generation.seed, '123456789');
  assert.equal(index.list({taskId: 't1'}).total, 1);
});

test('A04 缩略图缓存与查看器缺失标注', async t => {
  const {out, db, index} = await setup(); t.after(() => db.close());
  fs.writeFileSync(path.join(out, 'big.png'), await sharp({create: {width: 2000, height: 1000, channels: 3, background: '#123'}}).png().toBuffer());
  await index.scan();
  const [item] = index.recent();
  assert.equal(item.width, 2000);
  const th = await index.thumbnail(item.id, {size: 256});
  assert.equal(th.cached, false);
  const m = await sharp(th.path).metadata();
  assert.equal(m.width, 256); assert.equal(m.height, 128); assert.equal(m.format, 'webp');
  assert.equal((await index.thumbnail(item.id, {size: 256})).cached, true);
  const d = index.get(item.id);
  assert.deepEqual(d.missingFields, ['prompts', 'seed', 'parameters', 'workflow', 'task']);
  await assert.rejects(index.thumbnail('nope'), e => e.code === 'NOT_FOUND');
});

test('A03 输出前缀：只改登记保存节点，副本修改、幂等、未知节点记录', () => {
  const prompt = {...structuredClone(PROMPT), 12: {class_type: 'Image Save', inputs: {output_path: 'x'}}, 13: {class_type: 'SaveImage', inputs: {filename_prefix: ['20', 0]}}, 14: {class_type: 'PreviewImage', inputs: {}}};
  const now = new Date(2026, 9, 13, 10).getTime();
  const r = applyOutputPrefix(prompt, {mode: 'date-workflow', workflowId: 'wf_ab12cd34ef', workflowName: '人像:精修?', now});
  assert.equal(r.prompt[9].inputs.filename_prefix, '映作/2026-10-13/人像_精修__wfab12cd/ComfyUI');
  assert.equal(prompt[9].inputs.filename_prefix, 'ComfyUI', '原 prompt 不变');
  assert.deepEqual(r.untouched.map(u => u.nodeId).sort(), ['12', '13']);
  assert.equal(applyOutputPrefix(r.prompt, {mode: 'date-workflow', workflowId: 'wf_ab12cd34ef', workflowName: '人像:精修?', now}).changed.length, 0);
  assert.equal(prefixDir({mode: 'none'}), '');
  assert.equal(prefixDir({mode: 'workflow', workflowId: 'abc', workflowName: 'CON'}), '映作/未命名_abc');
  assert.throws(() => prefixDir({mode: 'bogus'}));
});

test('A05/A06/A07 文件入口与导出：根目录限制、不执行、重名不覆盖、分享副本', async t => {
  const {dir, out, db} = await setup(); t.after(() => db.close());
  const src = path.join(out, 'a.png'); fs.writeFileSync(src, await comfyPng());
  fs.writeFileSync(path.join(out, 'run.bat'), 'echo x');
  const dest = path.join(dir, 'export'); fs.mkdirSync(dest);
  const calls = [];
  const shell = {openPath: async p => { calls.push(['open', p]); return p.endsWith('fail.png') ? '没有关联程序' : ''; }, showItemInFolder: p => calls.push(['reveal', p])};
  const files = new AssetFiles({shell, allowedRoots: () => [out]});
  assert.deepEqual(await files.openFile(src), {opened: src});
  files.revealFile(src);
  await assert.rejects(files.openFile(path.join(out, 'run.bat')), e => e.code === 'FORBIDDEN');
  await assert.rejects(files.openFile('/etc/passwd'), e => e.code === 'PATH_OUTSIDE_ROOT');
  await assert.rejects(files.openFile(path.join(out, 'none.png')), e => e.code === 'NOT_FOUND' && e.message.includes('none.png'));
  fs.writeFileSync(path.join(out, 'fail.png'), 'x');
  await assert.rejects(files.openFile(path.join(out, 'fail.png')), e => e.message.includes('没有关联程序') && e.message.includes('fail.png'));
  assert.equal(calls.filter(c => c[1].endsWith('run.bat')).length, 0);
  const e1 = files.exportOriginal(src, dest), e2 = files.exportOriginal(src, dest);
  assert.equal(path.basename(e1.exported), 'a.png'); assert.equal(path.basename(e2.exported), 'a (2).png');
  assert.ok(fs.readFileSync(e1.exported).equals(fs.readFileSync(src)), '字节一致，生成信息保留');
  const sh = files.exportShare(src, dest);
  assert.equal(path.basename(sh.exported), 'a-分享.png');
  assert.deepEqual(meta.pngText(fs.readFileSync(sh.exported)), {});
  assert.ok(meta.pngText(fs.readFileSync(src)).prompt, '原图未被修改');
  const gif = path.join(out, 'g.gif'); fs.writeFileSync(gif, await sharp({create: {width: 4, height: 4, channels: 3, background: '#fff'}}).gif().toBuffer());
  assert.equal(files.shareSupportFor(gif).supported, false);
  assert.throws(() => files.exportShare(gif, dest), e => e.code === 'UNSUPPORTED');
  assert.equal(fs.readdirSync(dest).length, 3, '失败时不留下文件');
});

test('A08 收藏板：复制去重、保留来源、取消收藏不删原图、失效识别、自动排列', async t => {
  const {dir, out, data, db} = await setup(); t.after(() => db.close());
  const board = new FavoritesBoard({db, favoritesDir: path.join(data, 'favorites'), trashDir: path.join(data, 'trash'), now: () => '2026-10-13T08:00:00.000Z'});
  const a = path.join(out, 'a.png'), b = path.join(dir, 'ref.jpg');
  fs.writeFileSync(a, await comfyPng());
  fs.writeFileSync(b, await sharp({create: {width: 300, height: 100, channels: 3, background: '#000'}}).jpeg().toBuffer());
  const fa = await board.add(a), fa2 = await board.add(a), fb = await board.add(b);
  assert.equal(fa.duplicate, false); assert.equal(fa2.duplicate, true); assert.equal(fa2.id, fa.id);
  assert.ok(fa.storedPath.includes(path.join('favorites', '2026-10')));
  assert.equal(fb.width, 300); assert.equal(fb.sourcePath, b);
  fs.rmSync(b);
  const listed = board.list().items;
  assert.equal(listed.find(x => x.id === fb.id).sourceMissing, true);
  assert.equal(listed.find(x => x.id === fb.id).broken, false, '收藏副本仍可用');
  const r = board.remove(fa.id);
  assert.ok(fs.existsSync(a), '原始文件保留'); assert.ok(fs.existsSync(r.trashed)); assert.ok(!fs.existsSync(fa.storedPath));
  fs.rmSync(fb.storedPath);
  assert.equal(board.list().items[0].broken, true);
  const lay = arrangeAlbum([{id: 1, width: 300, height: 100}, {id: 2, width: 100, height: 100}, {id: 3}, {id: 4, width: 200, height: 400}], {width: 600, rowHeight: 150, gap: 0});
  assert.equal(lay.cells.length, 4);
  assert.ok(lay.cells.every(c => c.x + c.width <= 601));
});

test('assets.* API：方法齐全并能端到端运行', async t => {
  const {dir, out, data, db} = await setup(); t.after(() => db.close());
  fs.writeFileSync(path.join(out, 'a.png'), await comfyPng());
  const dest = path.join(dir, 'dest'); fs.mkdirSync(dest);
  const layout = {root: data, thumbnails: path.join(data, 'thumbnails'), favorites: path.join(data, 'favorites'), trash: path.join(data, 'trash'), logs: path.join(data, 'logs'), downloads: path.join(data, 'downloads'), backups: path.join(data, 'backups')};
  const electron = {shell: {openPath: async () => '', showItemInFolder: () => {}}, dialog: {showOpenDialog: async () => ({canceled: false, filePaths: [dest]})}};
  const configRepo = {derived: () => ({output: out, input: '', favorites: layout.favorites, downloads: layout.downloads, backups: layout.backups})};
  const m = createAssetsMethods({electron, layout, configRepo, db, getWindow: () => null});
  const scan = await m['assets.scan']();
  assert.equal(scan.seen, 1);
  const [item] = (await m['assets.list']({})).items;
  assert.ok((await m['assets.thumbnail'](item.id)).dataUrl.startsWith('data:image/webp;base64,'));
  assert.equal((await m['assets.get'](item.id)).generation.seed, '123456789');
  assert.equal(path.basename((await m['assets.exportOriginal'](item.id)).exported), 'a.png');
  assert.equal((await m['assets.exportShare'](item.id)).format, 'png');
  const fav = await m['assets.favorite'](item.id);
  assert.equal((await m['assets.favorites']()).items.length, 1);
  assert.equal((await m['assets.favoriteLayout']({width: 800})).cells.length, 1);
  await m['assets.unfavorite'](fav.id);
  assert.equal((await m['assets.previewPrefix'](PROMPT, {mode: 'date', now: 0})).changed.length, 1);
  await assert.rejects(m['assets.openLocation']('nope'), e => e.code === 'NOT_FOUND');
  m.dispose();
});
