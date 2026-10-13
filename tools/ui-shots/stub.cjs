'use strict';
// RV15：截图与浏览器回归共用的 preload 替身。主题/皮肤只经由 settings.get 返回的配置驱动（与真实启动路径一致），
// 不直接改 dataset。返回一个在页面中执行的函数源码。
module.exports = function stubSource(fixtures, {theme = 'dark', skin = 'default', updateDelayMs = 0, failUpdate = false} = {}) {
  const fx = JSON.parse(JSON.stringify(fixtures));
  fx['settings.get'].config.ui = {theme, skin};
  return `(() => {
    const fx = ${JSON.stringify(fx)};
    const opts = ${JSON.stringify({updateDelayMs, failUpdate})};
    const calls = window.__yzCalls = [];
    const merge = (a, b) => { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) { a[k] ??= {}; merge(a[k], v); } else a[k] = v; } return a; };
    const handlers = {
      'settings.update': async patch => { await new Promise(r => setTimeout(r, opts.updateDelayMs)); if (opts.failUpdate) return {ok: false, error: {code: 'INTERNAL', message: '模拟保存失败'}}; merge(fx['settings.get'].config, patch); return {ok: true, data: {config: JSON.parse(JSON.stringify(fx['settings.get'].config)), issues: []}}; },
      'settings.pickPath': async key => { const [g, k] = key.split('.'); fx['settings.get'].config[g][k] = 'D:\\\\picked\\\\' + k; return {ok: true, data: {config: JSON.parse(JSON.stringify(fx['settings.get'].config)), issues: []}}; },
      'settings.setCredential': async n => { fx['settings.get'].credentials.configured[n] = true; return {ok: true, data: fx['settings.get'].credentials}; },
    };
    window.yingzuo = new Proxy({}, {get: (_, group) => {
      if (group === 'events') return {subscribe() {}};
      return new Proxy({}, {get: (_, method) => (...args) => {
        const key = group + '.' + String(method); calls.push([key, args]);
        if (handlers[key]) return handlers[key](...args);
        return Promise.resolve({ok: true, data: Object.hasOwn(fx, key) ? JSON.parse(JSON.stringify(fx[key])) : {}});
      }});
    }});
    window.yingzuoDesktop = {setOverlay() {}, getBounds: async () => ({}), openTemplate: async () => ({})};
  })();`;
};
