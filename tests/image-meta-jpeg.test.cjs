'use strict';
// R16/D13：分享 JPEG 必须遍历完整标记序列；扫描间元数据被移除；依赖 Exif 方向的文件拒绝无损剥离。使用 sharp 生成真实可解码夹具。
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {stripForShare, jpegSegments} = require('../desktop/core/image-meta.cjs');

const seg = (marker, payload) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]); };
const raw = () => sharp({create: {width: 64, height: 48, channels: 3, background: {r: 200, g: 30, b: 90}}});
// 在第 n 个 SOS 之前插入段
function insertBeforeSos(buf, n, extra) {
  const {segs} = jpegSegments(buf);
  const sos = segs.filter(s => s.marker === 0xda)[n];
  return Buffer.concat([buf.subarray(0, sos.start), extra, buf.subarray(sos.start)]);
}

test('R16：progressive（多 SOS）JPEG 扫描间的 COM/APP1 被移除，结果仍可解码且尺寸一致', async () => {
  const src = await raw().jpeg({progressive: true}).toBuffer();
  const sosCount = jpegSegments(src).segs.filter(s => s.marker === 0xda).length;
  assert.ok(sosCount > 1, `夹具应为多扫描，实际 ${sosCount}`);
  let dirty = insertBeforeSos(src, 1, seg(0xfe, Buffer.from('SECRET-COMMENT')));
  dirty = insertBeforeSos(dirty, 2, seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0SECRET-XMP')));
  assert.equal((await sharp(dirty).metadata()).width, 64);
  const {buffer, removed} = stripForShare(dirty);
  assert.ok(!buffer.includes('SECRET'), '扫描后的元数据不得原样保留');
  assert.ok(removed.includes('COM') && removed.some(r => r.includes('XMP')));
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 64); assert.equal(meta.height, 48);
  const a = await sharp(dirty).raw().toBuffer(), b = await sharp(buffer).raw().toBuffer();
  assert.ok(a.equals(b), '像素不得改变');
});

test('R16：baseline JPEG，EOI 后尾随数据被移除', async () => {
  const src = await raw().jpeg().toBuffer();
  const {buffer, removed} = stripForShare(Buffer.concat([src, Buffer.from('TRAILING-SECRET')]));
  assert.ok(!buffer.includes('TRAILING-SECRET')); assert.ok(removed.includes('trailing-data'));
  assert.equal((await sharp(buffer).metadata()).width, 64);
});

test('R16：Exif 方向非 1 → 拒绝分享副本；方向 1 → 允许', async () => {
  const rotated = await raw().jpeg().withMetadata({orientation: 6}).toBuffer();
  assert.throws(() => stripForShare(rotated), e => e.code === 'UNSUPPORTED' && /方向/.test(e.message));
  const upright = await raw().jpeg().withMetadata({orientation: 1}).toBuffer();
  const {buffer} = stripForShare(upright);
  assert.ok(!buffer.includes('Exif'));
});

test('R16：ICC 与 Adobe 色彩段保留', async () => {
  const src = await raw().jpeg().withIccProfile('srgb').toBuffer();
  const withAdobe = insertBeforeSos(src, 0, seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1')));
  const {buffer} = stripForShare(withAdobe);
  assert.ok(buffer.includes('ICC_PROFILE')); assert.ok(buffer.includes('Adobe'));
  assert.ok((await sharp(buffer).metadata()).hasProfile);
});

test('R16：截断 JPEG（缺 EOI）拒绝', async () => {
  const src = await raw().jpeg({progressive: true}).toBuffer();
  assert.throws(() => stripForShare(src.subarray(0, src.length - 40)), e => e.code === 'UNSUPPORTED');
});

test('R16：PNG RGBA 与 WebP 仍可分享且保留透明通道', async () => {
  const rgba = sharp({create: {width: 8, height: 8, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0.5}}});
  const png = stripForShare(await rgba.clone().png().toBuffer());
  assert.equal((await sharp(png.buffer).metadata()).hasAlpha, true);
  const webp = stripForShare(await rgba.clone().webp().toBuffer());
  assert.equal((await sharp(webp.buffer).metadata()).hasAlpha, true);
});
