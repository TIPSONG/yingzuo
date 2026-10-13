'use strict';
// RV11/RV12：静态核对颜色 token 的对比度与选择器范围（Windows CI 无浏览器也能跑）；浏览器实测见 review-rv13-ui.test.cjs。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wb = fs.readFileSync(path.join(__dirname, '../desktop/workbench.css'), 'utf8');
const sh = fs.readFileSync(path.join(__dirname, '../desktop/ui/shell.css'), 'utf8');

const block = (css, selector) => { const i = css.indexOf(`${selector} {`); assert.ok(i >= 0, selector); return css.slice(i, css.indexOf('\n}', i)); };
const tokens = body => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const hex = v => { const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v); assert.ok(m, `不是十六进制颜色：${v}`); const n = parseInt(m[1], 16); return {r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1}; };
const over = (fg, bg) => ({r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1});
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const dark = tokens(block(wb, ':root')), light = {...dark, ...tokens(block(wb, '[data-theme="light"]'))};
const nasaBase = tokens(block(sh, '[data-skin="nasa-punk"]'));
const nasaDark = {...dark, ...nasaBase, ...tokens(block(sh, '[data-skin="nasa-punk"][data-theme="dark"],\n[data-skin="nasa-punk"]:not([data-theme="light"])'))};
const nasaLight = {...light, ...nasaBase, ...tokens(block(sh, '[data-skin="nasa-punk"][data-theme="light"]'))};
const resolve = (t, v) => { while (/^var\(--([\w-]+)\)$/.test(v)) v = t[/^var\(--([\w-]+)\)$/.exec(v)[1]]; return v; };
const ratio = (t, fg, bg, base) => contrast(over(hex(resolve(t, t[fg] ?? fg)), base ? over(hex(resolve(t, t[bg] ?? bg)), hex(resolve(t, t[base]))) : hex(resolve(t, t[bg] ?? bg))), base ? over(hex(resolve(t, t[bg] ?? bg)), hex(resolve(t, t[base]))) : hex(resolve(t, t[bg] ?? bg)));

test('RV11：浅色选中导航文字对比度 ≥ 4.5:1（选中底叠在侧栏上）', () => {
  assert.ok(ratio(light, 'nav-active-fg', 'nav-active', 'sidebar') >= 4.5, String(ratio(light, 'nav-active-fg', 'nav-active', 'sidebar')));
  assert.ok(ratio(dark, 'nav-active-fg', 'nav-active', 'sidebar') >= 4.5);
  assert.ok(ratio(nasaLight, 'nav-active-fg', 'nav-active', 'sidebar') >= 4.5);
  assert.ok(ratio(light, 'mode-active-fg', 'mode-active') >= 4.5, '模式按钮');
  assert.ok(ratio(light, 'ink', 'accent-fill') >= 4.5, '实色强调按钮');
  assert.ok(ratio(light, 'text', 'panel') >= 4.5, '主题卡');
});
test('RV11：浅色白字规则只作用于实色强调按钮，排除导航/模式按钮/主题卡；导航使用独立前景 token', () => {
  const rule = /\[data-theme="light"\] button\.primary,\n\[data-theme="light"\] button\.active([^{]*)\{/.exec(sh);
  assert.ok(rule, '规则存在'); for (const x of ['.nav', '.theme-option', '.mode-buttons']) assert.ok(rule[1].includes(x), `排除 ${x}`);
  assert.match(sh, /nav \.nav\.active \{[^}]*color: var\(--nav-active-fg\)/);
});
test('RV12：NASA 浅色——弹窗/任务/空状态/表单/主要文字对比度 ≥ 4.5:1，组件 token 成对存在', () => {
  for (const [fg, bg] of [['text', 'panel'], ['text', 'modal-bg'], ['text', 'empty-bg'], ['text', 'bg'], ['field-fg', 'input'], ['mode-active-fg', 'mode-active'], ['nasa-fg', 'nasa-surface'], ['nasa-fg', 'nasa-btn-bg'], ['nasa-accent-text', 'panel'], ['nasa-warn-text', 'panel'], ['nasa-bad-text', 'panel'], ['status-fg', 'status-bg'], ['label-fg', 'panel']]) {
    const r = ratio(nasaLight, fg, bg); assert.ok(r >= 4.5, `${fg} on ${bg} = ${r.toFixed(2)}`);
  }
  for (const [fg, bg] of [['text', 'modal-bg'], ['nasa-fg', 'nasa-btn-bg'], ['text', 'empty-bg']]) assert.ok(ratio(nasaDark, fg, bg) >= 4.5, `深色 ${fg}/${bg}`);
  const darkKeys = Object.keys(tokens(block(sh, '[data-skin="nasa-punk"][data-theme="dark"],\n[data-skin="nasa-punk"]:not([data-theme="light"])'))).filter(k => k.startsWith('nasa-'));
  const lightKeys = Object.keys(tokens(block(sh, '[data-skin="nasa-punk"][data-theme="light"]')));
  for (const k of darkKeys) assert.ok(lightKeys.includes(k), `浅色缺少 --${k}`);
  assert.ok(contrast(hex('#ffffff'), hex('#b84400')) >= 4.5, 'NASA 浅色主按钮');
});
test('RV12：NASA 组件、正文与背景渐变不再写死深色值，统一走 token', () => {
  const comp = /\[data-skin="nasa-punk"\] \.node-fields \{([^}]*)\}/.exec(sh)[1];
  assert.match(comp, /var\(--nasa-surface\)/);
  assert.match(block(sh, '[data-skin="nasa-punk"] body'), /var\(--nasa-body-grad\)/);
  assert.match(block(sh, '[data-skin="nasa-punk"] aside'), /var\(--nasa-aside-grad\)/);
  assert.match(block(sh, '[data-skin="nasa-punk"] .page-head'), /var\(--nasa-head-grad\)/);
  assert.doesNotMatch(/\[data-skin="nasa-punk"\] \.theme-option\.active small \{[^}]*\}/.exec(sh)[0], /#ffffff/);
});
